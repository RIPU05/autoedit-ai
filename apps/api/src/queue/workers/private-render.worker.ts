import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { CacheRenderSettings, CacheRightsScope, PrivateRenderQueuePayload } from '@autoedit/contracts';
import { bullConnection as defaultBullConnection, connection as defaultRedis } from '../../lib/redis.js';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { getStorageProvider } from '../../storage/index.js';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import {
  PRIVATE_RENDER_QUEUE,
  enqueuePrivateRender,
  moveToDeadLetter,
  type PrivateRenderJobData,
} from '../queues.js';
import { MediaSourceError } from '../../media/errors.js';
import type { RedisLikeClient } from '../../media/ingestion-coordinator.js';
import { DurableMediaRegistryService } from '../../media/durable-media-registry.js';
import { DurableArtifactPublisher } from '../../media/durable-artifact-publisher.js';
import type { CacheArtifactDescriptor } from '../../media/shared-cache.js';
import { FfmpegRollingSegmentBuffer } from '../../media/live/rolling-segment-buffer.js';
import {
  extractAndVerifyHighlightClip,
  probeAndValidateClipMp4,
} from '../../media/live/highlight-clip-extractor.js';
import {
  PrivateRenderService,
  buildPrivateRenderBullJobId,
  registerLocalPrivateRenderAbort,
  unregisterLocalPrivateRenderAbort,
  type PrivateRenderPolicyConfig,
} from '../../media/api/private-render.service.js';

const NON_RETRYABLE_CODES = new Set([
  'ACCESS_DENIED',
  'RIGHTS_UNVERIFIED',
  'DRM_RESTRICTED',
  'SOURCE_UNAVAILABLE',
  'ARTIFACT_CORRUPT',
  'REQUEST_CANCELLED',
  'LEASE_EXPIRED',
  'MALFORMED_URL',
]);

async function streamToFile(stream: NodeJS.ReadableStream, outPath: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(
      Buffer.isBuffer(c)
        ? c
        : typeof c === 'string'
          ? Buffer.from(c)
          : Buffer.from(c as Uint8Array),
    );
  }
  await fs.writeFile(outPath, Buffer.concat(chunks));
}

function buildPrivateVideoFilter(settings: Partial<CacheRenderSettings>): string | undefined {
  const width = Math.min(1280, Math.max(320, settings.width ?? 1280));
  const height = Math.min(1280, Math.max(320, settings.height ?? 720));
  const fps = Math.min(30, Math.max(15, settings.fps ?? 30));

  const needsScale = width !== 1280 || height !== 720;
  const needsFps = fps !== 30;
  const filters: string[] = [];

  if (settings.zooms) {
    filters.push(`crop=iw*0.95:ih*0.95,scale=${width}:${height}`);
  } else if (needsScale) {
    filters.push(`scale=${width}:${height}`);
  }
  if (needsFps) {
    filters.push(`fps=${fps}`);
  }
  if (filters.length === 0 && settings.subtitles) {
    filters.push(`scale=${width}:${height}`);
  }
  return filters.length > 0 ? filters.join(',') : undefined;
}

export interface CreatePrivateRenderWorkerOptions {
  queueName?: string;
  db?: PrismaClient;
  storage?: MediaStorageProvider;
  redis?: RedisLikeClient;
  bullConnection?: typeof defaultBullConnection;
  workRootDir?: string;
  keyPrefix?: string;
  concurrency?: number;
  leaseMs?: number;
  reconcileIntervalMs?: number;
  policy?: Partial<PrivateRenderPolicyConfig>;
  now?: () => Date;
  workerIdPrefix?: string;
  enqueueRecoveryJob?: (
    payload: PrivateRenderQueuePayload,
    opts?: { jobId?: string },
  ) => Promise<{ id?: string }>;
  /** Optional lifecycle hook invoked after claim & before FFmpeg render (useful for crash/cancel tests). */
  onBeforeRender?: (ctx: {
    renderJobId: string;
    generation: number;
    ownerToken: string;
    workerId: string;
    signal: AbortSignal;
  }) => Promise<void> | void;
}

/**
 * BullMQ worker for durable, owner-scoped background private clip rendering (Step 3C.1.1).
 *
 * - Bounded CPU concurrency (`PRIVATE_RENDER_CONCURRENCY`, default 2) isolated from shared ingestion.
 * - Continuous PostgreSQL lease heartbeat with immediate SIGKILL abort on lease loss or cancellation.
 * - Live PostgreSQL rights re-verification before reading source media AND before committing output.
 * - Real FFmpeg extraction + ffprobe validation (never serves empty, incomplete, or corrupt MP4s).
 * - Guaranteed scratch directory cleanup in `finally`.
 * - Bounded periodic crash recovery & stranded-outbox reconciler.
 */
export function createPrivateRenderWorker(opts: CreatePrivateRenderWorkerOptions = {}) {
  const queueName = opts.queueName ?? PRIVATE_RENDER_QUEUE;
  const db = opts.db ?? defaultPrisma;
  const storage = opts.storage ?? getStorageProvider();
  const redis = opts.redis ?? (defaultRedis as unknown as RedisLikeClient);
  const bullConn = opts.bullConnection ?? defaultBullConnection;
  const keyPrefix = opts.keyPrefix ?? 'autoedit:priv_render:';
  const workRootDir = opts.workRootDir ?? path.resolve(process.cwd(), 'tmp', 'private-render-worker');
  const concurrency = opts.concurrency ?? env.PRIVATE_RENDER_CONCURRENCY;
  const leaseMs = opts.leaseMs ?? 30_000;
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? 15_000;
  const workerIdPrefix = opts.workerIdPrefix ?? `bull_priv_render_${process.pid}`;

  const enqueueRecoveryFn =
    opts.enqueueRecoveryJob ??
    ((payload: PrivateRenderQueuePayload, enqueueOpts?: { jobId?: string }) =>
      enqueuePrivateRender(payload, {
        jobId: enqueueOpts?.jobId || buildPrivateRenderBullJobId(payload.renderJobId, payload.generation),
      }));

  const service = new PrivateRenderService({
    db,
    storage,
    redis,
    keyPrefix,
    policy: { ...opts.policy, leaseMs },
    now: opts.now,
    enqueueJob: enqueueRecoveryFn,
  });
  const registry = new DurableMediaRegistryService(db);
  const publisher = new DurableArtifactPublisher(
    db,
    registry,
    storage,
    path.join(workRootDir, 'probe'),
  );

  let reconcileTimer: NodeJS.Timeout | null = null;
  if (reconcileIntervalMs > 0) {
    reconcileTimer = setInterval(() => {
      service.reconcileStrandedRenders(10).catch(() => {});
    }, reconcileIntervalMs);
    reconcileTimer.unref?.();
  }

  const worker = new Worker<PrivateRenderJobData>(
    queueName,
    async (job: Job<PrivateRenderJobData>) => {
      const data = job.data;
      const attemptNum = job.attemptsMade + 1;
      const workerId = `${workerIdPrefix}_${job.id ?? Date.now()}_a${attemptNum}`;

      // 1. Atomic durable PostgreSQL ownership claim
      const claim = await service.claimRenderExecution({
        renderJobId: data.renderJobId,
        payloadGeneration: data.generation,
        workerId,
        bullJobId: job.id ? String(job.id) : undefined,
        leaseMs,
      });

      if (claim.action !== 'CLAIMED') {
        return { skipped: true, reason: claim.action, renderJobId: data.renderJobId };
      }

      const renderRow = claim.job;
      const claimedGen = claim.generation;
      const ownerToken = claim.ownerToken;
      const abortCtrl = new AbortController();
      registerLocalPrivateRenderAbort(data.renderJobId, claimedGen, abortCtrl);

      // 2. Continuous PostgreSQL lease heartbeat -> immediately SIGKILLs FFmpeg if lease lost or cancelled!
      const hbIntervalMs = Math.max(150, Math.floor(leaseMs / 3));
      let hbStopped = false;
      let hbTimer: NodeJS.Timeout | null = null;

      const scheduleHeartbeat = () => {
        if (hbStopped || abortCtrl.signal.aborted) return;
        hbTimer = setTimeout(async () => {
          if (hbStopped || abortCtrl.signal.aborted) return;
          try {
            const hb = await service.renewRenderLease({
              renderJobId: data.renderJobId,
              generation: claimedGen,
              ownerToken,
              leaseMs,
            });
            if (!hb.renewed && !abortCtrl.signal.aborted) {
              abortCtrl.abort(
                new MediaSourceError({
                  code: 'LEASE_EXPIRED',
                  message: `Worker "${workerId}" lost lease or job was cancelled (${data.renderJobId}, gen ${claimedGen}).`,
                }),
              );
              return;
            }
          } catch {
            // Single transient DB hiccup -> retry next tick; PostgreSQL CAS enforces ownership strictly
          }
          scheduleHeartbeat();
        }, hbIntervalMs);
        hbTimer.unref?.();
      };
      scheduleHeartbeat();

      const stopHeartbeat = () => {
        hbStopped = true;
        if (hbTimer) {
          clearTimeout(hbTimer);
          hbTimer = null;
        }
      };

      const assertNotAborted = () => {
        if (abortCtrl.signal.aborted) {
          const reason = abortCtrl.signal.reason;
          if (reason instanceof Error) throw reason;
          throw new MediaSourceError({
            code: 'REQUEST_CANCELLED',
            message: 'Private render aborted.',
          });
        }
      };

      const safeJobDir = data.renderJobId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const scratchDir = path.join(workRootDir, `${safeJobDir}_g${claimedGen}_${Date.now()}`);
      const bufferDir = path.join(scratchDir, 'segments');
      let uploadedKeyForRollback: string | null = null;

      try {
        await fs.mkdir(scratchDir, { recursive: true });

        if (opts.onBeforeRender) {
          await opts.onBeforeRender({
            renderJobId: data.renderJobId,
            generation: claimedGen,
            ownerToken,
            workerId,
            signal: abortCtrl.signal,
          });
        }
        assertNotAborted();

        // 3. Re-verify private project ownership + live PostgreSQL source rights at execution time
        const project = await db.project.findFirst({
          where: { id: renderRow.projectId, userId: renderRow.userId },
          include: { mediaSource: true, sourceAsset: true },
        });
        if (!project) {
          throw new MediaSourceError({
            code: 'SOURCE_UNAVAILABLE',
            message: 'Project is no longer available for this account.',
          });
        }

        const localSourcePath = path.join(scratchDir, 'source.mp4');

        if (project.mediaSource) {
          const scope: CacheRightsScope =
            project.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';
          const sourceDescriptor: CacheArtifactDescriptor = {
            artifactKind: 'SOURCE_MEDIA',
            sourceRevision: project.mediaSource.sourceRevision,
            algorithmVersion: 'vod-import-v1',
            rightsScope: scope,
          };

          // Strictly verify SOURCE_MEDIA + live rights + MinIO integrity via DurableArtifactPublisher!
          const verifiedSource = await publisher.getAuthorizedPublishedArtifact({
            requesterUserId: renderRow.userId,
            canonicalSourceId: project.mediaSource.canonicalId,
            descriptor: sourceDescriptor,
            verifyInStorage: true,
          });

          assertNotAborted();
          const obj = await storage.getObject({ key: verifiedSource.objectKey });
          await streamToFile(obj.body, localSourcePath);
        } else if (project.sourceAsset) {
          const obj = await storage.getObject({
            key: project.sourceAsset.s3Key,
            bucket: project.sourceAsset.bucket,
          });
          await streamToFile(obj.body, localSourcePath);
        } else {
          throw new MediaSourceError({
            code: 'SOURCE_UNAVAILABLE',
            message: 'No full source media is attached to this project.',
          });
        }

        assertNotAborted();

        // Enforce free-beta max clip duration in worker too
        const clipDuration = renderRow.windowEndSec - renderRow.windowStartSec;
        if (clipDuration <= 0 || clipDuration > service.policy.maxOutputDurationSec) {
          throw new MediaSourceError({
            code: 'ACCESS_DENIED',
            message: `Requested clip duration (${clipDuration.toFixed(1)}s) exceeds free-beta limit (${service.policy.maxOutputDurationSec}s).`,
          });
        }

        const okProg1 = await service.publishRenderProgressFenced({
          renderJobId: data.renderJobId,
          generation: claimedGen,
          ownerToken,
          stage: 'rendering_clip',
          progressPercent: 35,
        });
        if (!okProg1) {
          throw new MediaSourceError({
            code: 'LEASE_EXPIRED',
            message: 'Lost lease before starting FFmpeg render.',
          });
        }

        // 4. Real FFmpeg trim/effects + ffprobe validation
        const buffer = new FfmpegRollingSegmentBuffer({
          workDir: bufferDir,
          bufferConfig: {
            segmentDurationSec: 4,
            preEventSec: 10,
            postEventSec: 10,
            maxRetentionSec: Math.max(120, Math.ceil(renderRow.windowEndSec + 30)),
          },
        });

        const outPath = path.join(scratchDir, 'private-output.mp4');
        const renderSettings = (renderRow.renderSettings as Partial<CacheRenderSettings> | null) ?? {};
        const videoFilter = buildPrivateVideoFilter(renderSettings);

        try {
          await buffer.ingestFromSourceFile(localSourcePath, {
            markEndOfStream: true,
            signal: abortCtrl.signal,
          });
          assertNotAborted();

          await extractAndVerifyHighlightClip({
            buffer,
            windowStartSec: renderRow.windowStartSec,
            windowEndSec: renderRow.windowEndSec,
            outputPath: outPath,
            preferStreamCopy: !videoFilter,
            videoFilter,
            requireAudio: true,
            timeoutMs: Math.min(env.RENDER_TIMEOUT_MS, 5 * 60 * 1000),
            signal: abortCtrl.signal,
          });
        } finally {
          await buffer.cleanupAll().catch(() => {});
        }

        assertNotAborted();
        await service.publishRenderProgressFenced({
          renderJobId: data.renderJobId,
          generation: claimedGen,
          ownerToken,
          stage: 'validating_output',
          progressPercent: 75,
        });

        // Independent final ffprobe + SHA-256 verification before upload (never serve incomplete/corrupt MP4!)
        const verifiedMeta = await probeAndValidateClipMp4(outPath, {
          requireAudio: true,
        });
        const outBytes = await fs.readFile(outPath);
        if (outBytes.length !== verifiedMeta.sizeBytes || outBytes.length <= 0) {
          throw new MediaSourceError({
            code: 'ARTIFACT_CORRUPT',
            message: 'Rendered MP4 failed post-encode size verification.',
          });
        }

        assertNotAborted();
        await service.publishRenderProgressFenced({
          renderJobId: data.renderJobId,
          generation: claimedGen,
          ownerToken,
          stage: 'uploading_output',
          progressPercent: 90,
        });

        // 5. Upload immutable owner-scoped private MP4 to MinIO/S3
        const safeUser = renderRow.userId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeProj = renderRow.projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const outputObjectKey = `private/users/${safeUser}/renders/${safeProj}/${safeJobDir}/gen-${claimedGen}-${verifiedMeta.sha256.slice(0, 12)}.mp4`;

        const putRes = await storage.putObject({
          key: outputObjectKey,
          body: outBytes,
          contentType: 'video/mp4',
        });
        uploadedKeyForRollback = outputObjectKey;

        // Verify uploaded object exists & matches size in MinIO before committing READY
        const headMeta = await storage.getObjectMetadata({ key: outputObjectKey });
        if ((headMeta.contentLength ?? 0) !== outBytes.length) {
          throw new MediaSourceError({
            code: 'ARTIFACT_CORRUPT',
            message: 'Uploaded private MP4 size mismatch in object storage.',
            retryable: true,
          });
        }

        // 6. Re-check live PostgreSQL rights right before atomic fenced READY commit!
        assertNotAborted();
        if (project.mediaSource) {
          const scope: CacheRightsScope =
            project.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';
          await registry.resolveServerTrustedAuth({
            requesterUserId: renderRow.userId,
            canonicalSourceId: project.mediaSource.canonicalId,
            requireSharedReuse: scope === 'SHARED_PERMITTED',
          });
        }

        const committed = await service.commitRenderReadyFenced({
          renderJobId: data.renderJobId,
          generation: claimedGen,
          ownerToken,
          outputObjectKey,
          outputSha256: verifiedMeta.sha256,
          outputEtag: putRes.etag ?? headMeta.etag ?? null,
          outputSizeBytes: outBytes.length,
          outputDurationSec: verifiedMeta.durationSec,
          outputWidth: verifiedMeta.width,
          outputHeight: verifiedMeta.height,
        });

        if (!committed) {
          // Job was cancelled or fenced out right before commit -> clean up unreferenced object!
          await storage.deleteObject({ key: outputObjectKey }).catch(() => {});
          uploadedKeyForRollback = null;
          throw new MediaSourceError({
            code: 'LEASE_EXPIRED',
            message: 'Private render was cancelled or superseded before commit.',
          });
        }

        uploadedKeyForRollback = null;
        return {
          renderJobId: data.renderJobId,
          generation: claimedGen,
          sizeBytes: outBytes.length,
          durationSec: verifiedMeta.durationSec,
        };
      } catch (err) {
        stopHeartbeat();
        if (uploadedKeyForRollback) {
          await storage.deleteObject({ key: uploadedKeyForRollback }).catch(() => {});
        }

        const isMediaErr = err instanceof MediaSourceError;
        const abortReason = abortCtrl.signal.aborted ? abortCtrl.signal.reason : undefined;
        const effectiveCode =
          isMediaErr
            ? err.code
            : abortReason instanceof MediaSourceError
              ? abortReason.code
              : 'INFRA_ERROR';
        const rawMessage = err instanceof Error ? err.message : String(err);
        // Never leak raw storage paths into persisted user-facing error messages
        const sanitizedMessage =
          effectiveCode === 'SOURCE_UNAVAILABLE'
            ? 'Full source video is unavailable or has expired for this project.'
            : effectiveCode === 'ACCESS_DENIED' ||
                effectiveCode === 'RIGHTS_UNVERIFIED' ||
                effectiveCode === 'DRM_RESTRICTED'
              ? 'Source access is not authorized or has been revoked.'
              : rawMessage.replace(/private\/users\/[^\s)'"]+/g, '[private-object]').slice(0, 400);

        if (effectiveCode === 'REQUEST_CANCELLED' || effectiveCode === 'LEASE_EXPIRED') {
          throw new UnrecoverableError(`${effectiveCode}: ${sanitizedMessage}`);
        }

        const nonRetryable = NON_RETRYABLE_CODES.has(effectiveCode);
        const maxAttempts = job.opts.attempts ?? renderRow.maxAttempts;
        const isFinalAttempt = nonRetryable || attemptNum >= maxAttempts;

        if (isFinalAttempt) {
          const committedFail = await service
            .commitRenderFailedFenced({
              renderJobId: data.renderJobId,
              generation: claimedGen,
              ownerToken,
              errorCode: effectiveCode,
              errorMessage: sanitizedMessage,
            })
            .catch(() => false);
          if (committedFail) {
            await moveToDeadLetter(queueName, data, `${effectiveCode}: ${sanitizedMessage}`).catch(() => {});
          }
        } else {
          await service
            .releaseRenderForRetry({
              renderJobId: data.renderJobId,
              generation: claimedGen,
              ownerToken,
              errorCode: effectiveCode,
              errorMessage: sanitizedMessage,
            })
            .catch(() => {});
        }

        if (nonRetryable) {
          throw new UnrecoverableError(`${effectiveCode}: ${sanitizedMessage}`);
        }
        throw err;
      } finally {
        stopHeartbeat();
        unregisterLocalPrivateRenderAbort(data.renderJobId, claimedGen);
        await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    {
      connection: bullConn,
      concurrency,
      lockDuration: 60_000,
    },
  );

  const originalClose = worker.close.bind(worker);
  worker.close = (async (force?: boolean) => {
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    return originalClose(force);
  }) as typeof worker.close;

  return { worker, service };
}
