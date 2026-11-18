import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AlgorithmVersionSchema,
  HighlightWindowCandidateSchema,
  type CacheRenderSettings,
  type CacheRightsScope,
  type CacheableSourceId,
  type HighlightDetectionSample,
  type HighlightWindowCandidate,
  type RollingBufferConfig,
} from '@autoedit/contracts';
import type { PrismaClient, SharedCacheArtifact } from '@prisma/client';
import type { MediaStorageProvider } from '../storage/storage.types.js';
import { MediaSourceError } from './errors.js';
import { CpuFirstHeuristicDetector } from './highlight-detector.js';
import {
  SharedIngestionCoordinator,
  buildAnalysisWorkId,
  buildClipWorkId,
  buildSourceWorkId,
} from './ingestion-coordinator.js';
import {
  resolveAuthorizedCacheIdentity,
  type CacheArtifactDescriptor,
} from './shared-cache.js';
import { DurableMediaRegistryService } from './durable-media-registry.js';
import {
  DurableArtifactPublisher,
  type AuthorizedPublishedArtifactResult,
} from './durable-artifact-publisher.js';
import { FfmpegRollingSegmentBuffer, type BufferedMediaSegment } from './live/rolling-segment-buffer.js';
import { extractAudioSignalsFromSegments } from './live/audio-signal-extractor.js';
import {
  extractAndVerifyHighlightClip,
  type ProbedClipMetadata,
} from './live/highlight-clip-extractor.js';

export interface DurableClipPipelineRequest {
  /** Immutable canonical source ID already registered in PostgreSQL MediaSource (live broadcast, VOD, or upload). */
  canonicalSourceId: CacheableSourceId;
  /** Authenticated requester user ID (resolved from auth middleware). */
  requesterUserId: string;
  /** Worker identifier for lease & PostgreSQL attempt tracking. */
  workerId: string;
  /** Local controlled fixture file path (used ONLY by test/acquisition worker when generating missing source segments). */
  fixturePath: string;
  sourceRevision?: string;
  algorithmVersion?: string;
  rightsScope?: CacheRightsScope;
  bufferConfig?: Partial<RollingBufferConfig>;
  renderSettings?: CacheRenderSettings;
  scoreThreshold?: number;
  cooldownSec?: number;
  syntheticSignals?: HighlightDetectionSample[];
  leaseMs?: number;
  waitTimeoutMs?: number;
  pollInitialMs?: number;
  pollMaxMs?: number;
  signal?: AbortSignal;
  verifyMediaIntegrity?: boolean;
  /** Optional test hook executed right after MP4 upload and BEFORE PostgreSQL CAS commit. */
  onBeforeClipCommit?: (ctx: {
    artifactId: string;
    attemptId: string;
    generation: number;
    objectKey: string;
    cacheKey: string;
    clipWorkId: CacheableSourceId;
  }) => Promise<void>;
  /** Optional test hook executed inside the PostgreSQL CAS commit transaction (to test real DB rollback). */
  onInsideCommitTx?: () => Promise<void>;
}

export interface DurableClipPipelineResult {
  canonicalSourceId: string;
  cacheKey: string;
  objectKey: string;
  publishedGeneration: number;
  contentSha256: string;
  sizeBytes: number;
  descriptor: CacheArtifactDescriptor;
  candidate: HighlightWindowCandidate;
  clipMeta: ProbedClipMetadata;
  downloadUrl: string;
  reusedFromDbCache: boolean;
  processingMs: number;
}

export interface DurablePipelineMetrics {
  sourceProcessingCount: number;
  analysisPassCount: number;
  ffmpegClipRenderCount: number;
  dbCacheHits: number;
  repairCount: number;
  casRejections: number;
}

interface PersistedSourceSegmentPayload {
  version: 1;
  segmentDurationSec: number;
  totalDurationSec: number;
  segments: Array<{
    index: number;
    startSec: number;
    endSec: number;
    durationSec: number;
    objectKey: string;
    sizeBytes: number;
    sha256: string;
    etag?: string;
  }>;
}

interface PersistedAnalysisPayload {
  version: 1;
  candidate: HighlightWindowCandidate;
  totalDurationSec: number;
}

const DEFAULT_RENDER: CacheRenderSettings = {
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
      new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Request cancelled.' }),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Request cancelled.' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function stableShortHash(v: unknown, len = 12): string {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, len);
}

function computeVideoFilter(renderSettings: CacheRenderSettings): string | undefined {
  const needsScale = renderSettings.width !== 1280 || renderSettings.height !== 720;
  const needsFps = renderSettings.fps !== 30;
  if (!needsScale && !needsFps && !renderSettings.zooms && !renderSettings.subtitles) {
    return undefined;
  }
  const filters: string[] = [];
  if (needsScale) filters.push(`scale=${renderSettings.width}:${renderSettings.height}`);
  else if (renderSettings.zooms) {
    filters.push(`crop=iw*0.95:ih*0.95,scale=${renderSettings.width}:${renderSettings.height}`);
  }
  if (needsFps) filters.push(`fps=${renderSettings.fps}`);
  if (filters.length === 0 && renderSettings.subtitles) {
    filters.push(`scale=${renderSettings.width}:${renderSettings.height}`);
  }
  return filters.length > 0 ? filters.join(',') : undefined;
}

/**
 * End-to-end 3-stage pipeline (SOURCE → ANALYSIS → BASE CLIP) backed by:
 * - PostgreSQL (DurableMediaRegistryService + DurableArtifactPublisher): authoritative source
 *   identity, server-verified rights & revocation, monotonic generations, and transactional CAS.
 * - Redis (SharedIngestionCoordinator): fast-path coordination preventing DB contention across
 *   high-fanout concurrent clippers (never the permanent source of truth).
 * - MinIO/S3 (MediaStorageProvider): immutable versioned objects + short-lived signed URLs.
 */
export class DurableSharedClipService {
  readonly registry: DurableMediaRegistryService;
  readonly publisher: DurableArtifactPublisher;
  readonly metrics: DurablePipelineMetrics = {
    sourceProcessingCount: 0,
    analysisPassCount: 0,
    ffmpegClipRenderCount: 0,
    dbCacheHits: 0,
    repairCount: 0,
    casRejections: 0,
  };

  /** In-flight-only read coalescer (deleted immediately in finally; zero TTL caching). */
  private readonly inflightStageCoalescer = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: PrismaClient,
    private readonly coordinator: SharedIngestionCoordinator,
    private readonly storage: MediaStorageProvider,
    private readonly workRootDir: string,
  ) {
    this.registry = new DurableMediaRegistryService(db);
    this.publisher = new DurableArtifactPublisher(
      db,
      this.registry,
      storage,
      path.join(workRootDir, 'probe'),
    );
  }

  private async coalesceInflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflightStageCoalescer.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => {
      this.inflightStageCoalescer.delete(key);
    });
    this.inflightStageCoalescer.set(key, p);
    return p;
  }

  /**
   * Coordinates one durable stage across Redis (fast path) and PostgreSQL CAS (authoritative truth).
   * Handles:
   * - Immediate DB+MinIO reuse without FFmpeg (including across Redis restarts/evictions)
   * - Single-winner concurrent repair when a published object is missing or corrupt in MinIO
   * - Transactional PostgreSQL CAS promotion rejecting stale workers even after Redis wipe
   * - Preservation of previously published valid version on failed replacement or DB rollback
   */
  private async runDurableStage<TMeta extends Record<string, unknown>>(params: {
    canonicalSourceId: CacheableSourceId;
    requesterUserId: string;
    workerId: string;
    workId: CacheableSourceId;
    descriptor: CacheArtifactDescriptor;
    leaseMs: number;
    waitTimeoutMs: number;
    pollInitialMs: number;
    pollMaxMs: number;
    signal?: AbortSignal;
    verifyMediaIntegrity?: boolean;
    skipFastRead?: boolean;
    produceArtifact: (ctx: {
      artifactId: string;
      attemptId: string;
      generation: number;
      signal: AbortSignal;
    }) => Promise<{
      body: Buffer;
      contentType: string;
      fileExt: string;
      mediaMetadata: TMeta;
      onBeforeCommit?: (uploaded: { objectKey: string; cacheKey: string }) => Promise<void>;
      onInsideCommitTx?: () => Promise<void>;
    }>;
  }): Promise<{
    artifact: SharedCacheArtifact;
    published: AuthorizedPublishedArtifactResult;
    reusedFromDbCache: boolean;
  }> {
    const deadlineMs = Date.now() + params.waitTimeoutMs;
    let delayMs = params.pollInitialMs;

    while (true) {
      if (params.signal?.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: `Durable stage ${params.workId} cancelled.`,
        });
      }
      if (Date.now() > deadlineMs) {
        throw new MediaSourceError({
          code: 'COORDINATION_TIMEOUT',
          message: `Timed out waiting for durable stage ${params.workId}.`,
          retryable: true,
        });
      }

      // 1. Authoritative PostgreSQL + MinIO check (coalesced in-flight for high fanout;
      //    returns exact observed publishedGeneration so concurrent repairs cannot double-trigger!)
      let missingOrCorruptGen: number | undefined;
      if (!params.skipFastRead) {
        const checkKey = `inspect::${params.canonicalSourceId}::${params.descriptor.artifactKind}::${params.descriptor.rightsScope}::${params.descriptor.rightsScope === 'PRIVATE_USER' ? params.requesterUserId : 'shared'}::${params.workId}::${Boolean(params.verifyMediaIntegrity)}`;
        const inspected = await this.coalesceInflight(checkKey, () =>
          this.publisher.inspectAuthorizedPublishedArtifact({
            requesterUserId: params.requesterUserId,
            canonicalSourceId: params.canonicalSourceId,
            descriptor: params.descriptor,
            verifyInStorage: true,
            verifyMediaIntegrity: params.verifyMediaIntegrity,
          }),
        );

        if (inspected.status === 'PUBLISHED_VALID') {
          this.metrics.dbCacheHits++;
          return {
            artifact: inspected.result.artifact,
            published: inspected.result,
            reusedFromDbCache: true,
          };
        }
        if (inspected.status === 'MISSING_OR_CORRUPT') {
          missingOrCorruptGen = inspected.publishedGeneration;
        }
      }

      // 2. Fast-path Redis coordination (for non-repair initial fan-in across 1,000 clippers!)
      let redisToken: number | null = null;
      if (missingOrCorruptGen === undefined && !params.skipFastRead) {
        try {
          const coord = await this.coordinator.requestIngestion({
            canonicalSourceId: params.workId,
            requesterId: params.requesterUserId,
            workerId: params.workerId,
            leaseMs: params.leaseMs,
            maxRetries: 5,
          });
          if (coord.action === 'REUSE_READY') {
            // Redis says READY -> immediately loop back to Step 1 to read & verify from PostgreSQL + MinIO
            await sleepAbortable(Math.min(25, Math.max(5, deadlineMs - Date.now())), params.signal);
            continue;
          }
          if (coord.action === 'ATTACH_EXISTING') {
            // Poll Redis state coalesced (zero PostgreSQL queries while waiting for active Redis owner!)
            let waitDelay = params.pollInitialMs;
            while (Date.now() <= deadlineMs) {
              await sleepAbortable(
                Math.min(waitDelay, Math.max(10, deadlineMs - Date.now())),
                params.signal,
              );
              waitDelay = Math.min(params.pollMaxMs, Math.ceil(waitDelay * 1.5));
              const rec = await this.coalesceInflight(`redis_get::${params.workId}`, () =>
                this.coordinator.getState(params.workId),
              );
              if (
                !rec ||
                rec.state === 'READY' ||
                rec.state === 'FAILED' ||
                rec.state === 'EXPIRED' ||
                rec.leaseExpiresAtMs <= Date.now()
              ) {
                break;
              }
            }
            continue;
          }
          if (coord.action === 'ACQUIRED_NEW' || coord.action === 'ACQUIRED_RECOVERY') {
            redisToken = coord.fencingToken;
          }
        } catch {
          // Redis is fast coordination only — fall through to PostgreSQL authoritative reservation if Redis is unavailable!
        }
      }

      // 3. Authoritative PostgreSQL Generation Reservation (SELECT ... FOR UPDATE)
      const reserved = await this.publisher.reservePublicationGeneration({
        requesterUserId: params.requesterUserId,
        canonicalSourceId: params.canonicalSourceId,
        descriptor: params.descriptor,
        workerId: params.workerId,
        leaseMs: params.leaseMs,
        forceRepair: missingOrCorruptGen !== undefined || Boolean(params.skipFastRead),
        expectedPublishedGeneration: missingOrCorruptGen,
      });

      if (reserved.action === 'ALREADY_PUBLISHED') {
        if (redisToken !== null) {
          await this.coordinator
            .markReady({
              canonicalSourceId: params.workId,
              workerId: params.workerId,
              fencingToken: redisToken,
              artifactRef: reserved.artifact.publishedObjectKey ?? reserved.cacheKey,
            })
            .catch(() => {});
        }
        // Loop back to Step 1 to verify & return the published artifact cleanly
        continue;
      }

      if (reserved.action === 'ALREADY_IN_PROGRESS') {
        if (redisToken !== null) {
          await this.coordinator
            .releaseLease({
              canonicalSourceId: params.workId,
              workerId: params.workerId,
              fencingToken: redisToken,
            })
            .catch(() => {});
        }
        await sleepAbortable(Math.min(delayMs, Math.max(10, deadlineMs - Date.now())), params.signal);
        delayMs = Math.min(params.pollMaxMs, Math.ceil(delayMs * 1.5));
        continue;
      }

      // 4. This worker holds authoritative PostgreSQL reservation (generation = reserved.generation)!
      if (missingOrCorruptGen !== undefined) {
        this.metrics.repairCount++;
      }

      const ownerAbort = new AbortController();
      let hbStopped = false;
      let hbTimer: NodeJS.Timeout | null = null;
      const onCallerAbort = () => ownerAbort.abort(new Error('Cancelled'));
      if (params.signal) {
        if (params.signal.aborted) onCallerAbort();
        else params.signal.addEventListener('abort', onCallerAbort, { once: true });
      }

      const hbInterval = Math.max(200, Math.floor(params.leaseMs / 3));
      const scheduleHb = () => {
        if (hbStopped || ownerAbort.signal.aborted) return;
        hbTimer = setTimeout(async () => {
          if (hbStopped || ownerAbort.signal.aborted) return;
          try {
            await this.publisher.renewAttemptLease({
              artifactId: reserved.artifactId,
              attemptId: reserved.attemptId,
              workerId: params.workerId,
              leaseMs: params.leaseMs,
            });
            if (redisToken !== null) {
              await this.coordinator
                .renewLease({
                  canonicalSourceId: params.workId,
                  workerId: params.workerId,
                  fencingToken: redisToken,
                  leaseMs: params.leaseMs,
                })
                .catch(() => {});
            }
            scheduleHb();
          } catch (err) {
            ownerAbort.abort(err);
          }
        }, hbInterval);
        hbTimer.unref?.();
      };
      const stopHb = () => {
        hbStopped = true;
        if (hbTimer) {
          clearTimeout(hbTimer);
          hbTimer = null;
        }
        params.signal?.removeEventListener('abort', onCallerAbort);
      };

      scheduleHb();

      try {
        const produced = await params.produceArtifact({
          artifactId: reserved.artifactId,
          attemptId: reserved.attemptId,
          generation: reserved.generation,
          signal: ownerAbort.signal,
        });

        if (params.signal?.aborted) {
          throw new MediaSourceError({
            code: 'REQUEST_CANCELLED',
            message: `Worker cancelled before uploading ${params.workId}.`,
          });
        }

        // 5. Upload immutable versioned object to MinIO & record on attempt
        const uploaded = await this.publisher.uploadImmutableAttemptObject({
          requesterUserId: params.requesterUserId,
          canonicalSourceId: params.canonicalSourceId,
          descriptor: params.descriptor,
          artifactId: reserved.artifactId,
          attemptId: reserved.attemptId,
          generation: reserved.generation,
          workerId: params.workerId,
          body: produced.body,
          contentType: produced.contentType,
          fileExt: produced.fileExt,
        });

        if (produced.onBeforeCommit) {
          await produced.onBeforeCommit({
            objectKey: uploaded.objectKey,
            cacheKey: reserved.cacheKey,
          });
        }

        if (params.signal?.aborted) {
          throw new MediaSourceError({
            code: 'REQUEST_CANCELLED',
            message: `Worker cancelled before PostgreSQL CAS commit for ${params.workId}.`,
          });
        }

        // 6. Atomic PostgreSQL CAS promotion!
        stopHb();
        const promoted = await this.publisher.commitPublishedArtifact({
          requesterUserId: params.requesterUserId,
          canonicalSourceId: params.canonicalSourceId,
          descriptor: params.descriptor,
          artifactId: reserved.artifactId,
          attemptId: reserved.attemptId,
          generation: reserved.generation,
          workerId: params.workerId,
          objectKey: uploaded.objectKey,
          contentSha256: uploaded.contentSha256,
          etag: uploaded.etag,
          sizeBytes: uploaded.sizeBytes,
          mimeType: produced.contentType,
          mediaMetadata: produced.mediaMetadata,
          onBeforeCommitInsideTx: produced.onInsideCommitTx,
        });

        // Update Redis fast-path best-effort (PostgreSQL is already authoritative!)
        if (redisToken !== null) {
          await this.coordinator
            .markReady({
              canonicalSourceId: params.workId,
              workerId: params.workerId,
              fencingToken: redisToken,
              artifactRef: uploaded.objectKey,
            })
            .catch(() => {});
        }

        const published = await this.publisher.getAuthorizedPublishedArtifact({
          requesterUserId: params.requesterUserId,
          canonicalSourceId: params.canonicalSourceId,
          descriptor: params.descriptor,
          verifyInStorage: false, // just uploaded & committed
        });

        return {
          artifact: promoted,
          published,
          reusedFromDbCache: false,
        };
      } catch (err) {
        stopHb();
        const isCasReject = err instanceof MediaSourceError && err.code === 'LEASE_EXPIRED';
        const isCancelled = err instanceof MediaSourceError && err.code === 'REQUEST_CANCELLED';
        if (isCasReject) {
          this.metrics.casRejections++;
        } else {
          await this.publisher
            .abortPublicationAttempt({
              artifactId: reserved.artifactId,
              attemptId: reserved.attemptId,
              workerId: params.workerId,
              reason: err instanceof Error ? err.message : String(err),
              cancelled: isCancelled,
            })
            .catch(() => {});
        }
        if (redisToken !== null) {
          await this.coordinator
            .markFailed({
              canonicalSourceId: params.workId,
              workerId: params.workerId,
              fencingToken: redisToken,
              error: err instanceof Error ? err.message : String(err),
            })
            .catch(() => {});
        }
        throw err;
      } finally {
        stopHb();
      }
    }
  }

  /**
   * Executes the full 3-stage pipeline (SOURCE → ANALYSIS → BASE_CLIP) backed by
   * PostgreSQL server-authoritative MediaSource rights & transactional CAS publication.
   */
  async requestDurableClip(req: DurableClipPipelineRequest): Promise<DurableClipPipelineResult> {
    const startedAt = Date.now();
    const sourceRevision = req.sourceRevision ?? 'v1';
    const algorithmVersion = req.algorithmVersion ?? 'v1.0-heuristic';
    const renderSettings: CacheRenderSettings = { ...DEFAULT_RENDER, ...(req.renderSettings ?? {}) };
    const segDur = req.bufferConfig?.segmentDurationSec ?? 5;
    const preEventSec = req.bufferConfig?.preEventSec ?? 6;
    const postEventSec = req.bufferConfig?.postEventSec ?? 4;
    const scoreThreshold = req.scoreThreshold ?? 65;
    const cooldownSec = req.cooldownSec ?? 15;
    const leaseMs = req.leaseMs ?? 30_000;
    const waitTimeoutMs = req.waitTimeoutMs ?? 60_000;
    const pollInitialMs = req.pollInitialMs ?? 30;
    const pollMaxMs = req.pollMaxMs ?? 200;

    // 0. Server-authoritative rights check BEFORE touching Redis/MinIO/FFmpeg
    //    (coalesce simultaneous in-flight DB reads for non-upload shared sources so 1,000 concurrent
    //    clippers stay O(1) bounded on PostgreSQL connections while still verifying fresh DB rights!)
    const authCoalesceKey =
      req.rightsScope === 'PRIVATE_USER' || req.canonicalSourceId.startsWith('upload:')
        ? `auth::priv::${req.canonicalSourceId}::${req.requesterUserId}`
        : `auth::shared::${req.canonicalSourceId}::${req.rightsScope ?? 'auto'}`;
    const resolvedAuth = await this.coalesceInflight(authCoalesceKey, () =>
      this.registry.resolveServerTrustedAuth({
        requesterUserId: req.requesterUserId,
        canonicalSourceId: req.canonicalSourceId,
        requireSharedReuse: req.rightsScope === 'SHARED_PERMITTED',
        requireAcquisition: true,
      }),
    );

    const effectiveScope: CacheRightsScope =
      req.rightsScope ??
      (resolvedAuth.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED');

    if (effectiveScope === 'SHARED_PERMITTED' && !resolvedAuth.allowSharedReuse) {
      throw new MediaSourceError({
        code: 'RIGHTS_UNVERIFIED',
        message: `Shared cache reuse not authorized for ${req.canonicalSourceId}.`,
      });
    }

    // =========================================================================
    // LAYER A: SOURCE_SEGMENT
    // =========================================================================
    const sourceDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'SOURCE_SEGMENT',
      sourceRevision,
      algorithmVersion: `seg-${segDur}s`,
      rightsScope: effectiveScope,
    };
    const sourceWorkId = buildSourceWorkId(
      req.canonicalSourceId,
      `${sourceRevision}_s${segDur}_${effectiveScope === 'PRIVATE_USER' ? req.requesterUserId : 'sh'}`,
    );

    const sourceStage = await this.runDurableStage<Record<string, unknown>>({
      canonicalSourceId: req.canonicalSourceId,
      requesterUserId: req.requesterUserId,
      workerId: req.workerId,
      workId: sourceWorkId,
      descriptor: sourceDescriptor,
      leaseMs,
      waitTimeoutMs,
      pollInitialMs,
      pollMaxMs,
      signal: req.signal,
      produceArtifact: async ({ generation, signal }) => {
        const scratchDir = path.join(
          this.workRootDir,
          `dsrc_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        const buffer = new FfmpegRollingSegmentBuffer({
          workDir: path.join(scratchDir, 'segments'),
          bufferConfig: req.bufferConfig,
        });
        try {
          this.metrics.sourceProcessingCount++;
          const segments = await buffer.ingestFromSourceFile(req.fixturePath, {
            markEndOfStream: true,
            signal,
          });
          const uploadedSegs: PersistedSourceSegmentPayload['segments'] = [];
          for (const seg of segments) {
            const segBytes = await fs.readFile(seg.filePath);
            const put = await this.publisher.cache.putVersionedArtifact(
              resolvedAuth.auth,
              sourceDescriptor,
              `gen-${generation}-seg-${String(seg.index).padStart(6, '0')}-${seg.sha256.slice(0, 8)}.mp4`,
              segBytes,
              'video/mp4',
            );
            uploadedSegs.push({
              index: seg.index,
              startSec: seg.startSec,
              endSec: seg.endSec,
              durationSec: seg.durationSec,
              objectKey: put.objectKey,
              sizeBytes: seg.sizeBytes,
              sha256: seg.sha256,
              etag: put.etag,
            });
          }
          const payload: PersistedSourceSegmentPayload = {
            version: 1,
            segmentDurationSec: buffer.config.segmentDurationSec,
            totalDurationSec: buffer.getLatestBufferedSec(),
            segments: uploadedSegs,
          };
          return {
            body: Buffer.from(JSON.stringify(payload), 'utf-8'),
            contentType: 'application/json',
            fileExt: 'json',
            mediaMetadata: payload as unknown as Record<string, unknown>,
          };
        } finally {
          await buffer.cleanupAll();
          await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    });

    const sourcePayload = sourceStage.published.mediaMetadata as unknown as PersistedSourceSegmentPayload;

    // =========================================================================
    // LAYER B: HIGHLIGHT_ANALYSIS
    // =========================================================================
    const synthHash = req.syntheticSignals?.length ? stableShortHash(req.syntheticSignals, 8) : 'none';
    const analysisAlgoKey = `${algorithmVersion}-t${scoreThreshold}-c${cooldownSec}-p${preEventSec}-${postEventSec}-s${segDur}-${synthHash}`;
    const analysisDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'HIGHLIGHT_ANALYSIS',
      sourceRevision,
      algorithmVersion: analysisAlgoKey,
      rightsScope: effectiveScope,
    };
    const analysisWorkId = buildAnalysisWorkId(req.canonicalSourceId, {
      sourceRevision,
      algorithmVersion: `${analysisAlgoKey}_${effectiveScope === 'PRIVATE_USER' ? req.requesterUserId : 'sh'}`,
      scoreThreshold,
      cooldownSec,
      bufferConfig: { segmentDurationSec: segDur, preEventSec, postEventSec },
    });

    const analysisStage = await this.runDurableStage<Record<string, unknown>>({
      canonicalSourceId: req.canonicalSourceId,
      requesterUserId: req.requesterUserId,
      workerId: req.workerId,
      workId: analysisWorkId,
      descriptor: analysisDescriptor,
      leaseMs,
      waitTimeoutMs,
      pollInitialMs,
      pollMaxMs,
      signal: req.signal,
      produceArtifact: async () => {
        const scratchDir = path.join(
          this.workRootDir,
          `dana_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        const segDir = path.join(scratchDir, 'segments');
        await fs.mkdir(segDir, { recursive: true });
        const buffer = new FfmpegRollingSegmentBuffer({
          workDir: segDir,
          bufferConfig: req.bufferConfig,
        });
        try {
          const hydrated: BufferedMediaSegment[] = [];
          for (const s of sourcePayload.segments) {
            const bytes = await this.publisher.cache.getObjectBytesAtKey(
              resolvedAuth.auth,
              sourceDescriptor,
              s.objectKey,
            );
            if (!bytes) throw new Error(`Missing source segment ${s.objectKey}`);
            const localPath = path.join(segDir, `seg_${String(s.index).padStart(6, '0')}.mp4`);
            await fs.writeFile(localPath, bytes);
            const seg: BufferedMediaSegment = {
              index: s.index,
              filePath: localPath,
              startSec: s.startSec,
              endSec: s.endSec,
              durationSec: s.durationSec,
              sizeBytes: s.sizeBytes,
              sha256: s.sha256,
              valid: true,
            };
            buffer.registerVerifiedSegment(seg);
            hydrated.push(seg);
          }
          buffer.markEndOfStream();

          this.metrics.analysisPassCount++;
          const audioSignals = await extractAudioSignalsFromSegments(hydrated);
          const detector = new CpuFirstHeuristicDetector({
            canonicalSourceId: req.canonicalSourceId,
            bufferConfig: req.bufferConfig,
            scoreThreshold,
            cooldownSec,
          });
          for (const sample of audioSignals.samples) detector.ingestSignal(sample);
          if (req.syntheticSignals) {
            for (const synth of req.syntheticSignals) detector.ingestSignal(synth);
          }
          const candidates = detector.evaluate(buffer.getLatestBufferedSec());
          if (candidates.length === 0) {
            throw new Error(`No highlight candidate detected for ${req.canonicalSourceId}.`);
          }
          const best = [...candidates].sort((a, b) => b.compositeScore - a.compositeScore)[0];
          const win = buffer.computeWindowForEvent(best.eventTimestampSec);
          const parsedAlgo = AlgorithmVersionSchema.safeParse(algorithmVersion);
          const candidate: HighlightWindowCandidate = HighlightWindowCandidateSchema.parse({
            ...best,
            algorithmVersion: parsedAlgo.success ? parsedAlgo.data : best.algorithmVersion,
            windowStartSec: win.windowStartSec,
            windowEndSec: win.windowEndSec,
            pinnedSegmentIndices: win.pinnedSegmentIndices,
          });

          const payload: PersistedAnalysisPayload = {
            version: 1,
            candidate,
            totalDurationSec: sourcePayload.totalDurationSec,
          };
          return {
            body: Buffer.from(JSON.stringify(payload), 'utf-8'),
            contentType: 'application/json',
            fileExt: 'json',
            mediaMetadata: payload as unknown as Record<string, unknown>,
          };
        } finally {
          await buffer.cleanupAll();
          await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    });

    const analysisPayload = analysisStage.published.mediaMetadata as unknown as PersistedAnalysisPayload;
    const candidate = HighlightWindowCandidateSchema.parse(analysisPayload.candidate);

    // =========================================================================
    // LAYER C: BASE_CLIP (PostgreSQL CAS Authoritative Publication)
    // =========================================================================
    const clipDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'BASE_CLIP',
      sourceRevision,
      timeRangeSec: { start: candidate.windowStartSec, end: candidate.windowEndSec },
      algorithmVersion,
      renderSettings,
      rightsScope: effectiveScope,
    };
    const clipIdentity = resolveAuthorizedCacheIdentity(resolvedAuth.auth, clipDescriptor);
    const clipWorkId = buildClipWorkId(req.canonicalSourceId, clipIdentity.cacheKey);

    const clipStage = await this.runDurableStage<Record<string, unknown>>({
      canonicalSourceId: req.canonicalSourceId,
      requesterUserId: req.requesterUserId,
      workerId: req.workerId,
      workId: clipWorkId,
      descriptor: clipDescriptor,
      leaseMs,
      waitTimeoutMs,
      pollInitialMs,
      pollMaxMs,
      signal: req.signal,
      verifyMediaIntegrity: req.verifyMediaIntegrity,
      skipFastRead: Boolean(req.onBeforeClipCommit || req.onInsideCommitTx),
      produceArtifact: async ({ artifactId, attemptId, generation, signal }) => {
        const scratchDir = path.join(
          this.workRootDir,
          `dclip_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        const segDir = path.join(scratchDir, 'segments');
        await fs.mkdir(segDir, { recursive: true });
        const buffer = new FfmpegRollingSegmentBuffer({
          workDir: segDir,
          bufferConfig: req.bufferConfig,
        });
        try {
          const needed = sourcePayload.segments.filter(
            (s) => s.endSec > candidate.windowStartSec && s.startSec < candidate.windowEndSec,
          );
          for (const s of needed) {
            const bytes = await this.publisher.cache.getObjectBytesAtKey(
              resolvedAuth.auth,
              sourceDescriptor,
              s.objectKey,
            );
            if (!bytes) throw new Error(`Missing source segment ${s.objectKey}`);
            const localPath = path.join(segDir, `seg_${String(s.index).padStart(6, '0')}.mp4`);
            await fs.writeFile(localPath, bytes);
            buffer.registerVerifiedSegment({
              index: s.index,
              filePath: localPath,
              startSec: s.startSec,
              endSec: s.endSec,
              durationSec: s.durationSec,
              sizeBytes: s.sizeBytes,
              sha256: s.sha256,
              valid: true,
            });
          }
          buffer.markEndOfStream();

          this.metrics.ffmpegClipRenderCount++;
          const outPath = path.join(scratchDir, 'clip.mp4');
          const videoFilter = computeVideoFilter(renderSettings);
          const clipMeta = await extractAndVerifyHighlightClip({
            buffer,
            windowStartSec: candidate.windowStartSec,
            windowEndSec: candidate.windowEndSec,
            outputPath: outPath,
            preferStreamCopy: !videoFilter,
            videoFilter,
            requireAudio: true,
            signal,
          });
          const mp4Bytes = await fs.readFile(outPath);
          const persistedClipMeta: ProbedClipMetadata = {
            ...clipMeta,
            filePath: '(persisted-in-storage)',
          };

          return {
            body: mp4Bytes,
            contentType: 'video/mp4',
            fileExt: 'mp4',
            mediaMetadata: {
              candidate,
              clipMeta: persistedClipMeta,
            },
            onBeforeCommit: req.onBeforeClipCommit
              ? async ({ objectKey, cacheKey }) => {
                  await req.onBeforeClipCommit!({
                    artifactId,
                    attemptId,
                    generation,
                    objectKey,
                    cacheKey,
                    clipWorkId,
                  });
                }
              : undefined,
            onInsideCommitTx: req.onInsideCommitTx,
          };
        } finally {
          await buffer.cleanupAll();
          await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    });

    const metaObj = clipStage.published.mediaMetadata as {
      candidate: HighlightWindowCandidate;
      clipMeta: ProbedClipMetadata;
    };

    return {
      canonicalSourceId: req.canonicalSourceId,
      cacheKey: clipStage.published.cacheKey,
      objectKey: clipStage.published.objectKey,
      publishedGeneration: clipStage.published.publishedGeneration,
      contentSha256: clipStage.published.contentSha256,
      sizeBytes: clipStage.published.sizeBytes,
      descriptor: clipDescriptor,
      candidate: metaObj.candidate,
      clipMeta: metaObj.clipMeta,
      downloadUrl: clipStage.published.downloadUrl,
      reusedFromDbCache: clipStage.reusedFromDbCache,
      processingMs: Date.now() - startedAt,
    };
  }
}
