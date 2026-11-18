import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CacheableSourceId, MediaProcessJobPayload } from '@autoedit/contracts';
import { bullConnection as defaultBullConnection, connection as defaultRedis } from '../../lib/redis.js';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { getStorageProvider } from '../../storage/index.js';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import {
  MEDIA_PROCESS_QUEUE,
  enqueueMediaProcess,
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
import { FfmpegRollingSegmentBuffer } from '../../media/live/rolling-segment-buffer.js';
import { extractAudioSignalsFromSegments } from '../../media/live/audio-signal-extractor.js';
import { extractAndVerifyHighlightClip } from '../../media/live/highlight-clip-extractor.js';
import { CpuFirstHeuristicDetector } from '../../media/highlight-detector.js';
import { AuthorizedDirectMediaAdapter } from '../../media/acquisition/authorized-direct-media.adapter.js';
import { buildDefaultPlatformProviderConfig } from '../../media/providers/platform-resolver.service.js';
import type { PlatformProviderConfig } from '../../media/providers/types.js';
import type { CacheArtifactDescriptor } from '../../media/shared-cache.js';
import { getControlledTestFixture } from '../../media/api/controlled-fixture-registry.js';
import {
  SharedWorkCoordinator,
  buildGenerationBullJobId,
} from '../../media/api/shared-work-coordinator.js';
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
  'LEASE_EXPIRED',
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
  /** Durable PostgreSQL & Redis lease duration in ms; renewed continuously every leaseMs/3. Defaults to 30_000. */
  leaseMs?: number;
  /** Periodic stranded-work reconciliation interval in ms (0 disables timer). Defaults to 15_000. */
  reconcileIntervalMs?: number;
  /** Optional custom enqueue function for crash-recovery re-dispatch (defaults to enqueueMediaProcess). */
  enqueueRecoveryJob?: (
    payload: MediaProcessJobPayload,
    opts: { jobId: string },
  ) => Promise<{ id?: string }>;
  /** Injectable clock for deterministic lease/recovery tests. */
  now?: () => Date;
  /** Optional worker identity prefix (useful in multi-worker tests). */
  workerIdPrefix?: string;
  /** Optional lifecycle hook invoked right after durable PostgreSQL ownership claim. */
  onClaimed?: (ctx: {
    sharedWorkKey: string;
    generation: number;
    ownerToken: string;
    workerId: string;
  }) => Promise<void> | void;
  /** Optional platform config for authorized direct-media host allowlists & HTTP options. */
  platformConfig?: PlatformProviderConfig;
}

/**
 * Factory creating a real BullMQ Worker for universal media jobs (controlled VODs,
 * existing private user uploads, and controlled continuous livestreams).
 *
 * Step 3B.9.1 Reliability & Fencing Guarantees:
 * - Durable PostgreSQL ownership claim (`SharedMediaWork` `FOR UPDATE` + monotonic `generation`
 *   + unique `ownerToken` + `leaseExpiresAt`) prevents duplicate execution even if Redis loses keys.
 * - Continuous dual heartbeat (PostgreSQL + Redis) keeps long VODs & multi-hour livestreams
 *   alive past any fixed TTL, and immediately aborts FFmpeg if ownership is fenced out.
 * - Atomic Lua compare-and-delete lock release in `finally` NEVER deletes a newer owner's lock.
 * - Single-transaction `commitWorkReady` under `SharedMediaWork FOR UPDATE` eliminates late-subscriber
 *   races and guarantees `CANCELLED -> READY` and `READY -> RUNNING` regressions never occur.
 * - Bounded background reconciler recovers stranded `PENDING_ENQUEUE` and expired `RUNNING` leases.
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
  const leaseMs = opts.leaseMs ?? 30_000;
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? 15_000;
  const workerIdPrefix = opts.workerIdPrefix ?? `bull_media_${process.pid}`;
  const platformConfig = opts.platformConfig ?? buildDefaultPlatformProviderConfig();

  const enqueueRecoveryFn =
    opts.enqueueRecoveryJob ??
    ((payload: MediaProcessJobPayload, enqueueOpts: { jobId: string }) =>
      enqueueMediaProcess(payload, {
        jobId:
          enqueueOpts.jobId ||
          buildGenerationBullJobId(payload.sharedWorkKey, payload.generation ?? 1),
      }));

  const coordStore = new RedisCoordinationStore(redis, {
    keyPrefix: `${keyPrefix}coord:`,
    recordTtlMs: 24 * 60 * 60 * 1000,
  });
  const coordinator = new SharedIngestionCoordinator(coordStore);
  const sharedWork = new SharedWorkCoordinator(db, redis, {
    keyPrefix,
    defaultLeaseMs: leaseMs,
    now: opts.now,
  });
  const vodService = new UnifiedVodProcessingService(db, coordinator, storage, workRootDir, {
    quotaRedis: redis,
    quotaPrefix: `${keyPrefix}quota:`,
  });
  const liveService = new ContinuousLiveSessionService(coordinator, storage, workRootDir);

  let reconcileTimer: NodeJS.Timeout | null = null;
  if (reconcileIntervalMs > 0) {
    reconcileTimer = setInterval(() => {
      sharedWork
        .reconcileStrandedWork({ enqueueFn: enqueueRecoveryFn, batchSize: 10 })
        .catch(() => {});
    }, reconcileIntervalMs);
    reconcileTimer.unref?.();
  }

  const worker = new Worker<MediaProcessJobData>(
    queueName,
    async (job: Job<MediaProcessJobData>) => {
      const data = job.data;
      const attemptNum = job.attemptsMade + 1;
      const workerId = `${workerIdPrefix}_${job.id ?? Date.now()}_a${attemptNum}`;

      // 1. Durable PostgreSQL ownership claim (fences stale generations & duplicate workers even if Redis flushed!)
      const claim = await sharedWork.claimWorkExecution({
        sharedWorkKey: data.sharedWorkKey,
        payloadGeneration: data.generation,
        workerId,
        bullJobId: job.id ? String(job.id) : undefined,
        leaseMs,
      });

      if (claim.action !== 'CLAIMED') {
        return {
          skipped: true,
          reason: claim.action,
          sharedWorkKey: data.sharedWorkKey,
        };
      }

      const claimedGen = claim.generation;
      const ownerToken = claim.ownerToken;
      const abortCtrl = new AbortController();
      registerLocalSharedWorkAbort(data.sharedWorkKey, claimedGen, abortCtrl);

      if (opts.onClaimed) {
        await opts.onClaimed({
          sharedWorkKey: data.sharedWorkKey,
          generation: claimedGen,
          ownerToken,
          workerId,
        });
      }

      // 2. Continuous dual heartbeat (PostgreSQL lease + Redis lock) + zero-subscriber cancellation watchdog
      const hbIntervalMs = Math.max(150, Math.floor(leaseMs / 3));
      let hbStopped = false;
      let hbTimer: NodeJS.Timeout | null = null;

      const scheduleHeartbeat = () => {
        if (hbStopped || abortCtrl.signal.aborted) return;
        hbTimer = setTimeout(async () => {
          if (hbStopped || abortCtrl.signal.aborted) return;
          try {
            const hb = await sharedWork.renewWorkLease({
              sharedWorkKey: data.sharedWorkKey,
              generation: claimedGen,
              ownerToken,
              leaseMs,
            });
            if (!hb.renewed) {
              if (!abortCtrl.signal.aborted) {
                abortCtrl.abort(
                  new MediaSourceError({
                    code: 'LEASE_EXPIRED',
                    message: `Worker ${workerId} lost durable ownership lease on ${data.sharedWorkKey} (gen ${claimedGen}).`,
                  }),
                );
              }
              return;
            }
            if (hb.activeSubscribers === 0 && !abortCtrl.signal.aborted) {
              abortCtrl.abort(
                new MediaSourceError({
                  code: 'REQUEST_CANCELLED',
                  message: 'All clippers cancelled; stopping shared work.',
                }),
              );
              return;
            }
          } catch {
            // Single transient DB/network hiccup -> retry on next tick; PostgreSQL CAS still enforces lease strictly!
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
            message: 'Shared media job aborted.',
          });
        }
      };

      const tempUploadDir = path.join(workRootDir, `up_${job.id ?? Date.now()}_${Date.now()}`);

      try {
        // Re-check authoritative PostgreSQL rights at execution time (never trust enqueue-time state!)
        const scope = data.sourceType === 'uploaded' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';
        await vodService.registry.resolveServerTrustedAuth({
          requesterUserId: data.initiatedByUserId,
          canonicalSourceId: data.canonicalSourceId,
          requireAcquisition: true,
          requireSharedReuse: scope === 'SHARED_PERMITTED',
        });

        assertNotAborted();

        // ─────────────────────────────────────────────────────────────────────
        // PATH A: Controlled Test Fixture (LIVE or VOD — strictly disabled in prod!)
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

          assertNotAborted();

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
                // Fenced live-highlight update while stream stays RUNNING!
                await sharedWork.publishProgressFenced({
                  sharedWorkKey: data.sharedWorkKey,
                  generation: claimedGen,
                  ownerToken,
                  stage: `streaming_live_${liveHighlights.length}_highlights`,
                  progressPercent: Math.min(95, 25 + liveHighlights.length * 20),
                  resultSummary: {
                    highlightsCount: liveHighlights.length,
                    highlights: liveHighlights,
                    streamStatus: 'LIVE',
                  } as unknown as Prisma.InputJsonValue,
                });
              },
            });

            assertNotAborted();

            const finalSummaryHighlights = liveRes.highlights.map((clip) => ({
              candidate: clip.candidate,
              cacheKey: clip.cacheKey,
              objectKey: clip.objectKey,
              descriptor: clip.descriptor,
              clipMeta: clip.clipMeta,
              reusedFromCache: clip.reusedFromCache,
            }));

            await sharedWork.commitWorkReady({
              sharedWorkKey: data.sharedWorkKey,
              generation: claimedGen,
              ownerToken,
              resultSummary: {
                highlightsCount: finalSummaryHighlights.length,
                highlights: finalSummaryHighlights,
                streamStatus: 'ENDED',
              } as unknown as Prisma.InputJsonValue,
            });

            return {
              sharedWorkKey: data.sharedWorkKey,
              generation: claimedGen,
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

          assertNotAborted();
          await sharedWork.publishProgressFenced({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
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

          assertNotAborted();
          await sharedWork.publishProgressFenced({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
            stage: 'generating_base_clips',
            progressPercent: 70,
          });

          const generatedClips = [];
          for (const cand of anaRes.candidates) {
            assertNotAborted();
            const clip = await vodService.generateOrReuseVodBaseClip({
              canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
              sourceDescriptor: srcRes.descriptor,
              candidate: cand,
              requesterUserId: data.initiatedByUserId,
              workerId,
              sourceRevision: optsIn.sourceRevision ?? 'v1',
              rightsScope: scope,
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

          assertNotAborted();
          await sharedWork.commitWorkReady({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
            resultSummary: {
              highlightsCount: generatedClips.length,
              highlights: generatedClips,
            } as unknown as Prisma.InputJsonValue,
          });

          return {
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            highlightsCount: generatedClips.length,
          };
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

          assertNotAborted();
          await sharedWork.publishProgressFenced({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
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
            assertNotAborted();
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

          assertNotAborted();
          await sharedWork.commitWorkReady({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
            resultSummary: {
              highlightsCount: generatedClips.length,
              highlights: generatedClips,
            } as unknown as Prisma.InputJsonValue,
          });

          return {
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            highlightsCount: generatedClips.length,
          };
        }

        // ─────────────────────────────────────────────────────────────────────
        // PATH D: Real Authorized Direct Media URL (VOD MP4 or Live/Recorded HLS .m3u8)
        // ─────────────────────────────────────────────────────────────────────
        if (data.directMediaUrl) {
          const allowedHosts = platformConfig.directMediaAllowedHosts ?? new Set<string>();
          const parsedDirect = new URL(data.directMediaUrl);
          const directHost = parsedDirect.hostname.toLowerCase().replace(/\.$/, '');
          if (!allowedHosts.has(directHost)) {
            throw new MediaSourceError({
              code: 'SSRF_BLOCKED',
              message: `Direct media host "${directHost}" is not in server allowlist.`,
            });
          }

          const optsIn = data.options ?? {};
          const directAdapter = new AuthorizedDirectMediaAdapter({
            canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
            mediaUrl: data.directMediaUrl,
            allowedHosts,
            maxBytes: platformConfig.maxDirectMediaBytes,
            fetchImpl: platformConfig.http?.fetchImpl,
            dnsLookup: platformConfig.http?.dnsLookup,
            allowLocalhostForTest: platformConfig.http?.allowLocalhostForTest,
            hlsPollIntervalMs: 350,
            hlsMaxSessionMs: 120_000,
          });

          // D1. Real Live HLS incremental ingestion -> emits highlights BEFORE broadcast ends!
          if (data.sourceType === 'live') {
            await fs.mkdir(tempUploadDir, { recursive: true });
            const buffer = new FfmpegRollingSegmentBuffer({
              workDir: path.join(tempUploadDir, 'hls-buffer'),
              bufferConfig: {
                segmentDurationSec: 4,
                preEventSec: optsIn.preRollSec ?? 6,
                postEventSec: optsIn.postRollSec ?? 4,
                maxRetentionSec: 120,
              },
            });
            const detector = new CpuFirstHeuristicDetector({
              canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
              bufferConfig: {
                segmentDurationSec: 4,
                preEventSec: optsIn.preRollSec ?? 6,
                postEventSec: optsIn.postRollSec ?? 4,
                maxRetentionSec: 120,
              },
              cooldownSec: optsIn.cooldownSec ?? 12,
              scoreThreshold: optsIn.scoreThreshold ?? 65,
              aggregationWindowSec: 3,
            });
            const liveHighlights: Array<Record<string, unknown>> = [];
            const emittedKeys = new Set<string>();
            const analyzedSegIndices = new Set<number>();
            const defaultBaseRender = {
              format: 'reel' as const,
              width: 1280,
              height: 720,
              fps: 30,
              subtitles: false,
              zooms: false,
              transitions: 'none' as const,
              music: false,
            };

            try {
              await directAdapter.ingestLiveHlsIncrementally({
                buffer,
                scratchDir: path.join(tempUploadDir, 'hls-seg'),
                signal: abortCtrl.signal,
                onBatchIngested: async ({ ended }) => {
                  assertNotAborted();
                  const newSegs = buffer.getValidSegments().filter((s) => !analyzedSegIndices.has(s.index));
                  if (newSegs.length > 0) {
                    const extracted = await extractAudioSignalsFromSegments(newSegs);
                    for (const s of extracted.samples) detector.ingestSignal(s);
                    for (const seg of newSegs) analyzedSegIndices.add(seg.index);
                  }
                  const latestSec = buffer.getLatestBufferedSec();
                  const candidates = detector.evaluate(latestSec);

                  for (const cand of candidates) {
                    assertNotAborted();
                    const keyTag = `${Math.round(cand.windowStartSec)}_${Math.round(cand.windowEndSec)}`;
                    if (emittedKeys.has(keyTag)) continue;
                    if (!ended && !buffer.isWindowReady(cand.windowEndSec)) continue;
                    if (cand.windowStartSec >= latestSec) continue;

                    const clipDescriptor: CacheArtifactDescriptor = {
                      artifactKind: 'BASE_CLIP',
                      sourceRevision: optsIn.sourceRevision ?? 'v1',
                      timeRangeSec: { start: cand.windowStartSec, end: cand.windowEndSec },
                      algorithmVersion: cand.algorithmVersion,
                      renderSettings: defaultBaseRender,
                      rightsScope: 'SHARED_PERMITTED',
                    };

                    const clipOut = path.join(tempUploadDir, `live_hl_${liveHighlights.length}.mp4`);
                    const clipMeta = await extractAndVerifyHighlightClip({
                      buffer,
                      windowStartSec: cand.windowStartSec,
                      windowEndSec: Math.min(latestSec, cand.windowEndSec),
                      outputPath: clipOut,
                      preferStreamCopy: true,
                      requireAudio: true,
                      signal: abortCtrl.signal,
                    });
                    const clipBytes = await fs.readFile(clipOut);

                    const resv = await vodService.publisher.reservePublicationGeneration({
                      requesterUserId: data.initiatedByUserId,
                      canonicalSourceId: data.canonicalSourceId,
                      descriptor: clipDescriptor,
                      workerId,
                    });

                    let publishedCacheKey: string;
                    let publishedObjectKey: string;
                    let reusedFromCache = false;

                    if (resv.action === 'ALREADY_PUBLISHED' && resv.artifact.publishedObjectKey) {
                      publishedCacheKey = resv.cacheKey;
                      publishedObjectKey = resv.artifact.publishedObjectKey;
                      reusedFromCache = true;
                    } else if (resv.action === 'RESERVED') {
                      const up = await vodService.publisher.uploadImmutableAttemptObject({
                        requesterUserId: data.initiatedByUserId,
                        canonicalSourceId: data.canonicalSourceId,
                        descriptor: clipDescriptor,
                        artifactId: resv.artifactId,
                        attemptId: resv.attemptId,
                        generation: resv.generation,
                        workerId,
                        body: clipBytes,
                        contentType: 'video/mp4',
                        fileExt: 'mp4',
                      });
                      const committed = await vodService.publisher.commitPublishedArtifact({
                        requesterUserId: data.initiatedByUserId,
                        canonicalSourceId: data.canonicalSourceId,
                        descriptor: clipDescriptor,
                        artifactId: resv.artifactId,
                        attemptId: resv.attemptId,
                        generation: resv.generation,
                        workerId,
                        objectKey: up.objectKey,
                        contentSha256: up.contentSha256,
                        etag: up.etag,
                        sizeBytes: up.sizeBytes,
                        mimeType: 'video/mp4',
                        mediaMetadata: {
                          candidate: cand,
                          clipMeta: { ...clipMeta, filePath: '(persisted-in-storage)' },
                        },
                      });
                      publishedCacheKey = committed.cacheKey;
                      publishedObjectKey = committed.publishedObjectKey!;
                    } else {
                      continue;
                    }

                    emittedKeys.add(keyTag);
                    liveHighlights.push({
                      candidate: cand,
                      cacheKey: publishedCacheKey,
                      objectKey: publishedObjectKey,
                      descriptor: clipDescriptor,
                      clipMeta: { ...clipMeta, filePath: '(persisted-in-storage)' },
                      reusedFromCache,
                    });

                    // Publish incremental highlight immediately while broadcast stays RUNNING!
                    await sharedWork.publishProgressFenced({
                      sharedWorkKey: data.sharedWorkKey,
                      generation: claimedGen,
                      ownerToken,
                      stage: `streaming_live_${liveHighlights.length}_highlights`,
                      progressPercent: Math.min(95, 25 + liveHighlights.length * 20),
                      resultSummary: {
                        highlightsCount: liveHighlights.length,
                        highlights: liveHighlights,
                        streamStatus: ended ? 'ENDED' : 'LIVE',
                      } as unknown as Prisma.InputJsonValue,
                    });
                  }
                },
              });

              assertNotAborted();
              await sharedWork.commitWorkReady({
                sharedWorkKey: data.sharedWorkKey,
                generation: claimedGen,
                ownerToken,
                resultSummary: {
                  highlightsCount: liveHighlights.length,
                  highlights: liveHighlights,
                  streamStatus: 'ENDED',
                } as unknown as Prisma.InputJsonValue,
              });

              return {
                sharedWorkKey: data.sharedWorkKey,
                generation: claimedGen,
                highlightsCount: liveHighlights.length,
              };
            } finally {
              await buffer.cleanupAll().catch(() => {});
            }
          }

          // D2. Real Authorized Direct VOD MP4/MOV acquisition -> reuses FULL UnifiedVodProcessingService!
          await fs.mkdir(tempUploadDir, { recursive: true });
          const localMp4 = path.join(tempUploadDir, 'direct-vod-source.mp4');
          await directAdapter.acquireVodToFile(localMp4, { signal: abortCtrl.signal });

          const vodIdPart = data.canonicalSourceId.split(':').slice(2).join(':');
          const vodWrapper = new ControlledVodAcquisitionAdapter({
            enabled: true,
            archetype: 'direct_media_recording',
            vodId: vodIdPart,
            fixturePath: localMp4,
            title: `Direct Media ${vodIdPart.slice(0, 8)}`,
          });

          const srcRes = await vodService.acquireOrReuseVodSource({
            adapter: vodWrapper,
            requesterUserId: data.initiatedByUserId,
            workerId,
            sourceRevision: optsIn.sourceRevision ?? 'v1',
            rightsScope: 'SHARED_PERMITTED',
            signal: abortCtrl.signal,
          });

          assertNotAborted();
          await sharedWork.publishProgressFenced({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
            stage: 'analyzing_highlights',
            progressPercent: 45,
          });

          const anaRes = await vodService.analyzeOrReuseVodHighlights({
            canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
            sourceDescriptor: srcRes.descriptor,
            requesterUserId: data.initiatedByUserId,
            workerId,
            sourceRevision: optsIn.sourceRevision ?? 'v1',
            rightsScope: 'SHARED_PERMITTED',
            preRollSec: optsIn.preRollSec ?? 6,
            postRollSec: optsIn.postRollSec ?? 4,
            cooldownSec: optsIn.cooldownSec ?? 12,
            scoreThreshold: optsIn.scoreThreshold ?? 65,
            enableLocalWhisper: optsIn.enableLocalWhisper ?? false,
            signal: abortCtrl.signal,
          });

          assertNotAborted();
          await sharedWork.publishProgressFenced({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
            stage: 'generating_base_clips',
            progressPercent: 70,
          });

          const generatedClips = [];
          for (const cand of anaRes.candidates) {
            assertNotAborted();
            const clip = await vodService.generateOrReuseVodBaseClip({
              canonicalSourceId: data.canonicalSourceId as CacheableSourceId,
              sourceDescriptor: srcRes.descriptor,
              candidate: cand,
              requesterUserId: data.initiatedByUserId,
              workerId,
              sourceRevision: optsIn.sourceRevision ?? 'v1',
              rightsScope: 'SHARED_PERMITTED',
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

          assertNotAborted();
          await sharedWork.commitWorkReady({
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            ownerToken,
            resultSummary: {
              highlightsCount: generatedClips.length,
              highlights: generatedClips,
            } as unknown as Prisma.InputJsonValue,
          });

          return {
            sharedWorkKey: data.sharedWorkKey,
            generation: claimedGen,
            highlightsCount: generatedClips.length,
          };
        }

        throw new MediaSourceError({
          code: 'UNSUPPORTED_ACQUISITION',
          message: 'No permitted acquisition adapter available for this job payload.',
        });
      } catch (err) {
        stopHeartbeat();
        const isMediaErr = err instanceof MediaSourceError;
        const abortReason = abortCtrl.signal.aborted ? abortCtrl.signal.reason : undefined;
        const effectiveCode =
          isMediaErr
            ? err.code
            : abortReason instanceof MediaSourceError
              ? abortReason.code
              : 'INFRA_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        const nonRetryable = NON_RETRYABLE_CODES.has(effectiveCode);
        const maxAttempts = job.opts.attempts ?? 3;
        const isFinalAttempt = nonRetryable || attemptNum >= maxAttempts;

        if (effectiveCode === 'REQUEST_CANCELLED') {
          const cancelRes = await sharedWork
            .commitWorkCancelledIfNoSubscribers({
              sharedWorkKey: data.sharedWorkKey,
              generation: claimedGen,
              ownerToken,
            })
            .catch(() => ({ cancelled: false, newSubscribersJoined: false }));
          if (cancelRes.newSubscribersJoined) {
            // A new subscriber joined right as we cancelled -> dispatch its bumped generation immediately!
            await sharedWork
              .reconcileStrandedWork({ enqueueFn: enqueueRecoveryFn, batchSize: 5 })
              .catch(() => {});
          }
          throw new UnrecoverableError(`REQUEST_CANCELLED: ${message}`);
        }

        if (effectiveCode === 'LEASE_EXPIRED') {
          // Ownership was already fenced out by PostgreSQL -> NEVER mutate SharedMediaWork or subscribers!
          throw new UnrecoverableError(`LEASE_EXPIRED: ${message}`);
        }

        if (isFinalAttempt) {
          const committedFail = await sharedWork
            .commitWorkFailed({
              sharedWorkKey: data.sharedWorkKey,
              generation: claimedGen,
              ownerToken,
              errorCode: effectiveCode,
              errorMessage: message,
            })
            .catch(() => false);
          if (committedFail) {
            await moveToDeadLetter(queueName, data, `${effectiveCode}: ${message}`).catch(() => {});
          }
        } else {
          // Release PostgreSQL RUNNING lease back to ENQUEUED so BullMQ's next retry attempt can claim cleanly!
          await sharedWork
            .releaseLeaseForRetry({
              sharedWorkKey: data.sharedWorkKey,
              generation: claimedGen,
              ownerToken,
              errorCode: effectiveCode,
              errorMessage: message,
            })
            .catch(() => {});
        }

        if (nonRetryable) {
          throw new UnrecoverableError(`${effectiveCode}: ${message}`);
        }
        throw err;
      } finally {
        stopHeartbeat();
        unregisterLocalSharedWorkAbort(data.sharedWorkKey, claimedGen);
        // Atomic Lua compare-and-delete: NEVER deletes a newer worker's lock!
        await sharedWork.lock
          .release({
            sharedWorkKey: data.sharedWorkKey,
            token: ownerToken,
          })
          .catch(() => {});
        await fs.rm(tempUploadDir, { recursive: true, force: true }).catch(() => {});
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

  return { worker, vodService, liveService, sharedWork };
}
