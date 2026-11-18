import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  AlgorithmVersionSchema,
  HighlightWindowCandidateSchema,
  type CacheRenderSettings,
  type CacheRightsScope,
  type CacheableSourceId,
  type HighlightDetectionSample,
  type HighlightWindowCandidate,
} from '@autoedit/contracts';
import type { Prisma, PrismaClient, SharedCacheArtifact } from '@prisma/client';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import {
  transcribeRich,
  transcriberHealthy,
  type TranscriptionResult,
} from '../../services/transcribe.service.js';
import { MediaSourceError } from '../errors.js';
import { CpuFirstHeuristicDetector } from '../highlight-detector.js';
import {
  SharedIngestionCoordinator,
  buildAnalysisWorkId,
  buildClipWorkId,
  buildSourceWorkId,
} from '../ingestion-coordinator.js';
import {
  resolveAuthorizedCacheIdentity,
  type CacheArtifactDescriptor,
} from '../shared-cache.js';
import { DurableMediaRegistryService } from '../durable-media-registry.js';
import {
  DurableArtifactPublisher,
  type AuthorizedPublishedArtifactResult,
} from '../durable-artifact-publisher.js';
import { FfmpegRollingSegmentBuffer } from '../live/rolling-segment-buffer.js';
import { extractAudioSignalsFromSegments } from '../live/audio-signal-extractor.js';
import {
  extractAndVerifyHighlightClip,
  type ProbedClipMetadata,
} from '../live/highlight-clip-extractor.js';
import {
  ControlledVodAcquisitionAdapter,
  VodResourceGuard,
  type VodResourcePolicy,
} from './controlled-vod.adapter.js';

export type EditingMode = 'auto' | 'prompt' | 'reference' | 'manual';

export interface VodSourceAcquireRequest {
  adapter: ControlledVodAcquisitionAdapter;
  requesterUserId: string;
  workerId: string;
  sourceRevision?: string;
  rightsScope?: CacheRightsScope;
  leaseMs?: number;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
  verifyMediaIntegrity?: boolean;
  /** Optional test hook to simulate worker crash during VOD import before upload/commit. */
  onDuringImport?: (ctx: { generation: number; attemptId: string }) => Promise<void>;
  /** Optional test hook executed right before PostgreSQL CAS commit (e.g. rights revocation race). */
  onBeforeCommit?: (ctx: { artifactId: string; attemptId: string; generation: number }) => Promise<void>;
}

export interface VodSourceAcquireResult {
  canonicalSourceId: CacheableSourceId;
  cacheKey: string;
  objectKey: string;
  publishedGeneration: number;
  mediaFingerprint: string;
  probed: ProbedClipMetadata;
  descriptor: CacheArtifactDescriptor;
  reusedFromCache: boolean;
  processingMs: number;
}

export interface VodHighlightAnalysisRequest {
  canonicalSourceId: CacheableSourceId;
  sourceDescriptor: CacheArtifactDescriptor;
  requesterUserId: string;
  workerId: string;
  sourceRevision?: string;
  algorithmVersion?: string;
  rightsScope?: CacheRightsScope;
  /** Target highlight duration guidance (sets default preRoll + postRoll when omitted). */
  highlightLengthSec?: number;
  preRollSec?: number;
  postRollSec?: number;
  segmentDurationSec?: number;
  cooldownSec?: number;
  scoreThreshold?: number;
  aggregationWindowSec?: number;
  maxCandidates?: number;
  /** Optional local faster-whisper transcription integration (cached durably under TRANSCRIPTION). */
  enableLocalWhisper?: boolean;
  whisperBaseUrl?: string;
  whisperLanguage?: string;
  /** Optional custom transcription hook for deterministic tests without changing Whisper contract. */
  customTranscribeFn?: (audioWavPath: string) => Promise<TranscriptionResult>;
  /** Optional hook to simulate worker crash during transcription before commit. */
  onDuringTranscription?: (ctx: { generation: number }) => Promise<void>;
  leaseMs?: number;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface VodHighlightAnalysisResult {
  canonicalSourceId: CacheableSourceId;
  cacheKey: string;
  publishedGeneration: number;
  candidates: HighlightWindowCandidate[];
  transcription: TranscriptionResult | null;
  descriptor: CacheArtifactDescriptor;
  reusedFromCache: boolean;
  processingMs: number;
}

export interface VodBaseClipRequest {
  canonicalSourceId: CacheableSourceId;
  sourceDescriptor: CacheArtifactDescriptor;
  candidate: HighlightWindowCandidate;
  requesterUserId: string;
  workerId: string;
  sourceRevision?: string;
  algorithmVersion?: string;
  renderSettings?: CacheRenderSettings;
  rightsScope?: CacheRightsScope;
  leaseMs?: number;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
  verifyMediaIntegrity?: boolean;
  /** Optional test hook invoked after MP4 upload and before PostgreSQL CAS commit. */
  onBeforeCommit?: (ctx: {
    artifactId: string;
    attemptId: string;
    generation: number;
    objectKey: string;
    cacheKey: string;
  }) => Promise<void>;
  /** Optional test hook inside PostgreSQL commit tx (to test revocation race or DB rollback). */
  onInsideCommitTx?: () => Promise<void>;
}

export interface VodBaseClipResult {
  canonicalSourceId: CacheableSourceId;
  cacheKey: string;
  objectKey: string;
  publishedGeneration: number;
  contentSha256: string;
  sizeBytes: number;
  clipMeta: ProbedClipMetadata;
  descriptor: CacheArtifactDescriptor;
  downloadUrl: string;
  reusedFromCache: boolean;
  processingMs: number;
}

export interface PrivateVodEditSessionResult {
  projectId: string;
  mediaSourceId: string;
  timelineId: string;
  rootVersionId: string;
  highlightCandidates: HighlightWindowCandidate[];
}

export interface ApplyPrivateTimelineEditRequest {
  projectId: string;
  requesterUserId: string;
  mode: EditingMode;
  versionName: string;
  userPrompt?: string;
  /** Selected trim window in seconds for the user's private edit. */
  windowStartSec: number;
  windowEndSec: number;
  effects?: {
    subtitles?: boolean;
    zooms?: boolean;
    transitions?: 'fade' | 'none';
    music?: boolean;
  };
  /** Optional: if true, immediately renders & returns private MP4 (or reuses shared clip if uncustomized). */
  renderOutput?: boolean;
  sourceDescriptor?: CacheArtifactDescriptor;
  canonicalSourceId?: CacheableSourceId;
  workerId?: string;
}

export interface UnifiedVodMetrics {
  sourceImportCount: number;
  sourceCacheHits: number;
  whisperTranscriptionCount: number;
  transcriptionCacheHits: number;
  analysisPassCount: number;
  analysisCacheHits: number;
  baseClipRenderCount: number;
  baseClipCacheHits: number;
  privateEditRenderCount: number;
  repairCount: number;
  casRejections: number;
}

const DEFAULT_VOD_RENDER: CacheRenderSettings = {
  format: 'reel',
  width: 1280,
  height: 720,
  fps: 30,
  subtitles: false,
  zooms: false,
  transitions: 'none',
  music: false,
};

const EXCITEMENT_KEYWORDS = [
  'insane',
  'clutch',
  'crazy',
  'wow',
  'win',
  'auto',
  'prompt',
  'highlight',
  'clip',
  'edit',
  'transcription',
];

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'VOD request cancelled.' }),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'VOD request cancelled.' }));
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

function extractWavAudio16k(inputMp4: string, outputWav: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Audio extraction cancelled'));
    const bin = ffmpegPath || 'ffmpeg';
    const child = spawn(
      bin,
      ['-y', '-i', inputMp4, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputWav],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error('Audio extraction cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error(`Audio WAV extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.on('data', (c) => {
      stderr += String(c);
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Audio WAV extraction failed (${code}): ${stderr.trim().slice(-250)}`));
    });
  });
}

function buildTranscriptContextSignals(tx: TranscriptionResult): HighlightDetectionSample[] {
  const samples: HighlightDetectionSample[] = [];
  for (const seg of tx.segments) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const matched = EXCITEMENT_KEYWORDS.filter((kw) => lower.includes(kw));
    const hasExclaim = text.includes('!');
    const duration = Math.max(0.5, seg.end - seg.start);
    const wordsPerSec = text.split(/\s+/).length / duration;

    if (matched.length > 0 || hasExclaim || wordsPerSec >= 3.2) {
      const score = Math.min(
        1,
        0.45 + matched.length * 0.18 + (hasExclaim ? 0.2 : 0) + (wordsPerSec >= 3.2 ? 0.15 : 0),
      );
      samples.push({
        timestampSec: Math.round(((seg.start + seg.end) / 2) * 100) / 100,
        signalKind: 'TRANSCRIPT_CONTEXT',
        normalizedIntensity: Math.round(score * 1000) / 1000,
        keywords: matched,
        metadata: { segmentText: text.slice(0, 120) },
      });
    }
  }
  return samples;
}

function computeFilterForVodRender(renderSettings: CacheRenderSettings): string | undefined {
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
 * Unified VOD Ingestion, Shared Highlight Analysis, Real Base Clip Generation & Private
 * Project/Timeline Editing Service (Step 3B.8).
 *
 * Reuses the exact same PostgreSQL registry/CAS, Redis fast-path coordinator, MinIO immutable
 * object storage, FFmpeg segment buffer, CPU-first audio/transcript highlight detector, local
 * Whisper transcription service, and private Project/EditTimeline/EditVersion tables.
 */
export class UnifiedVodProcessingService {
  readonly registry: DurableMediaRegistryService;
  readonly publisher: DurableArtifactPublisher;
  readonly guard: VodResourceGuard;
  readonly metrics: UnifiedVodMetrics = {
    sourceImportCount: 0,
    sourceCacheHits: 0,
    whisperTranscriptionCount: 0,
    transcriptionCacheHits: 0,
    analysisPassCount: 0,
    analysisCacheHits: 0,
    baseClipRenderCount: 0,
    baseClipCacheHits: 0,
    privateEditRenderCount: 0,
    repairCount: 0,
    casRejections: 0,
  };

  private readonly inflightCoalescer = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: PrismaClient,
    private readonly coordinator: SharedIngestionCoordinator,
    private readonly storage: MediaStorageProvider,
    private readonly workRootDir: string,
    opts?: {
      resourcePolicy?: Partial<VodResourcePolicy>;
      quotaRedis?: ConstructorParameters<typeof VodResourceGuard>[1];
      quotaPrefix?: string;
    },
  ) {
    this.registry = new DurableMediaRegistryService(db);
    this.publisher = new DurableArtifactPublisher(
      db,
      this.registry,
      storage,
      path.join(workRootDir, 'probe'),
    );
    this.guard = new VodResourceGuard(opts?.resourcePolicy, opts?.quotaRedis, opts?.quotaPrefix);
  }

  private async coalesceInflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflightCoalescer.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => {
      this.inflightCoalescer.delete(key);
    });
    this.inflightCoalescer.set(key, p);
    return p;
  }

  /**
   * Generic durable VOD stage executor combining:
   * - Authoritative PostgreSQL + MinIO cache inspection (exact generation tracking)
   * - Fast-path Redis deduplication (coalesced polling on ATTACH_EXISTING)
   * - Row-locked PostgreSQL CAS reservation & promotion (survives Redis loss/restart!)
   * - Bounded CPU resource semaphore (`guard.withCpuSlot`)
   */
  private async runVodDurableStage(params: {
    canonicalSourceId: CacheableSourceId;
    requesterUserId: string;
    workerId: string;
    workId: CacheableSourceId;
    descriptor: CacheArtifactDescriptor;
    leaseMs: number;
    waitTimeoutMs: number;
    signal?: AbortSignal;
    verifyMediaIntegrity?: boolean;
    skipFastRead?: boolean;
    consumeClipQuotaOnNewRender?: boolean;
    produce: (ctx: {
      artifactId: string;
      attemptId: string;
      generation: number;
      signal: AbortSignal;
    }) => Promise<{
      body: Buffer;
      contentType: string;
      fileExt: string;
      mediaMetadata: Record<string, unknown>;
      onBeforeCommit?: (uploaded: { objectKey: string; cacheKey: string }) => Promise<void>;
      onInsideCommitTx?: () => Promise<void>;
    }>;
  }): Promise<{
    artifact: SharedCacheArtifact;
    published: AuthorizedPublishedArtifactResult;
    reusedFromCache: boolean;
  }> {
    const deadlineMs = Date.now() + params.waitTimeoutMs;
    let delayMs = 30;

    while (true) {
      if (params.signal?.aborted) {
        throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: `VOD stage ${params.workId} cancelled.` });
      }
      if (Date.now() > deadlineMs) {
        throw new MediaSourceError({
          code: 'COORDINATION_TIMEOUT',
          message: `Timed out waiting for VOD stage ${params.workId}.`,
          retryable: true,
        });
      }

      // 1. Check authoritative PostgreSQL + MinIO cache first (coalesced in-flight)
      let missingOrCorruptGen: number | undefined;
      if (!params.skipFastRead) {
        const inspectKey = `vod_inspect::${params.canonicalSourceId}::${params.descriptor.artifactKind}::${params.descriptor.rightsScope}::${params.descriptor.rightsScope === 'PRIVATE_USER' ? params.requesterUserId : 'shared'}::${params.workId}::${Boolean(params.verifyMediaIntegrity)}`;
        const inspected = await this.coalesceInflight(inspectKey, () =>
          this.publisher.inspectAuthorizedPublishedArtifact({
            requesterUserId: params.requesterUserId,
            canonicalSourceId: params.canonicalSourceId,
            descriptor: params.descriptor,
            verifyInStorage: true,
            verifyMediaIntegrity: params.verifyMediaIntegrity,
          }),
        );
        if (inspected.status === 'PUBLISHED_VALID') {
          return {
            artifact: inspected.result.artifact,
            published: inspected.result,
            reusedFromCache: true,
          };
        }
        if (inspected.status === 'MISSING_OR_CORRUPT') {
          missingOrCorruptGen = inspected.publishedGeneration;
        }
      }

      // 2. Fast-path Redis deduplication for concurrent clippers
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
            await sleepAbortable(Math.min(25, Math.max(5, deadlineMs - Date.now())), params.signal);
            continue;
          }
          if (coord.action === 'ATTACH_EXISTING') {
            let waitDelay = 30;
            while (Date.now() <= deadlineMs) {
              await sleepAbortable(Math.min(waitDelay, Math.max(10, deadlineMs - Date.now())), params.signal);
              waitDelay = Math.min(200, Math.ceil(waitDelay * 1.5));
              const rec = await this.coalesceInflight(`vod_redis::${params.workId}`, () =>
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
          // Redis is volatile fast coordination; fall through to PostgreSQL authoritative reservation
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
        delayMs = Math.min(200, Math.ceil(delayMs * 1.5));
        continue;
      }

      if (missingOrCorruptGen !== undefined) {
        this.metrics.repairCount++;
      }

      // Enforce daily free-tier clip quota ONLY when performing a new uncached clip render!
      if (params.consumeClipQuotaOnNewRender) {
        try {
          await this.guard.consumeDailyClipQuota(params.requesterUserId);
        } catch (quotaErr) {
          await this.publisher
            .abortPublicationAttempt({
              artifactId: reserved.artifactId,
              attemptId: reserved.attemptId,
              workerId: params.workerId,
              reason: quotaErr instanceof Error ? quotaErr.message : String(quotaErr),
            })
            .catch(() => {});
          if (redisToken !== null) {
            await this.coordinator
              .releaseLease({
                canonicalSourceId: params.workId,
                workerId: params.workerId,
                fencingToken: redisToken,
              })
              .catch(() => {});
          }
          throw quotaErr;
        }
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
        const produced = await this.guard.withCpuSlot(
          params.requesterUserId,
          () =>
            params.produce({
              artifactId: reserved.artifactId,
              attemptId: reserved.attemptId,
              generation: reserved.generation,
              signal: ownerAbort.signal,
            }),
          ownerAbort.signal,
        );

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

        stopHb();
        const expiresAt = new Date(Date.now() + this.guard.policy.cacheRetentionMs);
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
          expiresAt,
          onBeforeCommitInsideTx: produced.onInsideCommitTx,
        });

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
          verifyInStorage: false,
        });

        return { artifact: promoted, published, reusedFromCache: false };
      } catch (err) {
        stopHb();
        const isCasReject = err instanceof MediaSourceError && err.code === 'LEASE_EXPIRED';
        const isAccessDenied =
          err instanceof MediaSourceError &&
          (err.code === 'ACCESS_DENIED' || err.code === 'DRM_RESTRICTED' || err.code === 'RIGHTS_UNVERIFIED');
        const isCancelled = err instanceof MediaSourceError && err.code === 'REQUEST_CANCELLED';

        if (isCasReject) {
          this.metrics.casRejections++;
        } else if (!isAccessDenied) {
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
   * Layer A: Finite VOD Source Acquisition Lifecycle.
   * Reuses verified immutable SOURCE_MEDIA in MinIO if already present & permitted;
   * otherwise acquires, validates codecs/duration/bounds, uploads immutable MP4,
   * and commits via PostgreSQL CAS.
   */
  async acquireOrReuseVodSource(req: VodSourceAcquireRequest): Promise<VodSourceAcquireResult> {
    const startedAt = Date.now();
    const regInput = req.adapter.buildMediaSourceRegistration();
    const canonicalSourceId = regInput.canonicalId as CacheableSourceId;
    const sourceRevision = req.sourceRevision ?? regInput.sourceRevision ?? 'v1';

    // Verify server-authoritative rights from PostgreSQL BEFORE touching Redis/MinIO/FFmpeg
    const resolvedAuth = await this.coalesceInflight(
      `vod_auth::${canonicalSourceId}::${req.rightsScope === 'PRIVATE_USER' || canonicalSourceId.startsWith('upload:') ? req.requesterUserId : 'shared'}`,
      () =>
        this.registry.resolveServerTrustedAuth({
          requesterUserId: req.requesterUserId,
          canonicalSourceId,
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
        message: `Shared cache reuse not authorized for VOD ${canonicalSourceId}.`,
      });
    }

    const sourceDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'SOURCE_MEDIA',
      sourceRevision,
      algorithmVersion: 'vod-import-v1',
      rightsScope: effectiveScope,
    };
    const sourceWorkId = buildSourceWorkId(
      canonicalSourceId,
      `${sourceRevision}_vod_${effectiveScope === 'PRIVATE_USER' ? req.requesterUserId : 'sh'}`,
    );

    const stage = await this.runVodDurableStage({
      canonicalSourceId,
      requesterUserId: req.requesterUserId,
      workerId: req.workerId,
      workId: sourceWorkId,
      descriptor: sourceDescriptor,
      leaseMs: req.leaseMs ?? 30_000,
      waitTimeoutMs: req.waitTimeoutMs ?? 90_000,
      signal: req.signal,
      verifyMediaIntegrity: req.verifyMediaIntegrity,
      skipFastRead: Boolean(req.onBeforeCommit || req.onDuringImport),
      produce: async ({ artifactId, attemptId, generation }) => {
        if (req.onDuringImport) {
          await req.onDuringImport({ generation, attemptId });
        }
        this.metrics.sourceImportCount++;
        const acquired = await req.adapter.acquireAndValidate(this.guard);
        return {
          body: acquired.bytes,
          contentType: 'video/mp4',
          fileExt: 'mp4',
          mediaMetadata: {
            probed: acquired.probed,
            mediaFingerprint: acquired.mediaFingerprint,
            archetype: req.adapter.config.archetype,
          },
          onBeforeCommit: req.onBeforeCommit
            ? async () => {
                await req.onBeforeCommit!({ artifactId, attemptId, generation });
              }
            : undefined,
        };
      },
    });

    if (stage.reusedFromCache) {
      this.metrics.sourceCacheHits++;
    }

    const meta = stage.published.mediaMetadata as {
      probed: ProbedClipMetadata;
      mediaFingerprint: string;
    };

    return {
      canonicalSourceId,
      cacheKey: stage.published.cacheKey,
      objectKey: stage.published.objectKey,
      publishedGeneration: stage.published.publishedGeneration,
      mediaFingerprint: meta.mediaFingerprint ?? stage.published.contentSha256,
      probed: meta.probed,
      descriptor: sourceDescriptor,
      reusedFromCache: stage.reusedFromCache,
      processingMs: Date.now() - startedAt,
    };
  }

  /**
   * Layer B: Shared VOD Transcription (optional local Whisper under TRANSCRIPTION) +
   * CPU-First Multi-Candidate Highlight Analysis (under HIGHLIGHT_ANALYSIS).
   *
   * 100 or 1,000 clippers requesting identical parameters run Whisper and FFmpeg ONCE!
   */
  async analyzeOrReuseVodHighlights(
    req: VodHighlightAnalysisRequest,
  ): Promise<VodHighlightAnalysisResult> {
    const startedAt = Date.now();
    const sourceRevision = req.sourceRevision ?? req.sourceDescriptor.sourceRevision ?? 'v1';
    const algorithmVersion = req.algorithmVersion ?? 'v1.0-heuristic';
    const effectiveScope = req.rightsScope ?? req.sourceDescriptor.rightsScope;
    const highlightLen = req.highlightLengthSec ?? 10;
    const preRollSec = req.preRollSec ?? Math.max(2, Math.round(highlightLen * 0.6));
    const postRollSec = req.postRollSec ?? Math.max(2, Math.round(highlightLen * 0.4));
    const segDur = req.segmentDurationSec ?? 5;
    const cooldownSec = req.cooldownSec ?? 12;
    const scoreThreshold = req.scoreThreshold ?? 65;
    const aggregationWindowSec = req.aggregationWindowSec ?? 3;
    const maxCandidates = Math.max(1, req.maxCandidates ?? 10);
    const leaseMs = req.leaseMs ?? 45_000;
    const waitTimeoutMs = req.waitTimeoutMs ?? 90_000;

    // 1. Optional durable local Whisper transcription (cached once under TRANSCRIPTION!)
    let transcription: TranscriptionResult | null = null;
    if (req.enableLocalWhisper) {
      const whisperLang = req.whisperLanguage ?? 'en';
      const txDescriptor: CacheArtifactDescriptor = {
        artifactKind: 'TRANSCRIPTION',
        sourceRevision,
        algorithmVersion: `whisper-${whisperLang}-v1`,
        rightsScope: effectiveScope,
      };
      const txWorkId = buildAnalysisWorkId(req.canonicalSourceId, {
        sourceRevision,
        algorithmVersion: `tx_${whisperLang}_${effectiveScope === 'PRIVATE_USER' ? req.requesterUserId : 'sh'}`,
        scoreThreshold: 0,
        cooldownSec: 0,
      });

      const txStage = await this.runVodDurableStage({
        canonicalSourceId: req.canonicalSourceId,
        requesterUserId: req.requesterUserId,
        workerId: `${req.workerId}_tx`,
        workId: txWorkId,
        descriptor: txDescriptor,
        leaseMs,
        waitTimeoutMs,
        signal: req.signal,
        skipFastRead: Boolean(req.onDuringTranscription),
        produce: async ({ generation, signal }) => {
          if (req.onDuringTranscription) {
            await req.onDuringTranscription({ generation });
          }

          const scratchDir = path.join(
            this.workRootDir,
            `vodtx_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          );
          await fs.mkdir(scratchDir, { recursive: true });
          try {
            // Download verified immutable SOURCE_MEDIA from MinIO
            const authRes = await this.registry.resolveServerTrustedAuth({
              requesterUserId: req.requesterUserId,
              canonicalSourceId: req.canonicalSourceId,
              requireSharedReuse: effectiveScope === 'SHARED_PERMITTED',
            });
            const srcPub = await this.publisher.getAuthorizedPublishedArtifact({
              requesterUserId: req.requesterUserId,
              canonicalSourceId: req.canonicalSourceId,
              descriptor: req.sourceDescriptor,
              verifyInStorage: true,
            });
            const mp4Bytes = await this.publisher.cache.getObjectBytesAtKey(
              authRes.auth,
              req.sourceDescriptor,
              srcPub.objectKey,
            );
            if (!mp4Bytes) {
              throw new MediaSourceError({
                code: 'SOURCE_UNAVAILABLE',
                message: 'VOD source object missing during transcription.',
              });
            }
            const localMp4 = path.join(scratchDir, 'source.mp4');
            const localWav = path.join(scratchDir, 'audio.wav');
            await fs.writeFile(localMp4, mp4Bytes);
            await extractWavAudio16k(localMp4, localWav, this.guard.policy.workerTimeoutMs, signal);

            this.metrics.whisperTranscriptionCount++;
            let txResult: TranscriptionResult;
            if (req.customTranscribeFn) {
              txResult = await req.customTranscribeFn(localWav);
            } else {
              const baseUrl = req.whisperBaseUrl ?? 'http://127.0.0.1:9000';
              const healthy = await transcriberHealthy(baseUrl);
              if (!healthy) {
                throw new MediaSourceError({
                  code: 'SOURCE_UNAVAILABLE',
                  message: `Local Whisper sidecar at ${baseUrl} is unavailable.`,
                  retryable: true,
                });
              }
              txResult = await transcribeRich(localWav, whisperLang, {
                baseUrl,
                retries: 2,
                timeoutMs: this.guard.policy.workerTimeoutMs,
              });
            }

            return {
              body: Buffer.from(JSON.stringify(txResult), 'utf-8'),
              contentType: 'application/json',
              fileExt: 'json',
              mediaMetadata: { transcription: txResult },
            };
          } finally {
            await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
          }
        },
      });

      if (txStage.reusedFromCache) {
        this.metrics.transcriptionCacheHits++;
      }
      transcription =
        (txStage.published.mediaMetadata as { transcription?: TranscriptionResult })?.transcription ??
        null;
    }

    // 2. Shared CPU-First Multi-Candidate Highlight Analysis (under HIGHLIGHT_ANALYSIS)
    const analysisParamTag = `${algorithmVersion}-p${preRollSec}-${postRollSec}-s${segDur}-c${cooldownSec}-t${scoreThreshold}-a${aggregationWindowSec}-w${req.enableLocalWhisper ? 1 : 0}`;
    const analysisDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'HIGHLIGHT_ANALYSIS',
      sourceRevision,
      algorithmVersion: analysisParamTag,
      rightsScope: effectiveScope,
    };
    const analysisWorkId = buildAnalysisWorkId(req.canonicalSourceId, {
      sourceRevision,
      algorithmVersion: `${analysisParamTag}_${effectiveScope === 'PRIVATE_USER' ? req.requesterUserId : 'sh'}`,
      scoreThreshold,
      cooldownSec,
      bufferConfig: { segmentDurationSec: segDur, preEventSec: preRollSec, postEventSec: postRollSec },
    });

    const stage = await this.runVodDurableStage({
      canonicalSourceId: req.canonicalSourceId,
      requesterUserId: req.requesterUserId,
      workerId: `${req.workerId}_ana`,
      workId: analysisWorkId,
      descriptor: analysisDescriptor,
      leaseMs,
      waitTimeoutMs,
      signal: req.signal,
      produce: async ({ signal }) => {
        const scratchDir = path.join(
          this.workRootDir,
          `vodana_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        const buffer = new FfmpegRollingSegmentBuffer({
          workDir: path.join(scratchDir, 'segments'),
          bufferConfig: {
            segmentDurationSec: segDur,
            preEventSec: preRollSec,
            postEventSec: postRollSec,
            maxRetentionSec: Math.max(600, this.guard.policy.maxVodDurationSec),
          },
        });
        try {
          await fs.mkdir(scratchDir, { recursive: true });
          const authRes = await this.registry.resolveServerTrustedAuth({
            requesterUserId: req.requesterUserId,
            canonicalSourceId: req.canonicalSourceId,
            requireSharedReuse: effectiveScope === 'SHARED_PERMITTED',
          });
          const srcPub = await this.publisher.getAuthorizedPublishedArtifact({
            requesterUserId: req.requesterUserId,
            canonicalSourceId: req.canonicalSourceId,
            descriptor: req.sourceDescriptor,
            verifyInStorage: true,
          });
          const mp4Bytes = await this.publisher.cache.getObjectBytesAtKey(
            authRes.auth,
            req.sourceDescriptor,
            srcPub.objectKey,
          );
          if (!mp4Bytes) {
            throw new MediaSourceError({
              code: 'SOURCE_UNAVAILABLE',
              message: 'VOD source object missing during highlight analysis.',
            });
          }
          const localMp4 = path.join(scratchDir, 'source.mp4');
          await fs.writeFile(localMp4, mp4Bytes);

          // Reuse existing FfmpegRollingSegmentBuffer + extractAudioSignalsFromSegments + CpuFirstHeuristicDetector!
          this.metrics.analysisPassCount++;
          const segments = await buffer.ingestFromSourceFile(localMp4, {
            markEndOfStream: true,
            signal,
          });
          const audioSignals = await extractAudioSignalsFromSegments(segments);

          const detector = new CpuFirstHeuristicDetector({
            canonicalSourceId: req.canonicalSourceId,
            bufferConfig: {
              segmentDurationSec: segDur,
              preEventSec: preRollSec,
              postEventSec: postRollSec,
              maxRetentionSec: Math.max(600, this.guard.policy.maxVodDurationSec),
            },
            scoreThreshold,
            cooldownSec,
            aggregationWindowSec,
          });

          for (const s of audioSignals.samples) detector.ingestSignal(s);
          if (transcription) {
            for (const tSig of buildTranscriptContextSignals(transcription)) {
              detector.ingestSignal(tSig);
            }
          }

          const rawCandidates = detector.evaluate(buffer.getLatestBufferedSec());
          const parsedAlgo = AlgorithmVersionSchema.safeParse(algorithmVersion);
          const clampedCandidates: HighlightWindowCandidate[] = rawCandidates
            .slice(0, maxCandidates)
            .map((c) => {
              const win = buffer.computeWindowForEvent(c.eventTimestampSec);
              return HighlightWindowCandidateSchema.parse({
                ...c,
                algorithmVersion: parsedAlgo.success ? parsedAlgo.data : c.algorithmVersion,
                windowStartSec: win.windowStartSec,
                windowEndSec: win.windowEndSec,
                pinnedSegmentIndices: win.pinnedSegmentIndices,
              });
            });

          const payload = {
            version: 1,
            candidates: clampedCandidates,
            totalDurationSec: buffer.getLatestBufferedSec(),
            baselineRmsDb: audioSignals.baselineRmsDb,
            hasTranscription: Boolean(transcription),
          };
          return {
            body: Buffer.from(JSON.stringify(payload), 'utf-8'),
            contentType: 'application/json',
            fileExt: 'json',
            mediaMetadata: payload,
          };
        } finally {
          await buffer.cleanupAll();
          await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    });

    if (stage.reusedFromCache) {
      this.metrics.analysisCacheHits++;
    }

    const meta = stage.published.mediaMetadata as { candidates: HighlightWindowCandidate[] };
    const candidates = (meta.candidates ?? []).map((c) => HighlightWindowCandidateSchema.parse(c));

    return {
      canonicalSourceId: req.canonicalSourceId,
      cacheKey: stage.published.cacheKey,
      publishedGeneration: stage.published.publishedGeneration,
      candidates,
      transcription,
      descriptor: analysisDescriptor,
      reusedFromCache: stage.reusedFromCache,
      processingMs: Date.now() - startedAt,
    };
  }

  /**
   * Layer C: Real VOD Base Clip Generation & PostgreSQL CAS Publication.
   * Reuses identical base clips across eligible clippers; generates distinct cache keys
   * for different candidate windows, source revisions, or render parameters.
   */
  async generateOrReuseVodBaseClip(req: VodBaseClipRequest): Promise<VodBaseClipResult> {
    const startedAt = Date.now();
    const sourceRevision = req.sourceRevision ?? req.sourceDescriptor.sourceRevision ?? 'v1';
    const algorithmVersion = req.algorithmVersion ?? req.candidate.algorithmVersion ?? 'v1.0-heuristic';
    const renderSettings: CacheRenderSettings = { ...DEFAULT_VOD_RENDER, ...(req.renderSettings ?? {}) };
    const effectiveScope = req.rightsScope ?? req.sourceDescriptor.rightsScope;

    const clipDescriptor: CacheArtifactDescriptor = {
      artifactKind: 'BASE_CLIP',
      sourceRevision,
      timeRangeSec: {
        start: req.candidate.windowStartSec,
        end: req.candidate.windowEndSec,
      },
      algorithmVersion,
      renderSettings,
      rightsScope: effectiveScope,
    };

    const resolvedAuth = await this.registry.resolveServerTrustedAuth({
      requesterUserId: req.requesterUserId,
      canonicalSourceId: req.canonicalSourceId,
      requireSharedReuse: effectiveScope === 'SHARED_PERMITTED',
    });
    const clipIdentity = resolveAuthorizedCacheIdentity(resolvedAuth.auth, clipDescriptor);
    const clipWorkId = buildClipWorkId(req.canonicalSourceId, clipIdentity.cacheKey);

    const stage = await this.runVodDurableStage({
      canonicalSourceId: req.canonicalSourceId,
      requesterUserId: req.requesterUserId,
      workerId: req.workerId,
      workId: clipWorkId,
      descriptor: clipDescriptor,
      leaseMs: req.leaseMs ?? 30_000,
      waitTimeoutMs: req.waitTimeoutMs ?? 90_000,
      signal: req.signal,
      verifyMediaIntegrity: req.verifyMediaIntegrity,
      skipFastRead: Boolean(req.onBeforeCommit || req.onInsideCommitTx),
      consumeClipQuotaOnNewRender: true,
      produce: async ({ artifactId, attemptId, generation, signal }) => {
        const scratchDir = path.join(
          this.workRootDir,
          `vodclip_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        );
        const buffer = new FfmpegRollingSegmentBuffer({
          workDir: path.join(scratchDir, 'segments'),
          bufferConfig: { segmentDurationSec: 5, maxRetentionSec: Math.max(600, this.guard.policy.maxVodDurationSec) },
        });
        try {
          await fs.mkdir(scratchDir, { recursive: true });
          const srcPub = await this.publisher.getAuthorizedPublishedArtifact({
            requesterUserId: req.requesterUserId,
            canonicalSourceId: req.canonicalSourceId,
            descriptor: req.sourceDescriptor,
            verifyInStorage: true,
          });
          const mp4Bytes = await this.publisher.cache.getObjectBytesAtKey(
            resolvedAuth.auth,
            req.sourceDescriptor,
            srcPub.objectKey,
          );
          if (!mp4Bytes) {
            throw new MediaSourceError({
              code: 'SOURCE_UNAVAILABLE',
              message: 'VOD source object missing during clip extraction.',
            });
          }
          const localSource = path.join(scratchDir, 'source.mp4');
          await fs.writeFile(localSource, mp4Bytes);

          await buffer.ingestFromSourceFile(localSource, { markEndOfStream: true, signal });

          this.metrics.baseClipRenderCount++;
          const outPath = path.join(scratchDir, 'vod-clip.mp4');
          const videoFilter = computeFilterForVodRender(renderSettings);
          const clipMeta = await extractAndVerifyHighlightClip({
            buffer,
            windowStartSec: req.candidate.windowStartSec,
            windowEndSec: req.candidate.windowEndSec,
            outputPath: outPath,
            preferStreamCopy: !videoFilter,
            videoFilter,
            requireAudio: true,
            signal,
          });
          const outBytes = await fs.readFile(outPath);
          const persistedMeta: ProbedClipMetadata = {
            ...clipMeta,
            filePath: '(persisted-in-storage)',
          };

          return {
            body: outBytes,
            contentType: 'video/mp4',
            fileExt: 'mp4',
            mediaMetadata: {
              candidate: req.candidate,
              clipMeta: persistedMeta,
            },
            onBeforeCommit: req.onBeforeCommit
              ? async ({ objectKey, cacheKey }) => {
                  await req.onBeforeCommit!({ artifactId, attemptId, generation, objectKey, cacheKey });
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

    if (stage.reusedFromCache) {
      this.metrics.baseClipCacheHits++;
    }

    const meta = stage.published.mediaMetadata as { clipMeta: ProbedClipMetadata };
    return {
      canonicalSourceId: req.canonicalSourceId,
      cacheKey: stage.published.cacheKey,
      objectKey: stage.published.objectKey,
      publishedGeneration: stage.published.publishedGeneration,
      contentSha256: stage.published.contentSha256,
      sizeBytes: stage.published.sizeBytes,
      clipMeta: meta.clipMeta,
      descriptor: clipDescriptor,
      downloadUrl: stage.published.downloadUrl,
      reusedFromCache: stage.reusedFromCache,
      processingMs: Date.now() - startedAt,
    };
  }

  /**
   * Creates an independent, private per-user Project + EditTimeline + root EditVersion
   * seeded from a shared VOD MediaSource and its shared HighlightWindowCandidates.
   * Multiple independent users share the underlying MediaSource & Analysis while keeping
   * their own Projects, timelines, versions, prompts, and personalized renders 100% isolated.
   */
  async createPrivateEditingSessionFromVod(input: {
    requesterUserId: string;
    canonicalSourceId: CacheableSourceId;
    title: string;
    candidates: HighlightWindowCandidate[];
  }): Promise<PrivateVodEditSessionResult> {
    const resolved = await this.registry.resolveServerTrustedAuth({
      requesterUserId: input.requesterUserId,
      canonicalSourceId: input.canonicalSourceId,
    });
    if (
      resolved.mediaSource.provider !== 'UPLOAD' &&
      !resolved.allowSharedReuse &&
      !resolved.allowAcquisition
    ) {
      throw new MediaSourceError({
        code: 'RIGHTS_UNVERIFIED',
        message: `User "${input.requesterUserId}" is not authorized to open an editing session for ${input.canonicalSourceId}.`,
      });
    }

    const primary = input.candidates[0];
    const initialOps = primary
      ? [
          {
            id: 'op_hl_1',
            type: 'cut',
            start: primary.windowStartSec,
            end: primary.windowEndSec,
            label: `Highlight (${primary.compositeScore})`,
          },
        ]
      : [];
    const initialEffects = {
      subtitles: false,
      zooms: false,
      transitions: 'none',
      music: false,
    };
    const initialOutputs = [{ format: 'reel', aspect: '9:16', maxDurationSec: 60 }];

    const created = await this.db.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          userId: input.requesterUserId,
          mediaSourceId: resolved.mediaSource.id,
          title: input.title,
          status: 'ANALYZED',
        },
      });
      const timeline = await tx.editTimeline.create({
        data: {
          projectId: project.id,
          operations: initialOps as Prisma.InputJsonValue,
          effects: initialEffects as Prisma.InputJsonValue,
          outputs: initialOutputs as Prisma.InputJsonValue,
          approved: false,
        },
      });
      const rootVersion = await tx.editVersion.create({
        data: {
          projectId: project.id,
          name: 'AutoAI VOD Highlights (Root)',
          userPrompt: null,
          aiExplanation: `Seeded with ${input.candidates.length} shared VOD highlight candidate(s).`,
          changes: [] as Prisma.InputJsonValue,
          timelineJson: {
            mode: 'auto',
            operations: initialOps,
            effects: initialEffects,
          } as Prisma.InputJsonValue,
        },
      });
      return { project, timeline, rootVersion };
    });

    return {
      projectId: created.project.id,
      mediaSourceId: resolved.mediaSource.id,
      timelineId: created.timeline.id,
      rootVersionId: created.rootVersion.id,
      highlightCandidates: input.candidates,
    };
  }

  /**
   * Applies a non-destructive private timeline edit (Auto, Prompt, Reference, or Manual mode)
   * to an owned Project, creating an immutable EditVersion child snapshot without affecting
   * any other user's Project or shared base cache.
   */
  async applyPrivateTimelineEdit(input: ApplyPrivateTimelineEditRequest): Promise<{
    projectId: string;
    versionId: string;
    parentVersionId: string | null;
    customEditHash: string;
    privateRender?: VodBaseClipResult;
  }> {
    const project = await this.db.project.findUnique({
      where: { id: input.projectId },
      include: {
        versions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!project) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `Project "${input.projectId}" not found.`,
      });
    }
    if (project.userId !== input.requesterUserId) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Cross-user editing of another user’s private Project/EditTimeline is prohibited.',
      });
    }

    const parentVersionId = project.versions[0]?.id ?? null;
    const ops = [
      {
        id: `op_${input.mode}_${Date.now()}`,
        type: 'cut',
        start: input.windowStartSec,
        end: input.windowEndSec,
        mode: input.mode,
      },
    ];
    const effects = {
      subtitles: input.effects?.subtitles ?? false,
      zooms: input.effects?.zooms ?? false,
      transitions: input.effects?.transitions ?? 'none',
      music: input.effects?.music ?? false,
    };
    const customEditHash = stableShortHash(
      {
        projectId: project.id,
        userId: input.requesterUserId,
        mode: input.mode,
        prompt: input.userPrompt ?? '',
        ops,
        effects,
      },
      24,
    );

    const newVersion = await this.db.$transaction(async (tx) => {
      await tx.editTimeline.update({
        where: { projectId: project.id },
        data: {
          operations: ops as Prisma.InputJsonValue,
          effects: effects as Prisma.InputJsonValue,
        },
      });
      return tx.editVersion.create({
        data: {
          projectId: project.id,
          parentVersionId,
          name: input.versionName,
          userPrompt: input.userPrompt ?? null,
          aiExplanation: `Applied ${input.mode} mode private edit (${input.windowStartSec}s–${input.windowEndSec}s).`,
          changes: [{ action: input.mode, start: input.windowStartSec, end: input.windowEndSec }] as Prisma.InputJsonValue,
          timelineJson: { mode: input.mode, operations: ops, effects, customEditHash } as Prisma.InputJsonValue,
        },
      });
    });

    let privateRender: VodBaseClipResult | undefined;
    if (input.renderOutput && input.canonicalSourceId && input.sourceDescriptor) {
      this.metrics.privateEditRenderCount++;
      privateRender = await this.generateOrReuseVodBaseClip({
        canonicalSourceId: input.canonicalSourceId,
        sourceDescriptor: input.sourceDescriptor,
        candidate: HighlightWindowCandidateSchema.parse({
          candidateId: `priv_${project.id}_${newVersion.id}`,
          canonicalSourceId: input.canonicalSourceId,
          eventTimestampSec: (input.windowStartSec + input.windowEndSec) / 2,
          windowStartSec: input.windowStartSec,
          windowEndSec: input.windowEndSec,
          compositeScore: 100,
          contributingSignals: ['AUDIO_ENERGY'],
          pinnedSegmentIndices: [],
          algorithmVersion: 'v1.0-heuristic',
        }),
        requesterUserId: input.requesterUserId,
        workerId: input.workerId ?? `priv_worker_${input.requesterUserId}`,
        rightsScope: 'PRIVATE_USER',
        renderSettings: {
          ...DEFAULT_VOD_RENDER,
          subtitles: effects.subtitles,
          zooms: effects.zooms,
          transitions: effects.transitions,
          music: effects.music,
          customEditHash,
        },
      });
    }

    return {
      projectId: project.id,
      versionId: newVersion.id,
      parentVersionId,
      customEditHash,
      privateRender,
    };
  }
}
