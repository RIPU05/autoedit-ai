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
  buildAnalysisWorkId,
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
import { ControlledLocalStreamAdapter } from './controlled-stream.adapter.js';
import { FfmpegRollingSegmentBuffer, type BufferedMediaSegment } from './rolling-segment-buffer.js';
import { extractAudioSignalsFromSegments } from './audio-signal-extractor.js';
import {
  extractAndVerifyHighlightClip,
  probeAndValidateClipMp4FromBuffer,
  type ProbedClipMetadata,
} from './highlight-clip-extractor.js';
import {
  ContinuousLiveSessionService,
  type ContinuousBroadcastRequest,
  type ContinuousBroadcastResult,
} from './continuous-live-session.js';

export interface SharedBroadcastRequest {
  adapter: ControlledLocalStreamAdapter;
  requesterUserId: string;
  workerId: string;
  sourceRevision?: string;
  algorithmVersion?: string;
  bufferConfig?: Partial<RollingBufferConfig>;
  renderSettings?: CacheRenderSettings;
  scoreThreshold?: number;
  cooldownSec?: number;
  /** Optional synthetic chat/keyword signals injected in tests (never claims live platform chat). */
  syntheticSignals?: HighlightDetectionSample[];
  /** Lease duration in ms; defaults to 30_000. Renewed periodically via heartbeat while active. */
  leaseMs?: number;
  maxRetries?: number;
  /** Maximum total time a waiter will wait for another worker to finish, in ms; defaults to 45_000. */
  waitTimeoutMs?: number;
  /** Initial cross-instance poll delay in ms; defaults to 25. */
  pollInitialMs?: number;
  /** Maximum cross-instance poll backoff in ms; defaults to 200. */
  pollMaxMs?: number;
  /** Optional AbortSignal to cancel waiting or active FFmpeg processing cleanly. */
  signal?: AbortSignal;
  /**
   * When true, downloads cached MP4 bytes on reuse to verify full SHA-256 + ffprobe integrity
   * in addition to manifest + ETag + Content-Length checks.
   */
  verifyMediaIntegrity?: boolean;
  /** Optional test hook invoked on clip owner right before manifest publish & READY. */
  onBeforePublishReady?: (ctx: {
    fencingToken: number;
    workerId: string;
    workId: CacheableSourceId;
    objectKey: string;
  }) => Promise<void>;
  /** Optional test hook to simulate FFmpeg/storage failure or slow work before upload. */
  onAfterExtractBeforeUpload?: (clipPath: string, ctx: { fencingToken: number; workId: CacheableSourceId }) => Promise<void>;
}

export interface SharedBroadcastHighlightResult {
  canonicalSourceId: string;
  workIds: {
    sourceWorkId: CacheableSourceId;
    analysisWorkId: CacheableSourceId;
    clipWorkId: CacheableSourceId;
  };
  coordinationAction: IngestionRequestAction;
  cacheHit: boolean;
  cacheKey: string;
  objectKey: string;
  descriptor: CacheArtifactDescriptor;
  downloadUrl: string;
  candidate: HighlightWindowCandidate;
  clipMeta: ProbedClipMetadata;
  sizeBytes: number;
  fencingToken: number;
  processingMs: number;
}

export interface PrivateEditRequest {
  adapter: ControlledLocalStreamAdapter;
  requesterUserId: string;
  ownerUserId: string;
  customEditHash: string;
  windowStartSec: number;
  windowEndSec: number;
  videoFilter?: string;
  sourceRevision?: string;
  bufferConfig?: Partial<RollingBufferConfig>;
  signal?: AbortSignal;
}

export interface SharedPipelineMetrics {
  sourceProcessingCount: number;
  analysisPassCount: number;
  ffmpegClipRenderCount: number;
  cacheHits: number;
  recoveryRuns: number;
  repairAcquisitions: number;
  heartbeatRenewals: number;
  corruptArtifactsDetected: number;
}

interface PersistedSourceSegmentEntry {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  etag?: string;
}

interface PersistedSourceManifest {
  version: 1;
  fencingToken: number;
  canonicalSourceId: string;
  sourceRevision: string;
  segmentDurationSec: number;
  totalDurationSec: number;
  segments: PersistedSourceSegmentEntry[];
}

interface PersistedAnalysisManifest {
  version: 1;
  fencingToken: number;
  canonicalSourceId: string;
  sourceRevision: string;
  algorithmVersion: string;
  candidate: HighlightWindowCandidate;
  totalDurationSec: number;
}

export interface PersistedClipManifest {
  version: 1;
  fencingToken: number;
  canonicalSourceId: string;
  sourceRevision: string;
  algorithmVersion: string;
  cacheKey: string;
  objectKey: string;
  etag?: string;
  candidate: HighlightWindowCandidate;
  clipMeta: ProbedClipMetadata;
  createdAtMs: number;
}

const DEFAULT_BASE_CLIP_RENDER: CacheRenderSettings = {
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
        message: 'Shared processing request cancelled.',
      }),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: 'Shared processing request cancelled.',
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

function stableHashShort(value: unknown, length = 16): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);
}

function isValidProbedClipMetadata(meta: unknown): meta is ProbedClipMetadata {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Partial<ProbedClipMetadata>;
  return (
    typeof m.sizeBytes === 'number' &&
    m.sizeBytes > 0 &&
    typeof m.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(m.sha256) &&
    typeof m.durationSec === 'number' &&
    m.durationSec > 0 &&
    typeof m.width === 'number' &&
    m.width > 0 &&
    typeof m.height === 'number' &&
    m.height > 0 &&
    typeof m.fps === 'number' &&
    m.fps > 0 &&
    typeof m.videoCodec === 'string' &&
    m.videoCodec.length > 0 &&
    m.hasVideo === true
  );
}

function computeVideoFilterForRenderSettings(renderSettings: CacheRenderSettings): string | undefined {
  // Source fixture defaults to 1280x720@30fps; apply explicit filter when caller asks for a different render profile
  const needsScale = renderSettings.width !== 1280 || renderSettings.height !== 720;
  const needsFps = renderSettings.fps !== 30;
  if (!needsScale && !needsFps && !renderSettings.zooms && !renderSettings.subtitles) {
    return undefined;
  }
  const filters: string[] = [];
  if (needsScale) {
    filters.push(`scale=${renderSettings.width}:${renderSettings.height}`);
  } else if (renderSettings.zooms) {
    // Subtle deterministic center zoom/crop while preserving output resolution
    filters.push(`crop=iw*0.95:ih*0.95,scale=${renderSettings.width}:${renderSettings.height}`);
  }
  if (needsFps) {
    filters.push(`fps=${renderSettings.fps}`);
  }
  if (filters.length === 0 && renderSettings.subtitles) {
    // Distinct re-encode filter tag (no external font dependency) so subtitle-enabled variant differs deterministically
    filters.push(`scale=${renderSettings.width}:${renderSettings.height}`);
  }
  return filters.length > 0 ? filters.join(',') : undefined;
}

/**
 * Distributed shared livestream ingestion, CPU-first highlight detection,
 * FFmpeg MP4 clip generation, and verified MinIO/S3 cache reuse orchestrator.
 *
 * Key distributed properties:
 * - Zero reliance on process-local Maps for cross-instance ownership or cached metadata.
 * - Three scoped coordination layers (Source, Analysis, Derived Base Clip) so upstream
 *   source acquisition and analysis are reused when only downstream clip render settings differ.
 * - Cross-instance ATTACH_EXISTING waits via bounded Redis polling with backoff, cancellation,
 *   timeout, and owner-crash/lease-expiry recovery.
 * - Conditional atomic invalidation (`invalidateReadyArtifact`) ensures strictly ONE repair
 *   worker regenerates missing or corrupt artifacts without bypassing fencing tokens.
 * - Immutable versioned objects + atomic manifest updates + continuous lease heartbeat with
 *   FFmpeg cancellation (`SIGKILL` via AbortSignal) protect against stale-worker overwrites.
 */
export class SharedLiveProcessingService {
  readonly cache: SharedArtifactCacheService;
  readonly continuous: ContinuousLiveSessionService;
  readonly metrics: SharedPipelineMetrics = {
    sourceProcessingCount: 0,
    analysisPassCount: 0,
    ffmpegClipRenderCount: 0,
    cacheHits: 0,
    recoveryRuns: 0,
    repairAcquisitions: 0,
    heartbeatRenewals: 0,
    corruptArtifactsDetected: 0,
  };

  /**
   * Purely a local read-poll coalescer for concurrent waiters on the SAME workId inside one
   * Node process so 500 local waiters share one Redis GET poll interval rather than 500 loops.
   * Never grants ownership and never caches artifacts or manifests.
   */
  private readonly localPollCoalescer = new Map<string, Promise<IngestionCoordinationRecord | null>>();

  /**
   * In-flight-only MinIO verification coalescer (always deleted in `finally`, zero TTL cache).
   * Prevents 500 concurrent waiters waking up on the exact same tick from saturating S3 sockets
   * with identical simultaneous manifest/HEAD checks while preserving fresh live verification on
   * every subsequent call.
   */
  private readonly localDurableCheckCoalescer = new Map<string, Promise<unknown>>();

  constructor(
    private readonly coordinator: SharedIngestionCoordinator,
    private readonly storage: MediaStorageProvider,
    private readonly workRootDir: string,
  ) {
    this.cache = new SharedArtifactCacheService(storage);
    this.continuous = new ContinuousLiveSessionService(coordinator, storage, workRootDir);
  }

  /**
   * Joins an active continuous livestream ingestion or starts it if this worker acquires
   * the Redis lease. Reuses the same coordinator, storage, and work root as batch highlights.
   */
  async joinOrStartContinuousBroadcast(
    req: ContinuousBroadcastRequest,
  ): Promise<ContinuousBroadcastResult> {
    return this.continuous.joinOrStartContinuousBroadcast(req);
  }

  private buildAuth(
    adapter: ControlledLocalStreamAdapter,
    requesterUserId: string,
    ownerUserId?: string,
  ): TrustedCacheAuthContext {
    const source = adapter.buildVerifiedBroadcastSource();
    assertAcquisitionPermitted(source);
    return createTrustedCacheAuthContext({
      source,
      requesterUserId,
      ownerUserId,
      allowSharedCacheReuse: adapter.policy.allowSharedCacheReuse,
    });
  }

  private async runDurableCheckCoalesced<R>(
    key: string,
    fn: () => Promise<R>,
  ): Promise<R> {
    const existing = this.localDurableCheckCoalescer.get(key) as Promise<R> | undefined;
    if (existing) return existing;
    const promise = fn().finally(() => {
      this.localDurableCheckCoalescer.delete(key);
    });
    this.localDurableCheckCoalescer.set(key, promise);
    return promise;
  }

  private async getStateCoalesced(workId: CacheableSourceId): Promise<IngestionCoordinationRecord | null> {
    const existing = this.localPollCoalescer.get(workId);
    if (existing) return existing;
    const promise = this.coordinator.getState(workId).finally(() => {
      this.localPollCoalescer.delete(workId);
    });
    this.localPollCoalescer.set(workId, promise);
    return promise;
  }

  /**
   * Bounded cross-instance waiter for ATTACH_EXISTING or CONFLICT_ALREADY_RECOVERING.
   * Polls Redis state with exponential backoff while respecting caller cancellation and deadline.
   * Never executes FFmpeg or acquires work directly.
   */
  private async waitForCoordinatedChange(params: {
    workId: CacheableSourceId;
    observedFencingToken: number;
    deadlineMs: number;
    pollInitialMs: number;
    pollMaxMs: number;
    signal?: AbortSignal;
  }): Promise<IngestionCoordinationRecord | null> {
    let delayMs = params.pollInitialMs;

    while (true) {
      if (params.signal?.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Cancelled while waiting for ${params.workId}.`,
        });
      }
      const remainingMs = params.deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new MediaSourceError({
          code: 'COORDINATION_TIMEOUT',
          message: `Timed out waiting for coordinated work item ${params.workId}.`,
          retryable: true,
        });
      }

      await sleepAbortable(Math.min(delayMs, remainingMs), params.signal);
      delayMs = Math.min(params.pollMaxMs, Math.ceil(delayMs * 1.6));

      const rec = await this.getStateCoalesced(params.workId);
      if (!rec) {
        return null; // Redis key evicted/expired -> caller will re-check durable storage / re-coordinate
      }
      if (rec.state === 'READY' || rec.state === 'FAILED' || rec.state === 'EXPIRED') {
        return rec;
      }
      if (
        (rec.state === 'ACQUIRING' || rec.state === 'INGESTING') &&
        rec.leaseExpiresAtMs <= Date.now()
      ) {
        return rec; // Active owner's lease expired -> caller may safely re-enter coordination for recovery
      }
      if (rec.fencingToken !== params.observedFencingToken) {
        return rec; // New owner generation took over -> re-evaluate state
      }
    }
  }

  /**
   * Executes one coordinated distributed stage (Source, Analysis, or Base Clip) across
   * any number of independent service instances sharing only Redis + MinIO.
   */
  private async runCoordinatedStage<T>(params: {
    workId: CacheableSourceId;
    requesterId: string;
    workerId: string;
    leaseMs: number;
    maxRetries: number;
    waitTimeoutMs: number;
    pollInitialMs: number;
    pollMaxMs: number;
    signal?: AbortSignal;
    skipColdCacheCheck?: boolean;
    tryLoadVerifiedDurable: (opts: {
      expectedArtifactRef?: string;
      deepVerify?: boolean;
    }) => Promise<{ ok: true; value: T; artifactRef: string } | { ok: false; reason: string; corrupt?: boolean }>;
    executeAsOwner: (ctx: {
      fencingToken: number;
      signal: AbortSignal;
      renewNow: () => Promise<void>;
    }) => Promise<{ value: T; artifactRef: string }>;
  }): Promise<{
    value: T;
    action: IngestionRequestAction;
    cacheHit: boolean;
    fencingToken: number;
  }> {
    const deadlineMs = Date.now() + params.waitTimeoutMs;
    let recordedAction: IngestionRequestAction | null = null;

    while (true) {
      if (params.signal?.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Request cancelled before acquiring ${params.workId}.`,
        });
      }
      if (Date.now() > deadlineMs) {
        throw new MediaSourceError({
          code: 'COORDINATION_TIMEOUT',
          message: `Timed out coordinating work item ${params.workId}.`,
          retryable: true,
        });
      }

      const coord = await this.coordinator.requestIngestion({
        canonicalSourceId: params.workId,
        requesterId: params.requesterId,
        workerId: params.workerId,
        leaseMs: params.leaseMs,
        maxRetries: params.maxRetries,
      });

      // 1. REUSE_READY -> verify durable artifact exists AND passes integrity validation
      if (coord.action === 'REUSE_READY') {
        const durable = await this.runDurableCheckCoalesced(
          `${params.workId}::${coord.record.artifactRef ?? ''}::${coord.fencingToken}`,
          () => params.tryLoadVerifiedDurable({ expectedArtifactRef: coord.record.artifactRef }),
        );
        if (durable.ok) {
          return {
            value: durable.value,
            action: recordedAction ?? 'REUSE_READY',
            cacheHit: true,
            fencingToken: coord.fencingToken,
          };
        }
        if (durable.corrupt) {
          this.metrics.corruptArtifactsDetected++;
        }

        // Durable artifact is missing or corrupt while Redis says READY -> conditional atomic invalidation!
        // NEVER bypass ownership with fencingToken: undefined.
        const inv = await this.coordinator.invalidateReadyArtifact({
          canonicalSourceId: params.workId,
          expectedArtifactRef: coord.record.artifactRef ?? '',
          expectedFencingToken: coord.fencingToken,
          repairWorkerId: params.workerId,
          leaseMs: params.leaseMs,
          maxRetries: params.maxRetries,
        });

        if (inv.action === 'ACQUIRED_REPAIR') {
          this.metrics.recoveryRuns++;
          this.metrics.repairAcquisitions++;
          const owned = await this.runOwnerWithHeartbeat({
            workId: params.workId,
            workerId: params.workerId,
            fencingToken: inv.fencingToken,
            leaseMs: params.leaseMs,
            signal: params.signal,
            skipColdCacheCheck: true, // we just confirmed durable artifact is missing/corrupt
            tryLoadVerifiedDurable: params.tryLoadVerifiedDurable,
            executeAsOwner: params.executeAsOwner,
          });
          return {
            value: owned.value,
            action: 'ACQUIRED_RECOVERY',
            cacheHit: owned.cacheHit,
            fencingToken: inv.fencingToken,
          };
        }

        // Another repair worker already won invalidation -> wait for it without starting duplicate work
        recordedAction = recordedAction ?? 'ATTACH_EXISTING';
        await this.waitForCoordinatedChange({
          workId: params.workId,
          observedFencingToken: inv.fencingToken || coord.fencingToken,
          deadlineMs,
          pollInitialMs: params.pollInitialMs,
          pollMaxMs: params.pollMaxMs,
          signal: params.signal,
        });
        continue;
      }

      // 2. ATTACH_EXISTING -> NEVER fall through into executeAsOwner; wait via Redis polling!
      if (coord.action === 'ATTACH_EXISTING') {
        recordedAction = recordedAction ?? 'ATTACH_EXISTING';
        let observedToken = coord.fencingToken;

        while (true) {
          const updated = await this.waitForCoordinatedChange({
            workId: params.workId,
            observedFencingToken: observedToken,
            deadlineMs,
            pollInitialMs: params.pollInitialMs,
            pollMaxMs: params.pollMaxMs,
            signal: params.signal,
          });

          if (!updated) {
            // Redis key disappeared -> break to outer loop to re-coordinate / rehydrate from MinIO
            break;
          }

          if (updated.state === 'READY') {
            const durable = await this.runDurableCheckCoalesced(
              `${params.workId}::${updated.artifactRef ?? ''}::${updated.fencingToken}`,
              () => params.tryLoadVerifiedDurable({ expectedArtifactRef: updated.artifactRef }),
            );
            if (durable.ok) {
              return {
                value: durable.value,
                action: 'ATTACH_EXISTING',
                cacheHit: true,
                fencingToken: updated.fencingToken,
              };
            }
            if (durable.corrupt) {
              this.metrics.corruptArtifactsDetected++;
            }
            // Ready in Redis but missing/corrupt in MinIO -> break to outer loop for coordinated repair
            break;
          }

          if (
            updated.state === 'FAILED' ||
            updated.state === 'EXPIRED' ||
            updated.leaseExpiresAtMs <= Date.now()
          ) {
            // Owner failed or lease expired -> break to outer loop so ONE waiter wins ACQUIRED_RECOVERY
            break;
          }

          // New active owner generation took over while we waited -> keep waiting on new fencing token
          observedToken = updated.fencingToken;
        }
        continue;
      }

      // 3. FAILED_MAX_RETRIES -> fail clearly
      if (coord.action === 'FAILED_MAX_RETRIES') {
        throw new MediaSourceError({
          code: 'MAX_RETRIES_EXCEEDED',
          message: `Work item ${params.workId} exhausted maxRetries (${coord.record.maxRetries}): ${coord.record.lastError ?? 'unknown error'}`,
          retryable: false,
        });
      }

      // 4. ACQUIRED_NEW or ACQUIRED_RECOVERY -> legitimate owner with monotonic fencingToken!
      if (coord.action === 'ACQUIRED_RECOVERY') {
        this.metrics.recoveryRuns++;
      }

      const owned = await this.runOwnerWithHeartbeat({
        workId: params.workId,
        workerId: params.workerId,
        fencingToken: coord.fencingToken,
        leaseMs: params.leaseMs,
        signal: params.signal,
        skipColdCacheCheck: params.skipColdCacheCheck,
        tryLoadVerifiedDurable: params.tryLoadVerifiedDurable,
        executeAsOwner: params.executeAsOwner,
      });

      return {
        value: owned.value,
        action: coord.action,
        cacheHit: owned.cacheHit,
        fencingToken: coord.fencingToken,
      };
    }
  }

  /**
   * Runs owner execution under continuous lease-heartbeat renewal.
   * Aborts running FFmpeg immediately via AbortSignal if the lease is lost or caller cancels.
   */
  private async runOwnerWithHeartbeat<T>(params: {
    workId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs: number;
    signal?: AbortSignal;
    skipColdCacheCheck?: boolean;
    tryLoadVerifiedDurable: (opts: {
      expectedArtifactRef?: string;
      deepVerify?: boolean;
    }) => Promise<{ ok: true; value: T; artifactRef: string } | { ok: false; reason: string; corrupt?: boolean }>;
    executeAsOwner: (ctx: {
      fencingToken: number;
      signal: AbortSignal;
      renewNow: () => Promise<void>;
    }) => Promise<{ value: T; artifactRef: string }>;
  }): Promise<{ value: T; cacheHit: boolean }> {
    const ownerAbort = new AbortController();
    let leaseLostError: Error | null = null;
    let heartbeatStopped = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    const onCallerAbort = () => {
      ownerAbort.abort(
        new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Owner processing for ${params.workId} cancelled by caller.`,
        }),
      );
    };
    if (params.signal) {
      if (params.signal.aborted) {
        onCallerAbort();
      } else {
        params.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    const heartbeatIntervalMs = Math.max(100, Math.floor(params.leaseMs / 3));

    const scheduleHeartbeat = () => {
      if (heartbeatStopped || ownerAbort.signal.aborted) return;
      heartbeatTimer = setTimeout(async () => {
        if (heartbeatStopped || ownerAbort.signal.aborted) return;
        try {
          await this.coordinator.renewLease({
            canonicalSourceId: params.workId,
            workerId: params.workerId,
            fencingToken: params.fencingToken,
            leaseMs: params.leaseMs,
          });
          this.metrics.heartbeatRenewals++;
          scheduleHeartbeat();
        } catch (err) {
          if (heartbeatStopped || ownerAbort.signal.aborted) return;
          leaseLostError = err instanceof Error ? err : new Error(String(err));
          ownerAbort.abort(leaseLostError);
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
      params.signal?.removeEventListener('abort', onCallerAbort);
    };

    const renewNow = async () => {
      if (leaseLostError) throw leaseLostError;
      if (params.signal?.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Processing cancelled for ${params.workId}.`,
        });
      }
      await this.coordinator.renewLease({
        canonicalSourceId: params.workId,
        workerId: params.workerId,
        fencingToken: params.fencingToken,
        leaseMs: params.leaseMs,
      });
      this.metrics.heartbeatRenewals++;
    };

    scheduleHeartbeat();

    try {
      // Cold durable cache check BEFORE running FFmpeg (handles Redis key TTL expiration / eviction)
      if (!params.skipColdCacheCheck) {
        const cold = await params.tryLoadVerifiedDurable({ deepVerify: true });
        if (cold.ok) {
          if (leaseLostError) throw leaseLostError;
          stopHeartbeat();
          await this.coordinator.markReady({
            canonicalSourceId: params.workId,
            workerId: params.workerId,
            fencingToken: params.fencingToken,
            artifactRef: cold.artifactRef,
          });
          return { value: cold.value, cacheHit: true };
        }
        if (cold.corrupt) {
          this.metrics.corruptArtifactsDetected++;
        }
      }

      if (leaseLostError) throw leaseLostError;
      if (ownerAbort.signal.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Processing aborted before ingesting ${params.workId}.`,
        });
      }

      await this.coordinator.markIngesting({
        canonicalSourceId: params.workId,
        workerId: params.workerId,
        fencingToken: params.fencingToken,
        leaseMs: params.leaseMs,
      });

      const outcome = await params.executeAsOwner({
        fencingToken: params.fencingToken,
        signal: ownerAbort.signal,
        renewNow,
      });

      if (leaseLostError) throw leaseLostError;
      if (ownerAbort.signal.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Processing aborted before publishing READY for ${params.workId}.`,
        });
      }

      // Mark READY only AFTER durable output was written & verified!
      stopHeartbeat();
      await this.coordinator.markReady({
        canonicalSourceId: params.workId,
        workerId: params.workerId,
        fencingToken: params.fencingToken,
        artifactRef: outcome.artifactRef,
      });

      return { value: outcome.value, cacheHit: false };
    } catch (err) {
      stopHeartbeat();
      // Mark FAILED in Redis (fenced by fencingToken, so stale workers cannot overwrite newer owners)
      const effectiveErr = leaseLostError ?? err;
      const isLeaseLost =
        effectiveErr instanceof MediaSourceError && effectiveErr.code === 'LEASE_EXPIRED';
      if (!isLeaseLost) {
        await this.coordinator
          .markFailed({
            canonicalSourceId: params.workId,
            workerId: params.workerId,
            fencingToken: params.fencingToken,
            error: effectiveErr instanceof Error ? effectiveErr.message : String(effectiveErr),
          })
          .catch(() => { });
      }
      throw effectiveErr;
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Hydrates segments referenced by a verified SourceManifest from MinIO into a local
   * scratch FfmpegRollingSegmentBuffer without running FFmpeg source segmentation again.
   */
  private async hydrateBufferFromSourceManifest(params: {
    auth: TrustedCacheAuthContext;
    sourceDescriptor: CacheArtifactDescriptor;
    manifest: PersistedSourceManifest;
    workDir: string;
    bufferConfig?: Partial<RollingBufferConfig>;
    windowRange?: { startSec: number; endSec: number };
  }): Promise<{ buffer: FfmpegRollingSegmentBuffer; segments: BufferedMediaSegment[] }> {
    await fs.mkdir(params.workDir, { recursive: true });
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir: params.workDir,
      bufferConfig: {
        ...params.bufferConfig,
        segmentDurationSec: params.manifest.segmentDurationSec,
      },
    });

    const selectedEntries = params.windowRange
      ? params.manifest.segments.filter(
        (s) => s.endSec > params.windowRange!.startSec && s.startSec < params.windowRange!.endSec,
      )
      : params.manifest.segments;

    const hydrated: BufferedMediaSegment[] = [];
    for (const entry of selectedEntries) {
      const bytes = await this.cache.getObjectBytesAtKey(
        params.auth,
        params.sourceDescriptor,
        entry.objectKey,
      );
      if (!bytes || bytes.length !== entry.sizeBytes) {
        throw new MediaSourceError({
          code: 'ARTIFACT_CORRUPT',
          message: `Source segment ${entry.index} missing or truncated in storage (${entry.objectKey}).`,
        });
      }
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== entry.sha256) {
        throw new MediaSourceError({
          code: 'ARTIFACT_CORRUPT',
          message: `Source segment ${entry.index} SHA-256 mismatch in storage (${entry.objectKey}).`,
        });
      }
      const localPath = path.join(
        params.workDir,
        `seg_${String(entry.index).padStart(6, '0')}.mp4`,
      );
      await fs.writeFile(localPath, bytes);
      const seg: BufferedMediaSegment = {
        index: entry.index,
        filePath: localPath,
        startSec: entry.startSec,
        endSec: entry.endSec,
        durationSec: entry.durationSec,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        valid: true,
      };
      buffer.registerVerifiedSegment(seg);
      hydrated.push(seg);
    }

    buffer.markEndOfStream();
    return { buffer, segments: hydrated };
  }

  /**
   * Verifies a persisted ClipManifest and its referenced immutable MP4 object in MinIO.
   * Checks manifest schema, object existence, exact size match, ETag integrity, and
   * optionally full byte-level SHA-256 + ffprobe validation.
   */
  private async loadAndVerifyClipManifest(params: {
    auth: TrustedCacheAuthContext;
    clipDescriptor: CacheArtifactDescriptor;
    expectedArtifactRef?: string;
    deepVerify?: boolean;
  }): Promise<
    | { ok: true; value: PersistedClipManifest; artifactRef: string }
    | { ok: false; reason: string; corrupt?: boolean }
  > {
    const loaded = await this.cache.getCachedManifest<PersistedClipManifest>(
      params.auth,
      params.clipDescriptor,
    );
    if (!loaded || !loaded.data) {
      return { ok: false, reason: 'Clip manifest missing in storage' };
    }

    const m = loaded.data;
    if (
      m.version !== 1 ||
      typeof m.fencingToken !== 'number' ||
      m.fencingToken < 1 ||
      typeof m.objectKey !== 'string' ||
      !m.objectKey ||
      !isValidProbedClipMetadata(m.clipMeta)
    ) {
      return { ok: false, reason: 'Clip manifest schema invalid', corrupt: true };
    }

    const parsedCandidate = HighlightWindowCandidateSchema.safeParse(m.candidate);
    if (!parsedCandidate.success) {
      return { ok: false, reason: 'Clip manifest candidate invalid', corrupt: true };
    }

    // Never trust cacheKey fabricated as sha256
    if (m.clipMeta.sha256 === m.cacheKey) {
      return { ok: false, reason: 'Clip manifest contains fabricated sha256', corrupt: true };
    }

    let head: { hit: boolean; cacheKey: string; sizeBytes?: number; etag?: string };
    try {
      head = await this.cache.checkObjectAtKey(params.auth, params.clipDescriptor, m.objectKey);
    } catch {
      return { ok: false, reason: 'Clip object key outside authorized prefix', corrupt: true };
    }

    if (!head.hit || !head.sizeBytes || head.sizeBytes <= 0) {
      return { ok: false, reason: 'Clip MP4 object missing or empty in storage', corrupt: false };
    }

    if (head.sizeBytes !== m.clipMeta.sizeBytes) {
      return {
        ok: false,
        reason: `Clip MP4 size mismatch (expected ${m.clipMeta.sizeBytes}, got ${head.sizeBytes})`,
        corrupt: true,
      };
    }

    if (m.etag && head.etag && m.etag !== head.etag) {
      return {
        ok: false,
        reason: `Clip MP4 ETag mismatch (expected ${m.etag}, got ${head.etag})`,
        corrupt: true,
      };
    }

    if (params.deepVerify) {
      const bytes = await this.cache.getObjectBytesAtKey(
        params.auth,
        params.clipDescriptor,
        m.objectKey,
      );
      if (!bytes || bytes.length !== m.clipMeta.sizeBytes) {
        return { ok: false, reason: 'Clip MP4 bytes missing or truncated', corrupt: true };
      }
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== m.clipMeta.sha256) {
        return {
          ok: false,
          reason: `Clip MP4 SHA-256 mismatch (expected ${m.clipMeta.sha256}, got ${actualSha})`,
          corrupt: true,
        };
      }
      const probeDir = path.join(this.workRootDir, 'verify');
      try {
        const verifiedMeta = await probeAndValidateClipMp4FromBuffer(bytes, probeDir, {
          requireAudio: m.clipMeta.hasAudio,
          encodingMode: m.clipMeta.encodingMode,
        });
        if (verifiedMeta.sha256 !== m.clipMeta.sha256) {
          return { ok: false, reason: 'Probed clip SHA-256 mismatch', corrupt: true };
        }
      } catch (err) {
        return {
          ok: false,
          reason: `Deep ffprobe verification failed: ${err instanceof Error ? err.message : String(err)}`,
          corrupt: true,
        };
      }
    }

    return {
      ok: true,
      value: {
        ...m,
        candidate: parsedCandidate.data,
      },
      artifactRef: m.objectKey,
    };
  }

  /**
   * Coordinates shared source acquisition, CPU-first highlight analysis, FFmpeg base clip
   * extraction, and verified durable MinIO cache storage across multiple independent
   * service instances and concurrent clippers.
   */
  async requestSharedBroadcastHighlight(
    req: SharedBroadcastRequest,
  ): Promise<SharedBroadcastHighlightResult> {
    const startedAt = Date.now();

    // 0. Strict fail-closed rights & authorization check BEFORE touching Redis or MinIO!
    const auth = this.buildAuth(req.adapter, req.requesterUserId);
    const source = auth.source;
    const sourceRevision = req.sourceRevision ?? 'v1';
    const algorithmVersion = req.algorithmVersion ?? 'v1.0-heuristic';
    const renderSettings: CacheRenderSettings = {
      ...DEFAULT_BASE_CLIP_RENDER,
      ...(req.renderSettings ?? {}),
    };
    const segDur = req.bufferConfig?.segmentDurationSec ?? 6;
    const preEventSec = req.bufferConfig?.preEventSec ?? 45;
    const postEventSec = req.bufferConfig?.postEventSec ?? 15;
    const scoreThreshold = req.scoreThreshold ?? 65;
    const cooldownSec = req.cooldownSec ?? 15;

    const leaseMs = req.leaseMs ?? 30_000;
    const maxRetries = req.maxRetries ?? 3;
    const waitTimeoutMs = req.waitTimeoutMs ?? 45_000;
    const pollInitialMs = req.pollInitialMs ?? 25;
    const pollMaxMs = req.pollMaxMs ?? 200;

    // Authorize SHARED_PERMITTED scope right away (rejects unverified/private/DRM before touching Redis!)
    const sourceDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'SOURCE_SEGMENT',
      sourceRevision,
      algorithmVersion: `seg-${segDur}s`,
      rightsScope: 'SHARED_PERMITTED',
    };
    resolveAuthorizedCacheIdentity(auth, sourceDescriptor);

    const syntheticHash = req.syntheticSignals?.length
      ? stableHashShort(req.syntheticSignals, 12)
      : 'none';
    const analysisAlgoKey = `${algorithmVersion}-t${scoreThreshold}-c${cooldownSec}-p${preEventSec}-${postEventSec}-s${segDur}-${syntheticHash}`;
    const analysisDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'HIGHLIGHT_ANALYSIS',
      sourceRevision,
      algorithmVersion: analysisAlgoKey,
      rightsScope: 'SHARED_PERMITTED',
    };
    resolveAuthorizedCacheIdentity(auth, analysisDescriptor);

    const sourceWorkId = buildSourceWorkId(source.canonicalId, `${sourceRevision}_s${segDur}`);
    const analysisWorkId = buildAnalysisWorkId(source.canonicalId, {
      sourceRevision,
      algorithmVersion: analysisAlgoKey,
      scoreThreshold,
      cooldownSec,
      bufferConfig: { segmentDurationSec: segDur, preEventSec, postEventSec },
    });

    // =========================================================================
    // LAYER A: Source Acquisition & Segmentation (scoped to canonicalSourceId + sourceRevision)
    // =========================================================================
    const sourceStage = await this.runCoordinatedStage<PersistedSourceManifest>({
      workId: sourceWorkId,
      requesterId: req.requesterUserId,
      workerId: req.workerId,
      leaseMs,
      maxRetries,
      waitTimeoutMs,
      pollInitialMs,
      pollMaxMs,
      signal: req.signal,
      tryLoadVerifiedDurable: async () => {
        const loaded = await this.cache.getCachedManifest<PersistedSourceManifest>(
          auth,
          sourceDescriptor,
        );
        if (!loaded?.data || loaded.data.version !== 1 || !Array.isArray(loaded.data.segments) || loaded.data.segments.length === 0) {
          return { ok: false, reason: 'Source manifest missing or empty' };
        }
        for (const seg of loaded.data.segments) {
          const head = await this.cache.checkObjectAtKey(auth, sourceDescriptor, seg.objectKey);
          if (!head.hit || head.sizeBytes !== seg.sizeBytes) {
            return { ok: false, reason: `Source segment ${seg.index} missing or size mismatch`, corrupt: head.hit };
          }
          if (seg.etag && head.etag && seg.etag !== head.etag) {
            return { ok: false, reason: `Source segment ${seg.index} ETag mismatch`, corrupt: true };
          }
        }
        return { ok: true, value: loaded.data, artifactRef: loaded.manifestKey };
      },
      executeAsOwner: async ({ fencingToken, signal, renewNow }) => {
        const scratchDir = path.join(
          this.workRootDir,
          `src_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        );
        const buffer = new FfmpegRollingSegmentBuffer({
          workDir: path.join(scratchDir, 'segments'),
          bufferConfig: req.bufferConfig,
        });
        try {
          this.metrics.sourceProcessingCount++;
          const segments = await buffer.ingestFromSourceFile(req.adapter.fixturePath, {
            markEndOfStream: true,
            signal,
          });
          if (segments.length === 0) {
            throw new Error(`Source segmentation produced zero valid segments for ${source.canonicalId}.`);
          }
          await renewNow();

          const persistedSegments: PersistedSourceSegmentEntry[] = [];
          for (const seg of segments) {
            if (signal.aborted) {
              throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Source upload aborted.' });
            }
            const bytes = await fs.readFile(seg.filePath);
            const putRes = await this.cache.putVersionedArtifact(
              auth,
              sourceDescriptor,
              `gen-${fencingToken}-seg-${String(seg.index).padStart(6, '0')}-${seg.sha256.slice(0, 8)}.mp4`,
              bytes,
              'video/mp4',
            );
            persistedSegments.push({
              index: seg.index,
              startSec: seg.startSec,
              endSec: seg.endSec,
              durationSec: seg.durationSec,
              objectKey: putRes.objectKey,
              sizeBytes: seg.sizeBytes,
              sha256: seg.sha256,
              etag: putRes.etag,
            });
          }

          // Guard against stale worker overwriting newer source manifest
          const existing = await this.cache.getCachedManifest<PersistedSourceManifest>(
            auth,
            sourceDescriptor,
          );
          if (existing?.data && existing.data.fencingToken >= fencingToken) {
            throw new MediaSourceError({
              code: 'LEASE_EXPIRED',
              message: `Stale worker (token ${fencingToken}) refused to overwrite newer source manifest (token ${existing.data.fencingToken}).`,
            });
          }
          await renewNow();

          const manifest: PersistedSourceManifest = {
            version: 1,
            fencingToken,
            canonicalSourceId: source.canonicalId,
            sourceRevision,
            segmentDurationSec: buffer.config.segmentDurationSec,
            totalDurationSec: buffer.getLatestBufferedSec(),
            segments: persistedSegments,
          };
          const published = await this.cache.putCachedManifest(auth, sourceDescriptor, manifest);
          return { value: manifest, artifactRef: published.manifestKey };
        } finally {
          await buffer.cleanupAll();
          await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => { });
        }
      },
    });

    // =========================================================================
    // LAYER B: Source Analysis (scoped to sourceRevision + algorithm + detector options)
    // =========================================================================
    const analysisStage = await this.runCoordinatedStage<PersistedAnalysisManifest>({
      workId: analysisWorkId,
      requesterId: req.requesterUserId,
      workerId: req.workerId,
      leaseMs,
      maxRetries,
      waitTimeoutMs,
      pollInitialMs,
      pollMaxMs,
      signal: req.signal,
      tryLoadVerifiedDurable: async () => {
        const loaded = await this.cache.getCachedManifest<PersistedAnalysisManifest>(
          auth,
          analysisDescriptor,
        );
        if (!loaded?.data || loaded.data.version !== 1) {
          return { ok: false, reason: 'Analysis manifest missing' };
        }
        const parsed = HighlightWindowCandidateSchema.safeParse(loaded.data.candidate);
        if (!parsed.success) {
          return { ok: false, reason: 'Analysis manifest candidate invalid', corrupt: true };
        }
        return {
          ok: true,
          value: { ...loaded.data, candidate: parsed.data },
          artifactRef: loaded.manifestKey,
        };
      },
      executeAsOwner: async ({ fencingToken, signal, renewNow }) => {
        const scratchDir = path.join(
          this.workRootDir,
          `ana_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        );
        let buffer: FfmpegRollingSegmentBuffer | null = null;
        try {
          const hydrated = await this.hydrateBufferFromSourceManifest({
            auth,
            sourceDescriptor,
            manifest: sourceStage.value,
            workDir: path.join(scratchDir, 'segments'),
            bufferConfig: req.bufferConfig,
          });
          buffer = hydrated.buffer;
          if (signal.aborted) {
            throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Analysis aborted.' });
          }

          this.metrics.analysisPassCount++;
          const audioSignals = await extractAudioSignalsFromSegments(hydrated.segments);
          const detector = new CpuFirstHeuristicDetector({
            canonicalSourceId: source.canonicalId as CacheableSourceId,
            bufferConfig: req.bufferConfig,
            scoreThreshold,
            cooldownSec,
          });

          for (const sample of audioSignals.samples) {
            detector.ingestSignal(sample);
          }
          if (req.syntheticSignals) {
            for (const synth of req.syntheticSignals) {
              detector.ingestSignal(synth);
            }
          }

          const candidates = detector.evaluate(buffer.getLatestBufferedSec());
          if (candidates.length === 0) {
            throw new Error(`No highlight candidate detected for ${source.canonicalId}.`);
          }

          const best = [...candidates].sort((a, b) => b.compositeScore - a.compositeScore)[0];
          const clampedWindow = buffer.computeWindowForEvent(best.eventTimestampSec);
          const parsedAlgo = AlgorithmVersionSchema.safeParse(algorithmVersion);
          const candidate: HighlightWindowCandidate = {
            ...best,
            algorithmVersion: parsedAlgo.success ? parsedAlgo.data : best.algorithmVersion,
            windowStartSec: clampedWindow.windowStartSec,
            windowEndSec: clampedWindow.windowEndSec,
            pinnedSegmentIndices: clampedWindow.pinnedSegmentIndices,
          };

          const existing = await this.cache.getCachedManifest<PersistedAnalysisManifest>(
            auth,
            analysisDescriptor,
          );
          if (existing?.data && existing.data.fencingToken >= fencingToken) {
            throw new MediaSourceError({
              code: 'LEASE_EXPIRED',
              message: `Stale worker (token ${fencingToken}) refused to overwrite newer analysis manifest (token ${existing.data.fencingToken}).`,
            });
          }
          await renewNow();

          const manifest: PersistedAnalysisManifest = {
            version: 1,
            fencingToken,
            canonicalSourceId: source.canonicalId,
            sourceRevision,
            algorithmVersion,
            candidate,
            totalDurationSec: sourceStage.value.totalDurationSec,
          };
          const published = await this.cache.putCachedManifest(auth, analysisDescriptor, manifest);
          return { value: manifest, artifactRef: published.manifestKey };
        } finally {
          if (buffer) await buffer.cleanupAll();
          await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => { });
        }
      },
    });

    const candidate = analysisStage.value.candidate;

    // =========================================================================
    // LAYER C: Derived Base Clip (scoped to sourceRevision + window + algorithm + renderSettings)
    // =========================================================================
    const clipDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'BASE_CLIP',
      sourceRevision,
      timeRangeSec: { start: candidate.windowStartSec, end: candidate.windowEndSec },
      algorithmVersion,
      renderSettings,
      rightsScope: 'SHARED_PERMITTED',
    };
    const clipIdentity = resolveAuthorizedCacheIdentity(auth, clipDescriptor);
    const clipWorkId = buildClipWorkId(source.canonicalId, clipIdentity.cacheKey);

    const clipStage = await this.runCoordinatedStage<PersistedClipManifest>({
      workId: clipWorkId,
      requesterId: req.requesterUserId,
      workerId: req.workerId,
      leaseMs,
      maxRetries,
      waitTimeoutMs,
      pollInitialMs,
      pollMaxMs,
      signal: req.signal,
      skipColdCacheCheck: Boolean(req.onBeforePublishReady || req.onAfterExtractBeforeUpload),
      tryLoadVerifiedDurable: async ({ expectedArtifactRef, deepVerify }) =>
        this.loadAndVerifyClipManifest({
          auth,
          clipDescriptor,
          expectedArtifactRef,
          deepVerify: deepVerify || req.verifyMediaIntegrity === true,
        }),
      executeAsOwner: async ({ fencingToken, signal, renewNow }) => {
        const scratchDir = path.join(
          this.workRootDir,
          `clip_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        );
        let buffer: FfmpegRollingSegmentBuffer | null = null;
        try {
          const hydrated = await this.hydrateBufferFromSourceManifest({
            auth,
            sourceDescriptor,
            manifest: sourceStage.value,
            workDir: path.join(scratchDir, 'segments'),
            bufferConfig: req.bufferConfig,
            windowRange: { startSec: candidate.windowStartSec, endSec: candidate.windowEndSec },
          });
          buffer = hydrated.buffer;

          if (signal.aborted) {
            throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Clip extraction aborted.' });
          }

          this.metrics.ffmpegClipRenderCount++;
          const outClipPath = path.join(scratchDir, 'highlight.mp4');
          const videoFilter = computeVideoFilterForRenderSettings(renderSettings);
          const clipMeta = await extractAndVerifyHighlightClip({
            buffer,
            windowStartSec: candidate.windowStartSec,
            windowEndSec: candidate.windowEndSec,
            outputPath: outClipPath,
            preferStreamCopy: !videoFilter,
            videoFilter,
            requireAudio: true,
            signal,
          });

          if (req.onAfterExtractBeforeUpload) {
            await req.onAfterExtractBeforeUpload(outClipPath, { fencingToken, workId: clipWorkId });
          }

          if (signal.aborted) {
            throw new MediaSourceError({
              code: 'REQUEST_CANCELLED',
              message: 'Clip upload aborted after extraction.',
            });
          }

          // Upload immutable versioned MP4 BEFORE updating manifest (preserves previous healthy object on failure)
          const mp4Bytes = await fs.readFile(outClipPath);
          const versionTag = `gen-${fencingToken}-${clipMeta.sha256.slice(0, 12)}.mp4`;
          const storedObj = await this.cache.putVersionedArtifact(
            auth,
            clipDescriptor,
            versionTag,
            mp4Bytes,
            'video/mp4',
          );

          // Optional test hook right before manifest publication & READY
          if (req.onBeforePublishReady) {
            await req.onBeforePublishReady({
              fencingToken,
              workerId: req.workerId,
              workId: clipWorkId,
              objectKey: storedObj.objectKey,
            });
          }

          // 1. Check active Redis lease ownership BEFORE atomic manifest write
          await renewNow();

          // 2. Monotonic fencing guard on existing manifest (stale worker NEVER overwrites newer artifact!)
          const existingManifest = await this.cache.getCachedManifest<PersistedClipManifest>(
            auth,
            clipDescriptor,
          );
          if (existingManifest?.data && existingManifest.data.fencingToken >= fencingToken) {
            throw new MediaSourceError({
              code: 'LEASE_EXPIRED',
              message: `Stale worker (token ${fencingToken}) refused to overwrite newer clip manifest (token ${existingManifest.data.fencingToken}).`,
            });
          }

          const verifiedClipMeta: ProbedClipMetadata = {
            ...clipMeta,
            filePath: '(persisted-in-storage)',
          };
          const manifest: PersistedClipManifest = {
            version: 1,
            fencingToken,
            canonicalSourceId: source.canonicalId,
            sourceRevision,
            algorithmVersion,
            cacheKey: clipIdentity.cacheKey,
            objectKey: storedObj.objectKey,
            etag: storedObj.etag,
            candidate,
            clipMeta: verifiedClipMeta,
            createdAtMs: Date.now(),
          };

          // Atomic consumer cutover: write verified manifest pointing to immutable MP4
          await this.cache.putCachedManifest(auth, clipDescriptor, manifest);

          return { value: manifest, artifactRef: storedObj.objectKey };
        } finally {
          if (buffer) await buffer.cleanupAll();
          await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => { });
        }
      },
    });

    if (clipStage.cacheHit) {
      this.metrics.cacheHits++;
    }

    const downloadUrl = await this.cache.createAuthorizedDownloadUrlForObject(
      auth,
      clipDescriptor,
      clipStage.value.objectKey,
    );

    return {
      canonicalSourceId: source.canonicalId,
      workIds: {
        sourceWorkId,
        analysisWorkId,
        clipWorkId,
      },
      coordinationAction: clipStage.action,
      cacheHit: clipStage.cacheHit,
      cacheKey: clipStage.value.cacheKey,
      objectKey: clipStage.value.objectKey,
      descriptor: clipDescriptor,
      downloadUrl,
      candidate: clipStage.value.candidate,
      clipMeta: clipStage.value.clipMeta,
      sizeBytes: clipStage.value.clipMeta.sizeBytes,
      fencingToken: clipStage.value.fencingToken,
      processingMs: Date.now() - startedAt,
    };
  }

  /**
   * Authorizes and issues a short-lived signed download URL for an existing cached clip
   * without spawning FFmpeg or re-processing source bytes.
   *
   * When `verifyExistsInStorage !== false`, validates the persisted manifest (if present)
   * and object metadata/ETag so missing or corrupt objects are never served.
   */
  async requestAuthorizedCachedClipDownload(input: {
    adapter: ControlledLocalStreamAdapter;
    requesterUserId: string;
    descriptor: CacheArtifactDescriptor;
    ownerUserId?: string;
    /** Optional known immutable objectKey (still strictly validated against authorized descriptor prefix). */
    objectKey?: string;
    verifyExistsInStorage?: boolean;
    verifyMediaIntegrity?: boolean;
    expiresIn?: number;
  }): Promise<{ cacheKey: string; objectKey: string; downloadUrl: string; sizeBytes?: number }> {
    const auth = this.buildAuth(input.adapter, input.requesterUserId, input.ownerUserId);
    const identity = resolveAuthorizedCacheIdentity(auth, input.descriptor);
    let targetObjectKey = input.objectKey ?? identity.storageKey;
    let sizeBytes: number | undefined;

    if (input.verifyExistsInStorage !== false) {
      const manifestLoaded = await this.cache.getCachedManifest<PersistedClipManifest>(
        auth,
        input.descriptor,
      );
      if (manifestLoaded?.data) {
        const verified = await this.loadAndVerifyClipManifest({
          auth,
          clipDescriptor: input.descriptor,
          deepVerify: input.verifyMediaIntegrity === true,
        });
        if (!verified.ok) {
          if (verified.corrupt) {
            this.metrics.corruptArtifactsDetected++;
          }
          throw new MediaSourceError({
            code: 'ARTIFACT_CORRUPT',
            message: `Cached clip failed verification (${verified.reason}) for key ${identity.cacheKey}.`,
          });
        }
        targetObjectKey = verified.value.objectKey;
        sizeBytes = verified.value.clipMeta.sizeBytes;
      } else {
        const check = await this.cache.checkObjectAtKey(auth, input.descriptor, targetObjectKey);
        if (!check.hit || (check.sizeBytes ?? 0) === 0) {
          throw new MediaSourceError({
            code: 'SOURCE_UNAVAILABLE',
            message: `Cached clip missing or empty for key ${identity.cacheKey}.`,
          });
        }
        sizeBytes = check.sizeBytes;
      }
    }

    const downloadUrl = await this.cache.createAuthorizedDownloadUrlForObject(
      auth,
      input.descriptor,
      targetObjectKey,
      { expiresIn: input.expiresIn ?? 900 },
    );
    this.metrics.cacheHits++;
    return {
      cacheKey: identity.cacheKey,
      objectKey: targetObjectKey,
      downloadUrl,
      sizeBytes,
    };
  }

  /**
   * Renders a private user-specific personalized edit derived from a shared broadcast.
   * Stored strictly under `PRIVATE_USER` (`cache/private/<ownerUserId>/...`), isolated from other users.
   */
  async renderPrivateUserEdit(req: PrivateEditRequest): Promise<{
    cacheKey: string;
    descriptor: CacheArtifactDescriptor;
    clipMeta: ProbedClipMetadata;
    downloadUrl: string;
  }> {
    const auth = this.buildAuth(req.adapter, req.requesterUserId, req.ownerUserId);
    const scratchDir = path.join(
      this.workRootDir,
      `priv_${req.ownerUserId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    );
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir: path.join(scratchDir, 'segments'),
      bufferConfig: req.bufferConfig,
    });

    try {
      await buffer.ingestFromSourceFile(req.adapter.fixturePath, {
        markEndOfStream: true,
        signal: req.signal,
      });
      const outPath = path.join(scratchDir, 'private-edit.mp4');
      const clipMeta = await extractAndVerifyHighlightClip({
        buffer,
        windowStartSec: req.windowStartSec,
        windowEndSec: req.windowEndSec,
        outputPath: outPath,
        preferStreamCopy: !req.videoFilter,
        videoFilter: req.videoFilter,
        requireAudio: true,
        signal: req.signal,
      });

      const descriptor: CacheArtifactDescriptor = {
        artifactKind: 'BASE_CLIP',
        sourceRevision: req.sourceRevision ?? 'v1',
        timeRangeSec: { start: req.windowStartSec, end: req.windowEndSec },
        algorithmVersion: 'private-edit-v1',
        renderSettings: {
          ...DEFAULT_BASE_CLIP_RENDER,
          width: clipMeta.width,
          height: clipMeta.height,
          customEditHash: req.customEditHash,
        },
        rightsScope: 'PRIVATE_USER',
      };

      const bytes = await fs.readFile(outPath);
      const stored = await this.cache.putCachedArtifact(auth, descriptor, bytes, 'video/mp4');
      const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, descriptor);
      return { cacheKey: stored.cacheKey, descriptor, clipMeta, downloadUrl };
    } finally {
      await buffer.cleanupAll();
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => { });
    }
  }
}
