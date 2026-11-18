import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AlgorithmVersionSchema,
  HighlightWindowCandidateSchema,
  type CacheRenderSettings,
  type CacheableSourceId,
  type HighlightDetectionSample,
  type HighlightWindowCandidate,
  type RollingBufferConfig,
} from '@autoedit/contracts';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import { assertAcquisitionPermitted } from '../canonical-source.js';
import { MediaSourceError } from '../errors.js';
import { CpuFirstHeuristicDetector } from '../highlight-detector.js';
import {
  SharedIngestionCoordinator,
  buildClipWorkId,
  buildSourceWorkId,
  type IngestionCoordinationRecord,
  type IngestionRequestAction,
} from '../ingestion-coordinator.js';
import {
  SharedArtifactCacheService,
  createTrustedCacheAuthContext,
  resolveAuthorizedCacheIdentity,
  type CacheArtifactDescriptor,
  type TrustedCacheAuthContext,
} from '../shared-cache.js';
import {
  ControlledRealTimeStreamAdapter,
  type EmittedStreamSegment,
} from './controlled-stream.adapter.js';
import { FfmpegRollingSegmentBuffer } from './rolling-segment-buffer.js';
import { IncrementalAudioSignalTracker } from './audio-signal-extractor.js';
import {
  extractAndVerifyHighlightClip,
  type ProbedClipMetadata,
} from './highlight-clip-extractor.js';
import type { PersistedClipManifest } from './shared-live-pipeline.js';

export interface PublishedLiveHighlight {
  candidate: HighlightWindowCandidate;
  cacheKey: string;
  objectKey: string;
  descriptor: CacheArtifactDescriptor;
  clipMeta: ProbedClipMetadata;
  downloadUrl: string;
  fencingToken: number;
  detectedAtMs: number;
  readyAtMs: number;
  detectionToReadyMs: number;
  segmentsEmittedAtDetection: number;
  segmentsEmittedAtClipReady: number;
  streamActiveAtDetection: boolean;
  streamActiveAtClipReady: boolean;
  reusedFromCache: boolean;
}

export interface PersistedLiveHighlightEntry {
  candidate: HighlightWindowCandidate;
  cacheKey: string;
  objectKey: string;
  etag?: string;
  descriptor: CacheArtifactDescriptor;
  clipMeta: ProbedClipMetadata;
  fencingToken: number;
  detectedAtMs: number;
  readyAtMs: number;
  detectionToReadyMs: number;
  segmentsEmittedAtDetection: number;
  segmentsEmittedAtClipReady: number;
  streamActiveAtDetection: boolean;
  streamActiveAtClipReady: boolean;
}

export interface PersistedLiveSessionManifest {
  version: 1;
  fencingToken: number;
  canonicalSourceId: string;
  sourceRevision: string;
  algorithmVersion: string;
  streamStatus: 'LIVE' | 'ENDED' | 'FAILED';
  lastValidSegmentIndex: number;
  segmentsReceived: number;
  highlights: PersistedLiveHighlightEntry[];
  updatedAtMs: number;
}

export interface ContinuousLiveMetricsReport {
  firstSegmentArrivedAtMs: number | null;
  firstDetectionAtMs: number | null;
  firstSegmentToFirstDetectionMs: number | null;
  firstClipReadyAtMs: number | null;
  firstDetectionToClipReadyMs: number | null;
  streamStartedAtMs: number;
  streamEndedAtMs: number;
  segmentsReceived: number;
  validSegmentsReceived: number;
  corruptSegmentsSkipped: number;
  gapsDetected: number;
  lateSegmentsReceived: number;
  segmentsAnalyzedCount: number;
  segmentIngestionRatePerSec: number;
  detectedCandidatesCount: number;
  finalizedClipsCount: number;
  clipsReadyWhileStreamActive: number;
  ingestionContinuedDuringClipRender: boolean;
  peakDiskBytes: number;
  peakHeapUsedBytes: number;
  evictedSegmentsCount: number;
  backpressureWaits: number;
  heartbeatRenewals: number;
}

export interface ContinuousBroadcastRequest {
  adapter: ControlledRealTimeStreamAdapter;
  requesterUserId: string;
  workerId: string;
  sourceRevision?: string;
  algorithmVersion?: string;
  bufferConfig?: Partial<RollingBufferConfig>;
  renderSettings?: CacheRenderSettings;
  scoreThreshold?: number;
  cooldownSec?: number;
  aggregationWindowSec?: number;
  /** Maximum buffer disk bytes for retained rolling segments; defaults to 64 MiB. */
  maxDiskBytes?: number;
  /** Maximum concurrent background FFmpeg clip extractions; defaults to 2. */
  maxConcurrentClipExtractions?: number;
  /** Optional synthetic chat/keyword signals injected per stream timestamp (test-only). */
  syntheticSignals?: HighlightDetectionSample[];
  /** Lease duration in ms; defaults to 15_000 (continuously renewed via heartbeat). */
  leaseMs?: number;
  maxRetries?: number;
  /** Waiter timeout in ms; defaults to 60_000. */
  waitTimeoutMs?: number;
  pollInitialMs?: number;
  pollMaxMs?: number;
  /**
   * 'stream_end' (default): waiters return once stream finishes with all highlights.
   * 'first_highlight': waiters return as soon as the first highlight clip is ready while stream stays LIVE.
   */
  waitMode?: 'stream_end' | 'first_highlight';
  /** Optional AbortSignal to cancel waiting or gracefully stop active ingestion. */
  signal?: AbortSignal;
  /** Invoked on the owner as soon as each highlight clip is extracted, verified, and cached in MinIO. */
  onHighlightReady?: (clip: PublishedLiveHighlight) => Promise<void> | void;
  /** Invoked on the owner when each raw segment arrives (useful for measuring incremental progress). */
  onSegmentArrived?: (info: {
    index: number;
    valid: boolean;
    emittedCount: number;
    latestBufferedSec: number;
    activeClipExtractions: number;
  }) => Promise<void> | void;
  /** Optional test hook invoked on owner right before finalizing a clip (for stale/crash tests). */
  onBeforeClipPublish?: (ctx: {
    clipWorkId: CacheableSourceId;
    fencingToken: number;
    candidate: HighlightWindowCandidate;
  }) => Promise<void>;
}

export interface ContinuousBroadcastResult {
  canonicalSourceId: string;
  sessionWorkId: CacheableSourceId;
  coordinationAction: IngestionRequestAction;
  wasSessionOwner: boolean;
  streamStatus: 'LIVE' | 'ENDED';
  fencingToken: number;
  highlights: PublishedLiveHighlight[];
  metrics: ContinuousLiveMetricsReport | null;
  processingMs: number;
}

export interface ContinuousServiceCounters {
  sessionOwnersStarted: number;
  segmentsIngested: number;
  segmentsAnalyzed: number;
  ffmpegClipExtractions: number;
  cachedHighlightHits: number;
  sessionRecoveries: number;
  heartbeatRenewals: number;
}

const DEFAULT_LIVE_CLIP_RENDER: CacheRenderSettings = {
  format: 'reel',
  width: 1280,
  height: 720,
  fps: 30,
  subtitles: false,
  zooms: false,
  transitions: 'none',
  music: false,
};

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new MediaSourceError({
        code: 'REQUEST_CANCELLED',
        message: 'Continuous livestream request cancelled.',
      }),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: 'Continuous livestream request cancelled.',
        }),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function stableShortHash(value: unknown, len = 12): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, len);
}

function computeFilterForRender(renderSettings: CacheRenderSettings): string | undefined {
  const needsScale = renderSettings.width !== 1280 || renderSettings.height !== 720;
  const needsFps = renderSettings.fps !== 30;
  if (!needsScale && !needsFps && !renderSettings.zooms && !renderSettings.subtitles) {
    return undefined;
  }
  const filters: string[] = [];
  if (needsScale) {
    filters.push(`scale=${renderSettings.width}:${renderSettings.height}`);
  } else if (renderSettings.zooms) {
    filters.push(`crop=iw*0.95:ih*0.95,scale=${renderSettings.width}:${renderSettings.height}`);
  }
  if (needsFps) {
    filters.push(`fps=${renderSettings.fps}`);
  }
  if (filters.length === 0 && renderSettings.subtitles) {
    filters.push(`scale=${renderSettings.width}:${renderSettings.height}`);
  }
  return filters.length > 0 ? filters.join(',') : undefined;
}

interface PendingHighlightCandidate {
  candidate: HighlightWindowCandidate;
  windowStartSec: number;
  windowEndSec: number;
  detectedAtMs: number;
  segmentsEmittedAtDetection: number;
  streamActiveAtDetection: boolean;
  status: 'pending_post_event' | 'finalizing' | 'ready' | 'failed';
  pinLeaseId: string;
}

/**
 * Continuous shared livestream ingestion and real-time highlight generator.
 *
 * Reuses:
 * - SharedIngestionCoordinator (Redis Lua atomic leases + monotonic fencing)
 * - FfmpegRollingSegmentBuffer (incremental segment append, pinning, eviction, readiness API)
 * - IncrementalAudioSignalTracker + CpuFirstHeuristicDetector (1 analysis pass per new segment)
 * - extractAndVerifyHighlightClip (real FFmpeg + ffprobe clip generation)
 * - SharedArtifactCacheService + TrustedCacheAuthContext (private MinIO + fail-closed auth)
 *
 * Key behavior:
 * - Receives real H.264/AAC segments incrementally over time.
 * - Detects highlights, pins pre-event + post-event footage, extracts & verifies MP4 clips,
 *   and publishes them to MinIO WHILE the livestream continues ingesting new segments.
 * - Coordinates across multiple independent service instances so 1,000 clippers share ONE
 *   stream ingestion owner and reuse cached highlights without restarting FFmpeg.
 */
export class ContinuousLiveSessionService {
  readonly cache: SharedArtifactCacheService;
  readonly counters: ContinuousServiceCounters = {
    sessionOwnersStarted: 0,
    segmentsIngested: 0,
    segmentsAnalyzed: 0,
    ffmpegClipExtractions: 0,
    cachedHighlightHits: 0,
    sessionRecoveries: 0,
    heartbeatRenewals: 0,
  };

  /** In-flight-only coalescers (cleared in finally; never grant ownership or cache stale data). */
  private readonly pollCoalescer = new Map<string, Promise<IngestionCoordinationRecord | null>>();
  private readonly sessionManifestCoalescer = new Map<
    string,
    Promise<{ cacheKey: string; manifestKey: string; data: PersistedLiveSessionManifest } | null>
  >();

  constructor(
    private readonly coordinator: SharedIngestionCoordinator,
    private readonly storage: MediaStorageProvider,
    private readonly workRootDir: string,
  ) {
    this.cache = new SharedArtifactCacheService(storage);
  }

  private buildAuth(
    adapter: ControlledRealTimeStreamAdapter,
    requesterUserId: string,
  ): TrustedCacheAuthContext {
    const source = adapter.buildVerifiedBroadcastSource();
    assertAcquisitionPermitted(source);
    return createTrustedCacheAuthContext({
      source,
      requesterUserId,
      allowSharedCacheReuse: adapter.policy.allowSharedCacheReuse,
    });
  }

  private async getStateCoalesced(
    workId: CacheableSourceId,
  ): Promise<IngestionCoordinationRecord | null> {
    const existing = this.pollCoalescer.get(workId);
    if (existing) return existing;
    const p = this.coordinator.getState(workId).finally(() => {
      this.pollCoalescer.delete(workId);
    });
    this.pollCoalescer.set(workId, p);
    return p;
  }

  private async getSessionManifestCoalesced(
    auth: TrustedCacheAuthContext,
    sessionDescriptor: CacheArtifactDescriptor,
  ): Promise<{ cacheKey: string; manifestKey: string; data: PersistedLiveSessionManifest } | null> {
    const id = resolveAuthorizedCacheIdentity(auth, sessionDescriptor);
    const existing = this.sessionManifestCoalescer.get(id.cacheKey);
    if (existing) return existing;
    const p = this.cache
      .getCachedManifest<PersistedLiveSessionManifest>(auth, sessionDescriptor)
      .finally(() => {
        this.sessionManifestCoalescer.delete(id.cacheKey);
      });
    this.sessionManifestCoalescer.set(id.cacheKey, p);
    return p;
  }

  private async verifyAndHydrateHighlights(
    auth: TrustedCacheAuthContext,
    entries: PersistedLiveHighlightEntry[],
    opts?: { verifyObjectExists?: boolean; expiresIn?: number },
  ): Promise<PublishedLiveHighlight[]> {
    const verified: PublishedLiveHighlight[] = [];
    for (const entry of entries) {
      if (opts?.verifyObjectExists !== false) {
        const head = await this.cache.checkObjectAtKey(auth, entry.descriptor, entry.objectKey);
        if (!head.hit || head.sizeBytes !== entry.clipMeta.sizeBytes) {
          continue;
        }
        if (entry.etag && head.etag && entry.etag !== head.etag) {
          continue;
        }
      }
      const downloadUrl = await this.cache.createAuthorizedDownloadUrlForObject(
        auth,
        entry.descriptor,
        entry.objectKey,
        { expiresIn: opts?.expiresIn ?? 900 },
      );
      verified.push({
        candidate: entry.candidate,
        cacheKey: entry.cacheKey,
        objectKey: entry.objectKey,
        descriptor: entry.descriptor,
        clipMeta: entry.clipMeta,
        downloadUrl,
        fencingToken: entry.fencingToken,
        detectedAtMs: entry.detectedAtMs,
        readyAtMs: entry.readyAtMs,
        detectionToReadyMs: entry.detectionToReadyMs,
        segmentsEmittedAtDetection: entry.segmentsEmittedAtDetection,
        segmentsEmittedAtClipReady: entry.segmentsEmittedAtClipReady,
        streamActiveAtDetection: entry.streamActiveAtDetection,
        streamActiveAtClipReady: entry.streamActiveAtClipReady,
        reusedFromCache: true,
      });
    }
    return verified;
  }

  /**
   * Joins an ongoing continuous livestream ingestion or starts it if this worker wins
   * the atomic Redis lease.
   *
   * - Fail-closed authorization runs BEFORE touching Redis or MinIO.
   * - Strictly ONE owner across all service instances ingests the live broadcast.
   * - Attached clippers (ATTACH_EXISTING) and late joiners (REUSE_READY) never restart FFmpeg.
   */
  async joinOrStartContinuousBroadcast(
    req: ContinuousBroadcastRequest,
  ): Promise<ContinuousBroadcastResult> {
    const startedAt = Date.now();

    // 0. Fail-closed rights & authorization check BEFORE Redis or MinIO
    const auth = this.buildAuth(req.adapter, req.requesterUserId);
    const source = auth.source;
    const sourceRevision = req.sourceRevision ?? 'v1';
    const algorithmVersion = req.algorithmVersion ?? 'v1.0-heuristic';
    const renderSettings: CacheRenderSettings = {
      ...DEFAULT_LIVE_CLIP_RENDER,
      ...(req.renderSettings ?? {}),
    };
    const segDur = req.adapter.streamOptions.segmentDurationSec;
    const preEventSec = req.bufferConfig?.preEventSec ?? 4;
    const postEventSec = req.bufferConfig?.postEventSec ?? 4;
    const maxRetentionSec = req.bufferConfig?.maxRetentionSec ?? 60;
    const scoreThreshold = req.scoreThreshold ?? 65;
    const cooldownSec = req.cooldownSec ?? 12;
    const aggregationWindowSec = req.aggregationWindowSec ?? 3;
    const leaseMs = req.leaseMs ?? 15_000;
    const maxRetries = req.maxRetries ?? 3;
    const waitTimeoutMs = req.waitTimeoutMs ?? 60_000;
    const pollInitialMs = req.pollInitialMs ?? 40;
    const pollMaxMs = req.pollMaxMs ?? 200;
    const waitMode = req.waitMode ?? 'stream_end';

    const renderHash = stableShortHash(renderSettings, 8);
    const synthHash = req.syntheticSignals?.length ? stableShortHash(req.syntheticSignals, 8) : 'none';
    const sessionAlgoTag = `${algorithmVersion}-live-t${scoreThreshold}-c${cooldownSec}-p${preEventSec}-${postEventSec}-s${segDur}-${renderHash}-${synthHash}`;

    const sessionDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'SOURCE_MEDIA',
      sourceRevision,
      algorithmVersion: sessionAlgoTag,
      rightsScope: 'SHARED_PERMITTED',
    };
    // Enforce SHARED_PERMITTED scope right away before touching Redis
    resolveAuthorizedCacheIdentity(auth, sessionDescriptor);

    const sessionWorkId = buildSourceWorkId(
      source.canonicalId,
      `${sourceRevision}_live_s${segDur}_${renderHash}`,
    );

    const deadlineMs = Date.now() + waitTimeoutMs;

    while (true) {
      if (req.signal?.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Continuous broadcast request cancelled for ${source.canonicalId}.`,
        });
      }
      if (Date.now() > deadlineMs) {
        throw new MediaSourceError({
          code: 'COORDINATION_TIMEOUT',
          message: `Timed out waiting for continuous broadcast ${sessionWorkId}.`,
          retryable: true,
        });
      }

      const coord = await this.coordinator.requestIngestion({
        canonicalSourceId: sessionWorkId,
        requesterId: req.requesterUserId,
        workerId: req.workerId,
        leaseMs,
        maxRetries,
      });

      // CASE 1: REUSE_READY -> Late-joining clipper reuses already-verified highlights with 0 FFmpeg!
      if (coord.action === 'REUSE_READY') {
        const loaded = await this.getSessionManifestCoalesced(auth, sessionDescriptor);
        if (loaded?.data && loaded.data.streamStatus === 'ENDED') {
          const highlights = await this.verifyAndHydrateHighlights(auth, loaded.data.highlights, {
            verifyObjectExists: true,
          });
          if (highlights.length === loaded.data.highlights.length) {
            this.counters.cachedHighlightHits += highlights.length;
            return {
              canonicalSourceId: source.canonicalId,
              sessionWorkId,
              coordinationAction: 'REUSE_READY',
              wasSessionOwner: false,
              streamStatus: 'ENDED',
              fencingToken: coord.fencingToken,
              highlights,
              metrics: null,
              processingMs: Date.now() - startedAt,
            };
          }
        }
        // Session manifest or clip missing -> conditional atomic invalidation
        const inv = await this.coordinator.invalidateReadyArtifact({
          canonicalSourceId: sessionWorkId,
          expectedArtifactRef: coord.record.artifactRef ?? '',
          expectedFencingToken: coord.fencingToken,
          repairWorkerId: req.workerId,
          leaseMs,
          maxRetries,
        });
        if (inv.action === 'ACQUIRED_REPAIR') {
          this.counters.sessionRecoveries++;
          return await this.runContinuousOwner({
            req,
            auth,
            sessionWorkId,
            sessionDescriptor,
            sourceRevision,
            algorithmVersion,
            renderSettings,
            preEventSec,
            postEventSec,
            maxRetentionSec,
            scoreThreshold,
            cooldownSec,
            aggregationWindowSec,
            leaseMs,
            maxRetries,
            fencingToken: inv.fencingToken,
            action: 'ACQUIRED_RECOVERY',
            startedAt,
          });
        }
        await sleepAbortable(pollInitialMs, req.signal);
        continue;
      }

      // CASE 2: ATTACH_EXISTING -> Wait on active remote/local owner; NEVER spawn duplicate ingestion!
      if (coord.action === 'ATTACH_EXISTING') {
        let delayMs = pollInitialMs;
        let observedToken = coord.fencingToken;

        while (true) {
          if (req.signal?.aborted) {
            throw new MediaSourceError({
              code: 'REQUEST_CANCELLED',
              message: `Cancelled while attached to continuous stream ${sessionWorkId}.`,
            });
          }
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 0) {
            throw new MediaSourceError({
              code: 'COORDINATION_TIMEOUT',
              message: `Timed out waiting on continuous stream ${sessionWorkId}.`,
              retryable: true,
            });
          }

          // If caller wants the first highlight while stream is STILL LIVE, inspect session manifest!
          if (waitMode === 'first_highlight') {
            const liveManifest = await this.getSessionManifestCoalesced(auth, sessionDescriptor);
            if (liveManifest?.data && liveManifest.data.highlights.length > 0) {
              const highlights = await this.verifyAndHydrateHighlights(
                auth,
                liveManifest.data.highlights,
                { verifyObjectExists: true },
              );
              if (highlights.length > 0) {
                this.counters.cachedHighlightHits += highlights.length;
                return {
                  canonicalSourceId: source.canonicalId,
                  sessionWorkId,
                  coordinationAction: 'ATTACH_EXISTING',
                  wasSessionOwner: false,
                  streamStatus: liveManifest.data.streamStatus === 'ENDED' ? 'ENDED' : 'LIVE',
                  fencingToken: liveManifest.data.fencingToken,
                  highlights,
                  metrics: null,
                  processingMs: Date.now() - startedAt,
                };
              }
            }
          }

          await sleepAbortable(Math.min(delayMs, remainingMs), req.signal);
          delayMs = Math.min(pollMaxMs, Math.ceil(delayMs * 1.5));

          const rec = await this.getStateCoalesced(sessionWorkId);
          if (!rec) {
            break; // Redis key evicted -> re-coordinate
          }
          if (rec.state === 'READY') {
            const loaded = await this.getSessionManifestCoalesced(auth, sessionDescriptor);
            if (loaded?.data && loaded.data.streamStatus === 'ENDED') {
              const highlights = await this.verifyAndHydrateHighlights(
                auth,
                loaded.data.highlights,
                { verifyObjectExists: false },
              );
              this.counters.cachedHighlightHits += highlights.length;
              return {
                canonicalSourceId: source.canonicalId,
                sessionWorkId,
                coordinationAction: 'ATTACH_EXISTING',
                wasSessionOwner: false,
                streamStatus: 'ENDED',
                fencingToken: rec.fencingToken,
                highlights,
                metrics: null,
                processingMs: Date.now() - startedAt,
              };
            }
            break;
          }
          if (
            rec.state === 'FAILED' ||
            rec.state === 'EXPIRED' ||
            rec.leaseExpiresAtMs <= Date.now()
          ) {
            // Owner failed or lease expired -> break to outer loop so ONE worker recovers
            break;
          }
          if (rec.fencingToken !== observedToken) {
            observedToken = rec.fencingToken;
          }
        }
        continue;
      }

      // CASE 3: FAILED_MAX_RETRIES
      if (coord.action === 'FAILED_MAX_RETRIES') {
        throw new MediaSourceError({
          code: 'MAX_RETRIES_EXCEEDED',
          message: `Continuous broadcast ${sessionWorkId} exhausted maxRetries (${coord.record.maxRetries}): ${coord.record.lastError ?? 'unknown'}`,
        });
      }

      // CASE 4: ACQUIRED_NEW or ACQUIRED_RECOVERY -> This worker owns continuous ingestion!
      if (coord.action === 'ACQUIRED_RECOVERY') {
        this.counters.sessionRecoveries++;
      }

      return await this.runContinuousOwner({
        req,
        auth,
        sessionWorkId,
        sessionDescriptor,
        sourceRevision,
        algorithmVersion,
        renderSettings,
        preEventSec,
        postEventSec,
        maxRetentionSec,
        scoreThreshold,
        cooldownSec,
        aggregationWindowSec,
        leaseMs,
        maxRetries,
        fencingToken: coord.fencingToken,
        action: coord.action,
        startedAt,
      });
    }
  }

  private async runContinuousOwner(params: {
    req: ContinuousBroadcastRequest;
    auth: TrustedCacheAuthContext;
    sessionWorkId: CacheableSourceId;
    sessionDescriptor: CacheArtifactDescriptor;
    sourceRevision: string;
    algorithmVersion: string;
    renderSettings: CacheRenderSettings;
    preEventSec: number;
    postEventSec: number;
    maxRetentionSec: number;
    scoreThreshold: number;
    cooldownSec: number;
    aggregationWindowSec: number;
    leaseMs: number;
    maxRetries: number;
    fencingToken: number;
    action: IngestionRequestAction;
    startedAt: number;
  }): Promise<ContinuousBroadcastResult> {
    const {
      req,
      auth,
      sessionWorkId,
      sessionDescriptor,
      sourceRevision,
      algorithmVersion,
      renderSettings,
      preEventSec,
      postEventSec,
      maxRetentionSec,
      scoreThreshold,
      cooldownSec,
      aggregationWindowSec,
      leaseMs,
      maxRetries,
      fencingToken,
      action,
      startedAt,
    } = params;

    const source = auth.source;
    const segDur = req.adapter.streamOptions.segmentDurationSec;
    const maxConcurrentClips = Math.max(1, req.maxConcurrentClipExtractions ?? 2);

    this.counters.sessionOwnersStarted++;

    const scratchDir = path.join(
      this.workRootDir,
      `live_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir: path.join(scratchDir, 'buffer'),
      bufferConfig: {
        segmentDurationSec: segDur,
        preEventSec,
        postEventSec,
        maxRetentionSec,
      },
      maxDiskBytes: req.maxDiskBytes ?? 64 * 1024 * 1024,
    });

    const ownerAbort = new AbortController();
    let leaseLostErr: Error | null = null;
    let heartbeatStopped = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let sessionHeartbeatRenewals = 0;

    const onCallerAbort = () => {
      ownerAbort.abort(
        new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Continuous owner cancelled for ${sessionWorkId}.`,
        }),
      );
    };
    if (req.signal) {
      if (req.signal.aborted) onCallerAbort();
      else req.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const heartbeatIntervalMs = Math.max(150, Math.floor(leaseMs / 3));
    const scheduleHeartbeat = () => {
      if (heartbeatStopped || ownerAbort.signal.aborted) return;
      heartbeatTimer = setTimeout(async () => {
        if (heartbeatStopped || ownerAbort.signal.aborted) return;
        try {
          await this.coordinator.renewLease({
            canonicalSourceId: sessionWorkId,
            workerId: req.workerId,
            fencingToken,
            leaseMs,
          });
          sessionHeartbeatRenewals++;
          this.counters.heartbeatRenewals++;
          scheduleHeartbeat();
        } catch (err) {
          leaseLostErr = err instanceof Error ? err : new Error(String(err));
          ownerAbort.abort(leaseLostErr);
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    };

    const stopHeartbeat = () => {
      heartbeatStopped = true;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      req.signal?.removeEventListener('abort', onCallerAbort);
    };

    // Start lease heartbeat IMMEDIATELY before any MinIO I/O so short leases cannot expire under load
    scheduleHeartbeat();

    // Track continuous streaming telemetry
    const streamStartedAtMs = Date.now();
    let firstSegmentArrivedAtMs: number | null = null;
    let firstDetectionAtMs: number | null = null;
    let firstClipReadyAtMs: number | null = null;
    let segmentsReceived = 0;
    let validSegmentsReceived = 0;
    let lastValidSegmentIndex = -1;
    let streamEnded = false;
    let ingestionContinuedDuringClipRender = false;
    let peakHeapUsedBytes = process.memoryUsage().heapUsed;
    let detectedCandidatesCount = 0;

    // Seed any already-published highlights from prior interrupted session (recovery deduplication!)
    const persistedHighlights: PersistedLiveHighlightEntry[] = [];
    const publishedHighlights: PublishedLiveHighlight[] = [];
    const publishedCacheKeys = new Set<string>();

    const priorSession = await this.cache.getCachedManifest<PersistedLiveSessionManifest>(
      auth,
      sessionDescriptor,
    );
    if (priorSession?.data && Array.isArray(priorSession.data.highlights)) {
      const priorValid = await this.verifyAndHydrateHighlights(auth, priorSession.data.highlights, {
        verifyObjectExists: true,
      });
      for (const h of priorValid) {
        if (publishedCacheKeys.has(h.cacheKey)) continue;
        publishedCacheKeys.add(h.cacheKey);
        publishedHighlights.push(h);
        const orig = priorSession.data.highlights.find((x) => x.cacheKey === h.cacheKey);
        if (orig) persistedHighlights.push(orig);
      }
    }

    const audioTracker = new IncrementalAudioSignalTracker({
      windowSec: 1.0,
      spikeRangeDb: 18,
      activityThresholdDb: 10,
      maxHistoryBuckets: 120,
    });
    const detector = new CpuFirstHeuristicDetector({
      canonicalSourceId: source.canonicalId as CacheableSourceId,
      bufferConfig: {
        segmentDurationSec: segDur,
        preEventSec,
        postEventSec,
        maxRetentionSec,
      },
      scoreThreshold,
      cooldownSec,
      aggregationWindowSec,
    });

    const pendingCandidates: PendingHighlightCandidate[] = [];
    const activeClipTasks = new Set<Promise<void>>();
    let clipErrors: Error[] = [];
    let manifestWriteChain = Promise.resolve();

    const publishSessionManifest = (status: 'LIVE' | 'ENDED' | 'FAILED') => {
      manifestWriteChain = manifestWriteChain.then(async () => {
        if (leaseLostErr) return;
        const existing = await this.cache.getCachedManifest<PersistedLiveSessionManifest>(
          auth,
          sessionDescriptor,
        );
        if (existing?.data && existing.data.fencingToken > fencingToken) {
          throw new MediaSourceError({
            code: 'LEASE_EXPIRED',
            message: `Stale continuous owner (token ${fencingToken}) refused to overwrite newer session manifest (token ${existing.data.fencingToken}).`,
          });
        }
        const manifest: PersistedLiveSessionManifest = {
          version: 1,
          fencingToken,
          canonicalSourceId: source.canonicalId,
          sourceRevision,
          algorithmVersion,
          streamStatus: status,
          lastValidSegmentIndex,
          segmentsReceived,
          highlights: [...persistedHighlights],
          updatedAtMs: Date.now(),
        };
        await this.cache.putCachedManifest(auth, sessionDescriptor, manifest);
      });
      return manifestWriteChain;
    };

    const finalizeCandidateAsync = (pending: PendingHighlightCandidate): void => {
      pending.status = 'finalizing';
      const emittedAtClipStart = segmentsReceived;

      const task = (async () => {
        const clipScratchDir = path.join(
          scratchDir,
          `clip_${pending.candidate.candidateId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}`,
        );
        try {
          if (ownerAbort.signal.aborted || leaseLostErr) return;

          const readiness = buffer.checkCandidateWindowReadiness(
            pending.candidate.eventTimestampSec,
            { preEventSec, postEventSec },
          );
          const finalStart = readiness.windowStartSec;
          const finalEnd = readiness.windowEndSec;

          // Re-pin all exact segments covering [finalStart, finalEnd] during extraction
          buffer.pinSegments(readiness.pinnedSegmentIndices, pending.pinLeaseId);

          const parsedAlgo = AlgorithmVersionSchema.safeParse(algorithmVersion);
          const finalCandidate: HighlightWindowCandidate = HighlightWindowCandidateSchema.parse({
            ...pending.candidate,
            algorithmVersion: parsedAlgo.success ? parsedAlgo.data : pending.candidate.algorithmVersion,
            windowStartSec: finalStart,
            windowEndSec: finalEnd,
            pinnedSegmentIndices: readiness.pinnedSegmentIndices,
          });

          const clipDescriptor: CacheArtifactDescriptor = {
            artifactKind: 'BASE_CLIP',
            sourceRevision,
            timeRangeSec: { start: finalStart, end: finalEnd },
            algorithmVersion,
            renderSettings,
            rightsScope: 'SHARED_PERMITTED',
          };
          const clipIdentity = resolveAuthorizedCacheIdentity(auth, clipDescriptor);

          // Skip if already published in this session (e.g. recovered prior highlight)
          if (publishedCacheKeys.has(clipIdentity.cacheKey)) {
            pending.status = 'ready';
            return;
          }

          // Layer C clip-level coordination so identical clips deduplicate across restarts/instances!
          const clipWorkId = buildClipWorkId(source.canonicalId, clipIdentity.cacheKey);
          const clipCoord = await this.coordinator.requestIngestion({
            canonicalSourceId: clipWorkId,
            requesterId: req.requesterUserId,
            workerId: `${req.workerId}_clip`,
            leaseMs,
            maxRetries,
          });

          let entry: PersistedLiveHighlightEntry | null = null;
          let reusedFromCache = false;

          // Check if clip already exists and is verified in MinIO (e.g., from prior run before crash)
          const existingClipManifest = await this.cache.getCachedManifest<PersistedClipManifest>(
            auth,
            clipDescriptor,
          );
          if (
            existingClipManifest?.data &&
            (clipCoord.action === 'REUSE_READY' || clipCoord.action === 'ACQUIRED_NEW' || clipCoord.action === 'ACQUIRED_RECOVERY')
          ) {
            const m = existingClipManifest.data;
            const head = await this.cache.checkObjectAtKey(auth, clipDescriptor, m.objectKey);
            if (head.hit && head.sizeBytes === m.clipMeta.sizeBytes && (!m.etag || head.etag === m.etag)) {
              reusedFromCache = true;
              this.counters.cachedHighlightHits++;
              if (clipCoord.action === 'ACQUIRED_NEW' || clipCoord.action === 'ACQUIRED_RECOVERY') {
                await this.coordinator
                  .markReady({
                    canonicalSourceId: clipWorkId,
                    workerId: `${req.workerId}_clip`,
                    fencingToken: clipCoord.fencingToken,
                    artifactRef: m.objectKey,
                  })
                  .catch(() => {});
              }
              const nowMs = Date.now();
              entry = {
                candidate: finalCandidate,
                cacheKey: clipIdentity.cacheKey,
                objectKey: m.objectKey,
                etag: m.etag,
                descriptor: clipDescriptor,
                clipMeta: m.clipMeta,
                fencingToken: m.fencingToken,
                detectedAtMs: pending.detectedAtMs,
                readyAtMs: nowMs,
                detectionToReadyMs: nowMs - pending.detectedAtMs,
                segmentsEmittedAtDetection: pending.segmentsEmittedAtDetection,
                segmentsEmittedAtClipReady: segmentsReceived,
                streamActiveAtDetection: pending.streamActiveAtDetection,
                streamActiveAtClipReady: !streamEnded,
              };
            }
          }

          if (!entry) {
            if (
              clipCoord.action !== 'ACQUIRED_NEW' &&
              clipCoord.action !== 'ACQUIRED_RECOVERY'
            ) {
              // Another worker owns this clip workId; nothing to duplicate
              pending.status = 'ready';
              return;
            }

            await this.coordinator.markIngesting({
              canonicalSourceId: clipWorkId,
              workerId: `${req.workerId}_clip`,
              fencingToken: clipCoord.fencingToken,
              leaseMs,
            });

            // Dedicated clip-level lease heartbeat so heavy FFmpeg extraction under CPU load never loses clipWorkId lease
            let clipHbStopped = false;
            let clipHbTimer: NodeJS.Timeout | null = null;
            const clipHbInterval = Math.max(200, Math.floor(leaseMs / 3));
            const scheduleClipHb = () => {
              if (clipHbStopped || ownerAbort.signal.aborted) return;
              clipHbTimer = setTimeout(async () => {
                if (clipHbStopped || ownerAbort.signal.aborted) return;
                try {
                  await this.coordinator.renewLease({
                    canonicalSourceId: clipWorkId,
                    workerId: `${req.workerId}_clip`,
                    fencingToken: clipCoord.fencingToken,
                    leaseMs,
                  });
                  scheduleClipHb();
                } catch {
                  // Clip renewal failure will surface cleanly before publish
                }
              }, clipHbInterval);
              clipHbTimer.unref?.();
            };
            const stopClipHb = () => {
              clipHbStopped = true;
              if (clipHbTimer) {
                clearTimeout(clipHbTimer);
                clipHbTimer = null;
              }
            };
            scheduleClipHb();

            try {
              this.counters.ffmpegClipExtractions++;
              await fs.mkdir(clipScratchDir, { recursive: true });
              const outClipPath = path.join(clipScratchDir, 'live-highlight.mp4');
              const videoFilter = computeFilterForRender(renderSettings);

              const clipMeta = await extractAndVerifyHighlightClip({
                buffer,
                windowStartSec: finalStart,
                windowEndSec: finalEnd,
                outputPath: outClipPath,
                preferStreamCopy: !videoFilter,
                videoFilter,
                requireAudio: true,
                signal: ownerAbort.signal,
              });

              if (req.onBeforeClipPublish) {
                await req.onBeforeClipPublish({
                  clipWorkId,
                  fencingToken: clipCoord.fencingToken,
                  candidate: finalCandidate,
                });
              }

              // Renew clip lease before durable publication
              await this.coordinator.renewLease({
                canonicalSourceId: clipWorkId,
                workerId: `${req.workerId}_clip`,
                fencingToken: clipCoord.fencingToken,
                leaseMs,
              });

              // Upload immutable versioned MP4 object (preserves prior healthy object on failure)
              const mp4Bytes = await fs.readFile(outClipPath);
              const versionTag = `gen-${clipCoord.fencingToken}-${clipMeta.sha256.slice(0, 12)}.mp4`;
              const storedObj = await this.cache.putVersionedArtifact(
                auth,
                clipDescriptor,
                versionTag,
                mp4Bytes,
                'video/mp4',
              );

              // Guard against stale worker overwriting newer clip manifest
              const priorClip = await this.cache.getCachedManifest<PersistedClipManifest>(
                auth,
                clipDescriptor,
              );
              if (priorClip?.data && priorClip.data.fencingToken >= clipCoord.fencingToken) {
                throw new MediaSourceError({
                  code: 'LEASE_EXPIRED',
                  message: `Stale clip worker (token ${clipCoord.fencingToken}) refused to overwrite newer clip manifest (token ${priorClip.data.fencingToken}).`,
                });
              }

              const verifiedMeta: ProbedClipMetadata = {
                ...clipMeta,
                filePath: '(persisted-in-storage)',
              };
              const clipManifest: PersistedClipManifest = {
                version: 1,
                fencingToken: clipCoord.fencingToken,
                canonicalSourceId: source.canonicalId,
                sourceRevision,
                algorithmVersion,
                cacheKey: clipIdentity.cacheKey,
                objectKey: storedObj.objectKey,
                etag: storedObj.etag,
                candidate: finalCandidate,
                clipMeta: verifiedMeta,
                createdAtMs: Date.now(),
              };

              await this.cache.putCachedManifest(auth, clipDescriptor, clipManifest);

              stopClipHb();
              await this.coordinator.markReady({
                canonicalSourceId: clipWorkId,
                workerId: `${req.workerId}_clip`,
                fencingToken: clipCoord.fencingToken,
                artifactRef: storedObj.objectKey,
              });

              const nowMs = Date.now();
              entry = {
                candidate: finalCandidate,
                cacheKey: clipIdentity.cacheKey,
                objectKey: storedObj.objectKey,
                etag: storedObj.etag,
                descriptor: clipDescriptor,
                clipMeta: verifiedMeta,
                fencingToken: clipCoord.fencingToken,
                detectedAtMs: pending.detectedAtMs,
                readyAtMs: nowMs,
                detectionToReadyMs: nowMs - pending.detectedAtMs,
                segmentsEmittedAtDetection: pending.segmentsEmittedAtDetection,
                segmentsEmittedAtClipReady: segmentsReceived,
                streamActiveAtDetection: pending.streamActiveAtDetection,
                streamActiveAtClipReady: !streamEnded,
              };
            } catch (clipErr) {
              stopClipHb();
              await this.coordinator
                .markFailed({
                  canonicalSourceId: clipWorkId,
                  workerId: `${req.workerId}_clip`,
                  fencingToken: clipCoord.fencingToken,
                  error: clipErr instanceof Error ? clipErr.message : String(clipErr),
                })
                .catch(() => {});
              throw clipErr;
            } finally {
              stopClipHb();
            }
          }

          if (segmentsReceived > emittedAtClipStart || !streamEnded) {
            ingestionContinuedDuringClipRender = true;
          }

          if (entry && !publishedCacheKeys.has(entry.cacheKey)) {
            publishedCacheKeys.add(entry.cacheKey);
            persistedHighlights.push(entry);
            if (firstClipReadyAtMs === null) {
              firstClipReadyAtMs = entry.readyAtMs;
            }

            const downloadUrl = await this.cache.createAuthorizedDownloadUrlForObject(
              auth,
              entry.descriptor,
              entry.objectKey,
            );
            const published: PublishedLiveHighlight = {
              candidate: entry.candidate,
              cacheKey: entry.cacheKey,
              objectKey: entry.objectKey,
              descriptor: entry.descriptor,
              clipMeta: entry.clipMeta,
              downloadUrl,
              fencingToken: entry.fencingToken,
              detectedAtMs: entry.detectedAtMs,
              readyAtMs: entry.readyAtMs,
              detectionToReadyMs: entry.detectionToReadyMs,
              segmentsEmittedAtDetection: entry.segmentsEmittedAtDetection,
              segmentsEmittedAtClipReady: entry.segmentsEmittedAtClipReady,
              streamActiveAtDetection: entry.streamActiveAtDetection,
              streamActiveAtClipReady: entry.streamActiveAtClipReady,
              reusedFromCache,
            };
            publishedHighlights.push(published);

            // Publish updated session manifest IMMEDIATELY while stream stays LIVE so remote clippers see it!
            await publishSessionManifest(streamEnded ? 'ENDED' : 'LIVE');
            await req.onHighlightReady?.(published);
          }

          pending.status = 'ready';
        } catch (err) {
          pending.status = 'failed';
          if (!ownerAbort.signal.aborted) {
            clipErrors.push(err instanceof Error ? err : new Error(String(err)));
          }
        } finally {
          // Always release segment pins once clip extraction finishes so rolling buffer can evict old footage
          buffer.unpinLease(pending.pinLeaseId);
          await fs.rm(clipScratchDir, { recursive: true, force: true }).catch(() => {});
          await buffer.evictExpired(buffer.getLatestBufferedSec()).catch(() => {});
        }
      })();

      activeClipTasks.add(task);
      task.finally(() => {
        activeClipTasks.delete(task);
      });
    };

    const triggerReadyCandidates = () => {
      for (const pending of pendingCandidates) {
        if (pending.status !== 'pending_post_event') continue;
        if (activeClipTasks.size >= maxConcurrentClips) break;
        const readiness = buffer.checkCandidateWindowReadiness(
          pending.candidate.eventTimestampSec,
          { preEventSec, postEventSec },
        );
        // Keep newly arrived post-event segments pinned for this candidate while waiting
        if (readiness.pinnedSegmentIndices.length > 0) {
          buffer.pinSegments(readiness.pinnedSegmentIndices, pending.pinLeaseId);
        }
        if (readiness.canFinalize) {
          finalizeCandidateAsync(pending);
        }
      }
    };

    try {
      await this.coordinator.markIngesting({
        canonicalSourceId: sessionWorkId,
        workerId: req.workerId,
        fencingToken,
        leaseMs,
      });

      // Publish initial LIVE session manifest so attached clippers know the stream is active
      await publishSessionManifest('LIVE');

      const streamStats = await req.adapter.streamSegments(
        path.join(scratchDir, 'producer'),
        {
          signal: ownerAbort.signal,
          onSegment: async (emitted: EmittedStreamSegment) => {
            if (ownerAbort.signal.aborted || leaseLostErr) return;

            if (firstSegmentArrivedAtMs === null) {
              firstSegmentArrivedAtMs = emitted.emittedAtMs;
            }
            segmentsReceived++;
            this.counters.segmentsIngested++;

            // 1. Append incoming segment to rolling buffer (validates via ffprobe, handles corrupt/late/gaps, evicts old unpinned)
            const buffered = await buffer.appendIncomingSegment({
              index: emitted.index,
              sourceFilePath: emitted.filePath,
              expectedStartSec: emitted.startSec,
              copyToWorkDir: true,
            });

            if (buffered.valid) {
              validSegmentsReceived++;
              if (buffered.index > lastValidSegmentIndex) {
                lastValidSegmentIndex = buffered.index;
              }

              // 2. Incremental CPU-first analysis strictly on THIS newly arrived segment (never re-analyzes history!)
              const audioRes = await audioTracker.processSegment(buffered, {
                signal: ownerAbort.signal,
              });
              this.counters.segmentsAnalyzed++;

              for (const sample of audioRes.samples) {
                detector.ingestSignal(sample);
              }
              if (req.syntheticSignals) {
                for (const synth of req.syntheticSignals) {
                  if (
                    synth.timestampSec >= buffered.startSec &&
                    synth.timestampSec < buffered.endSec
                  ) {
                    detector.ingestSignal(synth);
                  }
                }
              }

              // 3. Incremental highlight detection with persistent cooldown across segments
              const newlyDetected = detector.evaluateIncremental(buffered.endSec);
              for (const cand of newlyDetected) {
                const nowMs = Date.now();
                detectedCandidatesCount++;
                if (firstDetectionAtMs === null) {
                  firstDetectionAtMs = nowMs;
                }
                const readiness = buffer.checkCandidateWindowReadiness(cand.eventTimestampSec, {
                  preEventSec,
                  postEventSec,
                });
                const pinLeaseId = `pin_${cand.candidateId}`;
                buffer.pinSegments(readiness.pinnedSegmentIndices, pinLeaseId);

                pendingCandidates.push({
                  candidate: cand,
                  windowStartSec: readiness.windowStartSec,
                  windowEndSec: readiness.windowEndSec,
                  detectedAtMs: nowMs,
                  segmentsEmittedAtDetection: segmentsReceived,
                  streamActiveAtDetection: !streamEnded,
                  status: 'pending_post_event',
                  pinLeaseId,
                });
              }
            }

            // 4. Launch clip extraction asynchronously for any candidate whose post-event window is NOW ready!
            //    Does NOT await clip extraction here so live segment ingestion continues uninterrupted!
            triggerReadyCandidates();

            const mem = process.memoryUsage().heapUsed;
            if (mem > peakHeapUsedBytes) peakHeapUsedBytes = mem;

            await req.onSegmentArrived?.({
              index: emitted.index,
              valid: buffered.valid,
              emittedCount: segmentsReceived,
              latestBufferedSec: buffer.getLatestBufferedSec(),
              activeClipExtractions: activeClipTasks.size,
            });
          },
          onEnd: async () => {
            streamEnded = true;
            buffer.markEndOfStream();
            // Finalize any trailing candidates whose post-event window is now bounded by stream end
            triggerReadyCandidates();
          },
        },
      );

      if (ownerAbort.signal.aborted || leaseLostErr) {
        throw (
          leaseLostErr ??
          new MediaSourceError({
            code: 'REQUEST_CANCELLED',
            message: `Continuous ingestion aborted for ${sessionWorkId}.`,
          })
        );
      }

      // Wait for all active/pending background clip extractions to complete cleanly before marking READY
      while (
        activeClipTasks.size > 0 ||
        pendingCandidates.some((p) => p.status === 'pending_post_event')
      ) {
        triggerReadyCandidates();
        if (activeClipTasks.size > 0) {
          await Promise.all([...activeClipTasks]);
        } else {
          break;
        }
      }

      if (clipErrors.length > 0) {
        throw clipErrors[0];
      }

      if (leaseLostErr) throw leaseLostErr;

      // Publish final ENDED session manifest and mark Redis coordination READY
      await publishSessionManifest('ENDED');
      await this.coordinator.markReady({
        canonicalSourceId: sessionWorkId,
        workerId: req.workerId,
        fencingToken,
        artifactRef: `${resolveAuthorizedCacheIdentity(auth, sessionDescriptor).storageKey}.manifest.json`,
      });

      const streamEndedAtMs = Date.now();
      const bufStats = buffer.getStats();
      const elapsedSec = Math.max(0.001, (streamEndedAtMs - streamStartedAtMs) / 1000);

      const metricsReport: ContinuousLiveMetricsReport = {
        firstSegmentArrivedAtMs,
        firstDetectionAtMs,
        firstSegmentToFirstDetectionMs:
          firstSegmentArrivedAtMs !== null && firstDetectionAtMs !== null
            ? firstDetectionAtMs - firstSegmentArrivedAtMs
            : null,
        firstClipReadyAtMs,
        firstDetectionToClipReadyMs:
          firstDetectionAtMs !== null && firstClipReadyAtMs !== null
            ? firstClipReadyAtMs - firstDetectionAtMs
            : null,
        streamStartedAtMs,
        streamEndedAtMs,
        segmentsReceived,
        validSegmentsReceived,
        corruptSegmentsSkipped: bufStats.corruptSegmentsSkipped,
        gapsDetected: bufStats.gapsDetected,
        lateSegmentsReceived: bufStats.lateSegmentsReceived,
        segmentsAnalyzedCount: audioTracker.segmentsAnalyzedCount,
        segmentIngestionRatePerSec: Math.round((segmentsReceived / elapsedSec) * 100) / 100,
        detectedCandidatesCount,
        finalizedClipsCount: publishedHighlights.length,
        clipsReadyWhileStreamActive: publishedHighlights.filter((h) => h.streamActiveAtClipReady)
          .length,
        ingestionContinuedDuringClipRender,
        peakDiskBytes: bufStats.peakDiskBytes,
        peakHeapUsedBytes,
        evictedSegmentsCount: bufStats.evictedCount,
        backpressureWaits: streamStats.backpressureWaits,
        heartbeatRenewals: sessionHeartbeatRenewals,
      };

      return {
        canonicalSourceId: source.canonicalId,
        sessionWorkId,
        coordinationAction: action,
        wasSessionOwner: true,
        streamStatus: 'ENDED',
        fencingToken,
        highlights: publishedHighlights.sort(
          (a, b) => a.candidate.eventTimestampSec - b.candidate.eventTimestampSec,
        ),
        metrics: metricsReport,
        processingMs: Date.now() - startedAt,
      };
    } catch (err) {
      stopHeartbeat();
      ownerAbort.abort(err);
      // Wait briefly for any in-flight clip tasks to observe abort & clean up pins
      if (activeClipTasks.size > 0) {
        await Promise.allSettled([...activeClipTasks]);
      }
      // Persist any highlights already finalized before failure so a recovery worker can reuse them!
      if (!leaseLostErr && persistedHighlights.length > 0) {
        await publishSessionManifest('FAILED').catch(() => {});
      }
      const effectiveErr = leaseLostErr ?? err;
      const isLeaseLost =
        effectiveErr instanceof MediaSourceError && effectiveErr.code === 'LEASE_EXPIRED';
      if (!isLeaseLost) {
        await this.coordinator
          .markFailed({
            canonicalSourceId: sessionWorkId,
            workerId: req.workerId,
            fencingToken,
            error: effectiveErr instanceof Error ? effectiveErr.message : String(effectiveErr),
          })
          .catch(() => {});
      }
      throw effectiveErr;
    } finally {
      stopHeartbeat();
      await buffer.cleanupAll();
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
