import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CacheableSourceId } from '@autoedit/contracts';
import { bullConnection as defaultBullConnection, connection as defaultRedis } from '../../lib/redis.js';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { getStorageProvider } from '../../storage/index.js';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import {
  MEDIA_PROCESS_QUEUE,
  moveToDeadLetter,
  type MediaProcessJobData,
} from '../queues.js';
import { MediaSourceError } from '../../media/errors.js';
import {
  RedisCoordinationStore,
  SharedIngestionCoordinator,
  type RedisLikeClient,
} from '../../media/ingestion-coordinator.js';
import { UnifiedVodProcessingService } from '../../media/vod/unified-vod-pipeline.js';
import { ControlledVodAcquisitionAdapter } from '../../media/vod/controlled-vod.adapter.js';
import { ContinuousLiveSessionService } from '../../media/live/continuous-live-session.js';
import { getControlledTestFixture } from '../../media/api/controlled-fixture-registry.js';
import {
  registerLocalSharedWorkAbort,
  unregisterLocalSharedWorkAbort,
} from '../../media/api/universal-media.service.js';

const NON_RETRYABLE_CODES = new Set([
  'ACCESS_DENIED',
  'RIGHTS_UNVERIFIED',
  'DRM_RESTRICTED',
  'UNSUPPORTED_ACQUISITION',
  'BROADCAST_UNRESOLVED',
  'MALFORMED_URL',
  'UNSUPPORTED_SCHEME',
  'UNSUPPORTED_PROVIDER',
  'SSRF_BLOCKED',
  'PRIVATE_NETWORK_BLOCKED',
  'REQUEST_CANCELLED',
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

export interface CreateMediaWorkerOptions {
  queueName?: string;
  db?: PrismaClient;
  storage?: MediaStorageProvider;
  redis?: RedisLikeClient;
  bullConnection?: typeof defaultBullConnection;
  workRootDir?: string;
  keyPrefix?: string;
  concurrency?: number;
}

/**
 * Factory creating a real BullMQ Worker for universal media jobs (controlled VODs,
 * existing private user uploads, and controlled continuous livestreams).
 *
 * - Bounded concurrency (`2` by default, suitable for 100 initial beta users).
 * - Fan-out updates ALL non-cancelled MediaProcessingJob rows referencing `sharedWorkKey`.
 * - Non-retryable rights/validation/unsupported errors fail immediately via UnrecoverableError
 *   instead of retrying endlessly.
 * - Transient crashes retry with exponential backoff and park in dead-letter queue on exhaustion.
 * - Respects subscriber cancellation: aborts ONLY when zero active subscribers remain!
 */
export function createMediaWorker(opts: CreateMediaWorkerOptions = {}) {
  const queueName = opts.queueName ?? MEDIA_PROCESS_QUEUE;
  const db = opts.db ?? defaultPrisma;
  const storage = opts.storage ?? getStorageProvider();
  const redis = opts.redis ?? (defaultRedis as unknown as RedisLikeClient);
  const bullConn = opts.bullConnection ?? defaultBullConnection;
  const keyPrefix = opts.keyPrefix ?? 'autoedit:media:api:';
  const workRootDir = opts.workRootDir ?? path.resolve(process.cwd(), 'tmp', 'media-worker');
  const concurrency = opts.concurrency ?? 2;

  const coordStore = new RedisCoordinationStore(redis, {
    keyPrefix: `${keyPrefix}coord:`,
    recordTtlMs: 24 * 60 * 60 * 1000,
  });
  const coordinator = new SharedIngestionCoordinator(coordStore);
  const vodService = new UnifiedVodProcessingService(db, coordinator, storage, workRootDir, {
    quotaRedis: redis,
    quotaPrefix: `${keyPrefix}quota:`,
  });
  const liveService = new ContinuousLiveSessionService(coordinator, storage, workRootDir);

  const updateActiveSubscribers = async (
    sharedWorkKey: string,
    data: Prisma.MediaProcessingJobUpdateManyMutationInput,
  ) => {
    await db.mediaProcessingJob.updateMany({
      where: {
        sharedWorkKey,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      data,
    });
  };

  const markActiveSubscribersReady = async (
    sharedWorkKey: string,
    resultSummary: Prisma.InputJsonValue,
  ) => {
    const readyData: Prisma.MediaProcessingJobUpdateManyMutationInput = {
      status: 'READY',
      stage: 'completed',
      progressPercent: 100,
      completedAt: new Date(),
      resultSummary,
    };
    // 1st commit makes READY visible to subsequent lateReady queries;
    // 2nd sweep catches any rows whose INSERT committed during the 1st UPDATE's MVCC snapshot!
    await updateActiveSubscribers(sharedWorkKey, readyData);
    await updateActiveSubscribers(sharedWorkKey, readyData);
  };

  const hasActiveSubscribers = async (sharedWorkKey: string): Promise<boolean> => {
    const count = await db.mediaProcessingJob.count({
      where: {
        sharedWorkKey,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });
    return count > 0;
  };

  const worker = new Worker<MediaProcessJobData>(
    queueName,
    async (job: Job<MediaProcessJobData>) => {
      const data = job.data;
      const attemptNum = job.attemptsMade + 1;
      const workerId = `bull_media_${process.pid}_${job.id ?? Date.now()}_a${attemptNum}`;
      const abortCtrl = new AbortController();
      registerLocalSharedWorkAbort(data.sharedWorkKey, abortCtrl);

      // Periodic check: abort ONLY if zero active subscribers remain (or Redis cancel flag set)
      const cancelPoll = setInterval(async () => {
        try {
          const active = await hasActiveSubscribers(data.sharedWorkKey);
          if (!active && !abortCtrl.signal.aborted) {
            abortCtrl.abort(
              new MediaSourceError({
                code: 'REQUEST_CANCELLED',
                message: 'All clippers cancelled; stopping shared work.',
              }),
            );
          }
        } catch {
          // ignore transient poll error
        }
      }, 250);
      cancelPoll.unref?.();

      const tempUploadDir = path.join(workRootDir, `up_${job.id ?? Date.now()}_${Date.now()}`);
      let releaseEnqLock = true;

      try {
        if (!(await hasActiveSubscribers(data.sharedWorkKey))) {
          return { skipped: true, reason: 'all_subscribers_cancelled' };
        }

        // Re-check authoritative PostgreSQL rights at execution time (never trust enqueue-time state!)
        const scope = data.sourceType === 'uploaded' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';
        await vodService.registry.resolveServerTrustedAuth({
          requesterUserId: data.initiatedByUserId,
          canonicalSourceId: data.canonicalSourceId,
          requireAcquisition: true,
          requireSharedReuse: scope === 'SHARED_PERMITTED',
        });

        await updateActiveSubscribers(data.sharedWorkKey, {
          status: 'RUNNING',
          stage: 'acquiring_source',
          progressPercent: 10,
          startedAt: new Date(),
          bullJobId: job.id ? String(job.id) : null,
        });

        // ─────────────────────────────────────────────────────────────────────
        // PATH A: Controlled Continuous Livestream Session
        // ─────────────────────────────────────────────────────────────────────
        if (data.controlledFixtureKey) {
          const fixture = getControlledTestFixture(data.controlledFixtureKey);
          if (!fixture) {
            throw new MediaSourceError({
              code: 'SOURCE_UNAVAILABLE',
              message: `Controlled fixture "${data.controlledFixtureKey}" is unavailable in worker.`,
            });
          }

          if (fixture.onWorkerAttempt) {
            await fixture.onWorkerAttempt(attemptNum);
          }

          if (fixture.kind === 'live') {
            const liveHighlights: Array<Record<string, unknown>> = [];
            const optsIn = data.options ?? {};

            const liveRes = await liveService.joinOrStartContinuousBroadcast({
              adapter: fixture.adapter,
              requesterUserId: data.initiatedByUserId,
              workerId,
              sourceRevision: optsIn.sourceRevision ?? 'v1',
              bufferConfig: {
                segmentDurationSec: fixture.adapter.streamOptions.segmentDurationSec,
                preEventSec: optsIn.preRollSec ?? 6,
                postEventSec: optsIn.postRollSec ?? 4,
                maxRetentionSec: 60,
              },
              cooldownSec: optsIn.cooldownSec ?? 12,
              scoreThreshold: optsIn.scoreThreshold ?? 65,
              aggregationWindowSec: 3,
              signal: abortCtrl.signal,
              onHighlightReady: async (clip) => {
                liveHighlights.push({
                  candidate: clip.candidate,
                  cacheKey: clip.cacheKey,
                  objectKey: clip.objectKey,
                  descriptor: clip.descriptor,
                  clipMeta: clip.clipMeta,
                  reusedFromCache: clip.reusedFromCache,
                });
                // Surface newly generated live highlights IMMEDIATELY while stream stays RUNNING!
                await updateActiveSubscribers(data.sharedWorkKey, {
                  stage: `streaming_live_${liveHighlights.length}_highlights`,
                  progressPercent: Math.min(95, 25 + liveHighlights.length * 20),
                  resultSummary: {
                    highlightsCount: liveHighlights.length,
                    highlights: liveHighlights,
                    streamStatus: 'LIVE',
                  } as Prisma.InputJsonValue,
                });
              },
            });

            const finalSummaryHighlights = liveRes.highlights.map((clip) => ({
              candidate: clip.candidate,
              cacheKey: clip.cacheKey,
              objectKey: clip.objectKey,
              descriptor: clip.descriptor,
              clipMeta: clip.clipMeta,
              reusedFromCache: clip.reusedFromCache,
            }));

            await markActiveSubscribersReady(data.sharedWorkKey, {
              highlightsCount: finalSummaryHighlights.length,
              highlights: finalSummaryHighlights,
              streamStatus: 'ENDED',
            } as unknown as Prisma.InputJsonValue);

            return {
              sharedWorkKey: data.sharedWorkKey,
              highlightsCount: finalSummaryHighlights.length,
            };
          }

          // ───────────────────────────────────────────────────────────────────
          // PATH B: Controlled VOD Acquisition → Analysis → Base Clips
          // ───────────────────────────────────────────────────────────────────
          const optsIn = data.options ?? {};
          const srcRes = await vodService.acquireOrReuseVodSource({
            adapter: fixture.adapter,
            requesterUserId: data.initiatedByUserId,
            workerId,
            sourceRevision: optsIn.sourceRevision ?? 'v1',
            rightsScope: scope,
            signal: abortCtrl.signal,
          });

          await updateActiveSubscribers(data.sharedWorkKey, {
            stage: 'analyzing_highlights',
            progressPercent: 45,
          });

          const anaRes = await vodService.analyzeOrReuseVodHighlights({
            canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
            sourceDescriptor: srcRes.descriptor,
            requesterUserId: data.initiatedByUserId,
            workerId,
            sourceRevision: optsIn.sourceRevision ?? 'v1',
            rightsScope: scope,
            preRollSec: optsIn.preRollSec ?? 6,
            postRollSec: optsIn.postRollSec ?? 4,
            cooldownSec: optsIn.cooldownSec ?? 12,
            scoreThreshold: optsIn.scoreThreshold ?? 65,
            enableLocalWhisper: optsIn.enableLocalWhisper ?? false,
            signal: abortCtrl.signal,
          });

          await updateActiveSubscribers(data.sharedWorkKey, {
            stage: 'generating_base_clips',
            progressPercent: 70,
          });

          const generatedClips = [];
          for (const cand of anaRes.candidates) {
            if (abortCtrl.signal.aborted) break;
            const clip = await vodService.generateOrReuseVodBaseClip({
              canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
              sourceDescriptor: srcRes.descriptor,
              candidate: cand,
              requesterUserId: data.initiatedByUserId,
              workerId,
              sourceRevision: optsIn.sourceRevision ?? 'v1',
              rightsScope: scope,
              renderSettings: optsIn.renderSettings
                ? {
                    format: optsIn.renderSettings.format ?? 'reel',
                    width: optsIn.renderSettings.width ?? 1280,
                    height: optsIn.renderSettings.height ?? 720,
                    fps: optsIn.renderSettings.fps ?? 30,
                    subtitles: optsIn.renderSettings.subtitles ?? false,
                    zooms: optsIn.renderSettings.zooms ?? false,
                    transitions: optsIn.renderSettings.transitions ?? 'none',
                    music: optsIn.renderSettings.music ?? false,
                  }
                : undefined,
              signal: abortCtrl.signal,
            });
            generatedClips.push({
              candidate: cand,
              cacheKey: clip.cacheKey,
              objectKey: clip.objectKey,
              descriptor: clip.descriptor,
              clipMeta: clip.clipMeta,
              reusedFromCache: clip.reusedFromCache,
            });
          }

          await markActiveSubscribersReady(data.sharedWorkKey, {
            highlightsCount: generatedClips.length,
            highlights: generatedClips,
          } as unknown as Prisma.InputJsonValue);

          return { sharedWorkKey: data.sharedWorkKey, highlightsCount: generatedClips.length };
        }

        // ─────────────────────────────────────────────────────────────────────
        // PATH C: Existing Authenticated User Direct Upload Project
        // ─────────────────────────────────────────────────────────────────────
        if (data.sourceType === 'uploaded' && data.uploadProjectId) {
          const project = await db.project.findFirst({
            where: { id: data.uploadProjectId, userId: data.initiatedByUserId },
            include: { sourceAsset: true },
          });
          if (!project || !project.sourceAsset) {
            throw new MediaSourceError({
              code: 'SOURCE_UNAVAILABLE',
              message: 'Uploaded source asset not found for owner.',
            });
          }

          await fs.mkdir(tempUploadDir, { recursive: true });
          const localMp4 = path.join(tempUploadDir, 'uploaded-source.mp4');
          const obj = await storage.getObject({
            key: project.sourceAsset.s3Key,
            bucket: project.sourceAsset.bucket,
          });
          await streamToFile(obj.body, localMp4);

          const uploadAdapter = new ControlledVodAcquisitionAdapter({
            enabled: true,
            archetype: 'private_user_upload',
            vodId: project.sourceAsset.id,
            ownerUserId: data.initiatedByUserId,
            fixturePath: localMp4,
            title: project.title,
          });

          const optsIn = data.options ?? {};
          const srcRes = await vodService.acquireOrReuseVodSource({
            adapter: uploadAdapter,
            requesterUserId: data.initiatedByUserId,
            workerId,
            rightsScope: 'PRIVATE_USER',
            signal: abortCtrl.signal,
          });

          await updateActiveSubscribers(data.sharedWorkKey, {
            stage: 'analyzing_highlights',
            progressPercent: 50,
          });

          const anaRes = await vodService.analyzeOrReuseVodHighlights({
            canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
            sourceDescriptor: srcRes.descriptor,
            requesterUserId: data.initiatedByUserId,
            workerId,
            rightsScope: 'PRIVATE_USER',
            preRollSec: optsIn.preRollSec ?? 6,
            postRollSec: optsIn.postRollSec ?? 4,
            cooldownSec: optsIn.cooldownSec ?? 12,
            scoreThreshold: optsIn.scoreThreshold ?? 65,
            signal: abortCtrl.signal,
          });

          const generatedClips = [];
          for (const cand of anaRes.candidates) {
            const clip = await vodService.generateOrReuseVodBaseClip({
              canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
              sourceDescriptor: srcRes.descriptor,
              candidate: cand,
              requesterUserId: data.initiatedByUserId,
              workerId,
              rightsScope: 'PRIVATE_USER',
              signal: abortCtrl.signal,
            });
            generatedClips.push({
              candidate: cand,
              cacheKey: clip.cacheKey,
              objectKey: clip.objectKey,
              descriptor: clip.descriptor,
              clipMeta: clip.clipMeta,
              reusedFromCache: clip.reusedFromCache,
            });
          }

          await markActiveSubscribersReady(data.sharedWorkKey, {
            highlightsCount: generatedClips.length,
            highlights: generatedClips,
          } as unknown as Prisma.InputJsonValue);

          return { sharedWorkKey: data.sharedWorkKey, highlightsCount: generatedClips.length };
        }

        throw new MediaSourceError({
          code: 'UNSUPPORTED_ACQUISITION',
          message: 'No permitted acquisition adapter available for this job payload.',
        });
      } catch (err) {
        const isMediaErr = err instanceof MediaSourceError;
        const code = isMediaErr ? err.code : 'INFRA_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        const nonRetryable = isMediaErr && NON_RETRYABLE_CODES.has(err.code);
        const maxAttempts = job.opts.attempts ?? 3;
        const isFinalAttempt = nonRetryable || attemptNum >= maxAttempts;

        if (isFinalAttempt) {
          if (code !== 'REQUEST_CANCELLED') {
            await updateActiveSubscribers(data.sharedWorkKey, {
              status: 'FAILED',
              stage: 'failed',
              errorCode: code,
              errorMessage: message,
            });
            await moveToDeadLetter(queueName, data, `${code}: ${message}`).catch(() => {});
          }
          releaseEnqLock = true;
        } else {
          // Keep enqueue lock held during bounded BullMQ retry backoff so late joiners attach
          releaseEnqLock = false;
        }

        if (nonRetryable) {
          throw new UnrecoverableError(`${code}: ${message}`);
        }
        throw err;
      } finally {
        clearInterval(cancelPoll);
        unregisterLocalSharedWorkAbort(data.sharedWorkKey);
        if (releaseEnqLock) {
          await redis
            .eval(`return redis.call('DEL', KEYS[1])`, 1, `${keyPrefix}enq:${data.sharedWorkKey}`)
            .catch(() => {});
        }
        await fs.rm(tempUploadDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    {
      connection: bullConn,
      concurrency,
    },
  );

  return { worker, vodService, liveService };
}
