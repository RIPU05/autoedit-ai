import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  ensureControlledLiveFixture,
  SharedIngestionCoordinator,
  RedisCoordinationStore,
  DurableMediaRegistryService,
  DurableArtifactPublisher,
  DurableSharedClipService,
  probeAndValidateClipMp4,
  MediaSourceError,
} from '../../src/media/index.js';
import { connection as redis } from '../../src/lib/redis.js';
import { createStorageProvider, type MediaStorageProvider } from '../../src/storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const RAW_LOCAL_DB_URL =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('autoedit_test')
    ? process.env.DATABASE_URL
    : 'postgresql://autoedit:autoedit_local_pass@127.0.0.1:5432/autoedit_local?schema=public';
const LOCAL_DB_URL = RAW_LOCAL_DB_URL.replace('@localhost:', '@127.0.0.1:');
const MINIO_ENDPOINT = process.env.S3_ENDPOINT || 'http://127.0.0.1:9002';
const MINIO_BUCKET =
  process.env.S3_BUCKET && process.env.S3_BUCKET !== 'autoedit-test-bucket'
    ? process.env.S3_BUCKET
    : 'autoedit-local';
const MINIO_ACCESS_KEY =
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_ID !== 'test-access-key'
    ? process.env.AWS_ACCESS_KEY_ID
    : 'minio_local_admin';
const MINIO_SECRET_KEY =
  process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY !== 'test-secret-key'
    ? process.env.AWS_SECRET_ACCESS_KEY
    : 'minio_local_secret_key';

describe('Step 3B.7: Durable PostgreSQL Media Registry, Rights & Transactional CAS Publication (Real Postgres + Redis + MinIO + FFmpeg)', () => {
  const db = new PrismaClient({
    datasources: { db: { url: LOCAL_DB_URL } },
  });

  const storage: MediaStorageProvider = createStorageProvider({
    providerType: 'minio',
    bucket: MINIO_BUCKET,
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
    endpoint: MINIO_ENDPOINT,
    forcePathStyle: true,
    presignTtlSec: 3600,
  });

  const runTag = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const fixturePath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
  const workRootA = path.resolve(process.cwd(), 'tmp', `step3b7-instA-${runTag}`);
  const workRootB = path.resolve(process.cwd(), 'tmp', `step3b7-instB-${runTag}`);
  const workRootProbe = path.resolve(process.cwd(), 'tmp', `step3b7-probe-${runTag}`);
  const redisKeyPrefix = `autoedit:test:step3b7:${runTag}:`;

  const createdSourceCanonicalIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdStorageKeys = new Set<string>();

  function createService(workRoot: string): {
    coordinator: SharedIngestionCoordinator;
    service: DurableSharedClipService;
  } {
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix: redisKeyPrefix,
      recordTtlMs: 120_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);
    const service = new DurableSharedClipService(db, coordinator, storage, workRoot);
    return { coordinator, service };
  }

  async function createTestUser(suffix: string): Promise<{ id: string; email: string }> {
    const email = `step3b7_${runTag}_${suffix}@local.test`;
    const user = await db.user.create({
      data: { email, name: `Test ${suffix}` },
    });
    createdUserIds.add(user.id);
    return user;
  }

  beforeAll(async () => {
    expect(await redis.ping()).toBe('PONG');
    const health = await storage.checkHealth();
    expect(health.ok).toBe(true);
    await db.$queryRaw`SELECT 1`;

    await ensureControlledLiveFixture(fixturePath, {
      durationSec: 30,
      spikeStartSec: 16,
      spikeEndSec: 19,
    });
  }, 60_000);

  afterAll(async () => {
    // Collect any MinIO keys referenced by test artifacts/attempts before deleting DB rows
    if (createdSourceCanonicalIds.size > 0) {
      const sources = await db.mediaSource.findMany({
        where: { canonicalId: { in: [...createdSourceCanonicalIds] } },
        include: {
          artifacts: {
            include: { attempts: true },
          },
        },
      });
      for (const s of sources) {
        for (const a of s.artifacts) {
          if (a.publishedObjectKey) createdStorageKeys.add(a.publishedObjectKey);
          for (const att of a.attempts) {
            if (att.objectKey) createdStorageKeys.add(att.objectKey);
          }
          const meta = a.mediaMetadata as any;
          if (Array.isArray(meta?.segments)) {
            for (const seg of meta.segments) {
              if (seg?.objectKey) createdStorageKeys.add(seg.objectKey);
            }
          }
        }
      }
      await db.mediaSource.deleteMany({
        where: { canonicalId: { in: [...createdSourceCanonicalIds] } },
      });
    }

    if (createdUserIds.size > 0) {
      await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
    }

    const rKeys = await redis.keys(`${redisKeyPrefix}*`);
    if (rKeys.length > 0) {
      await redis.del(...rKeys).catch(() => {});
    }
    for (const key of createdStorageKeys) {
      await storage.deleteObject({ key }).catch(() => {});
    }
    await fs.rm(workRootA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootB, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootProbe, { recursive: true, force: true }).catch(() => {});
    await db.$disconnect();
  });

  it('1. enforces durable MediaSource registry, VOD/live separation, channel distinctness, different clip settings, private uploads, and project ownership', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);
    const userA = await createTestUser('uA');
    const userB = await createTestUser('uB');

    // Channel-only identity rejected from durable registry
    await expect(
      instA.service.registry.registerOrGetMediaSource({
        canonicalId: 'twitch:channel:shroud',
        provider: 'twitch',
        sourceType: 'live',
        identityScope: 'IMMUTABLE_BROADCAST',
        externalId: 'shroud',
      }),
    ).rejects.toMatchObject({ code: 'BROADCAST_UNRESOLVED' });

    // 1a. Same VOD registered & requested by two different users (Items #9 & #12)
    const vodId = `youtube:vod:vod3b7_${runTag}` as const;
    createdSourceCanonicalIds.add(vodId);

    // Public URL defaults to UNKNOWN/UNSUPPORTED — cannot acquire before explicit server grant!
    const vodSrc1 = await instA.service.registry.registerOrGetMediaSource({
      canonicalId: vodId,
      provider: 'youtube',
      sourceType: 'vod',
      identityScope: 'IMMUTABLE_VOD',
      externalId: `vod3b7_${runTag}`,
      vodId: `vod3b7_${runTag}`,
      normalizedUrl: `https://www.youtube.com/watch?v=vod3b7_${runTag}`,
      metadata: { title: 'Test VOD', secretToken: 'MUST_BE_STRIPPED' },
    });
    expect(vodSrc1.rightsStatus).toBe('UNKNOWN');
    expect(vodSrc1.acquisitionCapability).toBe('UNSUPPORTED');
    expect((vodSrc1.metadata as Record<string, unknown>)?.secretToken).toBeUndefined();

    // Unverified public VOD fails closed before touching storage!
    await expect(
      instA.service.requestDurableClip({
        canonicalSourceId: vodId,
        requesterUserId: userA.id,
        workerId: 'w_unauth',
        fixturePath,
      }),
    ).rejects.toMatchObject({ code: 'RIGHTS_UNVERIFIED' });

    // Second user registering same VOD gets the exact same unique MediaSource row (no duplicate!)
    const vodSrc2 = await instB.service.registry.registerOrGetMediaSource({
      canonicalId: vodId,
      provider: 'youtube',
      sourceType: 'vod',
      identityScope: 'IMMUTABLE_VOD',
      externalId: `vod3b7_${runTag}`,
      vodId: `vod3b7_${runTag}`,
    });
    expect(vodSrc2.id).toBe(vodSrc1.id);

    // Explicit server-side test grant authorizes acquisition + shared reuse
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: vodId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      acquisitionCapability: 'PERMITTED_STREAM',
      rightsStatus: 'PERMITTED_PUBLIC',
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b7',
      reason: 'Controlled local test fixture',
    });

    const vodClipA = await instA.service.requestDurableClip({
      canonicalSourceId: vodId,
      requesterUserId: userA.id,
      workerId: 'instA_vod_w1',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    const vodClipB = await instB.service.requestDurableClip({
      canonicalSourceId: vodId,
      requesterUserId: userB.id,
      workerId: 'instB_vod_w2',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });

    expect(vodClipA.publishedGeneration).toBe(1);
    expect(vodClipB.reusedFromDbCache).toBe(true);
    expect(vodClipB.cacheKey).toBe(vodClipA.cacheKey);
    expect(vodClipB.objectKey).toBe(vodClipA.objectKey);
    expect(vodClipB.contentSha256).toBe(vodClipA.contentSha256);
    expect(vodClipB.contentSha256).not.toBe(vodClipB.cacheKey);
    expect(instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount).toBe(1);

    // Different render settings on same VOD -> reuses upstream source & analysis, creates distinct SharedCacheArtifact! (Item #12)
    const vodClip360 = await instB.service.requestDurableClip({
      canonicalSourceId: vodId,
      requesterUserId: userB.id,
      workerId: 'instB_vod_360',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      renderSettings: {
        format: 'reel',
        width: 640,
        height: 360,
        fps: 24,
        subtitles: false,
        zooms: false,
        transitions: 'none',
        music: false,
      },
    });
    expect(vodClip360.cacheKey).not.toBe(vodClipA.cacheKey);
    expect(vodClip360.objectKey).not.toBe(vodClipA.objectKey);
    expect(vodClip360.clipMeta.width).toBe(640);
    expect(vodClip360.clipMeta.height).toBe(360);
    expect(instB.service.metrics.sourceProcessingCount).toBe(0);
    expect(instB.service.metrics.analysisPassCount).toBe(0);

    // 1b. Two broadcasts from same channel remain distinct + associated VOD remains distinct + shared broadcast across users + project isolation (Items #10, #11, #15)
    const monId = `twitch:broadcast:ch3b7:mon_${runTag}` as const;
    const tueId = `twitch:broadcast:ch3b7:tue_${runTag}` as const;
    const assocVodId = `twitch:vod:monvod_${runTag}` as const;
    createdSourceCanonicalIds.add(monId);
    createdSourceCanonicalIds.add(tueId);
    createdSourceCanonicalIds.add(assocVodId);

    const monSrc = await instA.service.registry.registerOrGetMediaSource({
      canonicalId: monId,
      provider: 'twitch',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: 'ch3b7',
      channelId: 'twitch:channel:ch3b7',
      broadcastId: `mon_${runTag}`,
    });
    const tueSrc = await instA.service.registry.registerOrGetMediaSource({
      canonicalId: tueId,
      provider: 'twitch',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: 'ch3b7',
      channelId: 'twitch:channel:ch3b7',
      broadcastId: `tue_${runTag}`,
    });
    const assocVodSrc = await instA.service.registry.registerOrGetMediaSource({
      canonicalId: assocVodId,
      provider: 'twitch',
      sourceType: 'vod',
      identityScope: 'IMMUTABLE_VOD',
      externalId: `monvod_${runTag}`,
      channelId: 'twitch:channel:ch3b7',
      vodId: `monvod_${runTag}`,
      associatedLiveSourceId: monSrc.id,
    });
    expect(monSrc.id).not.toBe(tueSrc.id);
    expect(assocVodSrc.id).not.toBe(monSrc.id);
    expect(assocVodSrc.associatedLiveSourceId).toBe(monSrc.id);

    await instA.service.registry.grantSourceRights({
      canonicalSourceId: monId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b7',
    });

    const bcClipA = await instA.service.requestDurableClip({
      canonicalSourceId: monId,
      requesterUserId: userA.id,
      workerId: 'instA_bc_1',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    const bcClipB = await instB.service.requestDurableClip({
      canonicalSourceId: monId,
      requesterUserId: userB.id,
      workerId: 'instB_bc_2',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(bcClipB.reusedFromDbCache).toBe(true);
    expect(bcClipB.cacheKey).toBe(bcClipA.cacheKey);

    // Private Projects for userA and userB can both reference the same shared MediaSource, while cross-user project access is DENIED!
    const projA = await db.project.create({ data: { userId: userA.id, title: 'User A Clip Project' } });
    const projB = await db.project.create({ data: { userId: userB.id, title: 'User B Clip Project' } });
    await instA.service.registry.linkProjectToMediaSource({
      projectId: projA.id,
      requesterUserId: userA.id,
      canonicalSourceId: monId,
    });
    await instB.service.registry.linkProjectToMediaSource({
      projectId: projB.id,
      requesterUserId: userB.id,
      canonicalSourceId: monId,
    });
    await expect(
      instB.service.registry.linkProjectToMediaSource({
        projectId: projA.id,
        requesterUserId: userB.id,
        canonicalSourceId: monId,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // 1c. User-owned direct upload remains strictly PRIVATE_USER (Items #14 & #15)
    const uploadId = `upload:uploaded:asset_${runTag}` as const;
    createdSourceCanonicalIds.add(uploadId);

    const upSrc = await instA.service.registry.registerOrGetMediaSource({
      canonicalId: uploadId,
      provider: 'upload',
      sourceType: 'uploaded',
      identityScope: 'IMMUTABLE_UPLOAD',
      externalId: `asset_${runTag}`,
      ownerUserId: userA.id,
    });
    expect(upSrc.rightsStatus).toBe('USER_OWNED');
    expect(upSrc.rightsScope).toBe('PRIVATE_USER');

    // Uploads cannot be granted SHARED_REUSE
    await expect(
      instA.service.registry.grantSourceRights({
        canonicalSourceId: uploadId,
        grantScope: 'SHARED_REUSE',
        allowAcquisition: true,
        allowSharedReuse: true,
        provenance: 'TEST',
        grantedBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    const upClipA = await instA.service.requestDurableClip({
      canonicalSourceId: uploadId,
      requesterUserId: userA.id,
      workerId: 'instA_upload',
      fixturePath,
      rightsScope: 'PRIVATE_USER',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(upClipA.objectKey).toContain(`cache/private/${userA.id}/`);

    // User B attempting to access User A's private uploaded clip is strictly DENIED!
    await expect(
      instB.service.publisher.getAuthorizedPublishedArtifact({
        requesterUserId: userB.id,
        canonicalSourceId: uploadId,
        descriptor: upClipA.descriptor,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  }, 120_000);

  it('2. enforces PostgreSQL CAS across Redis key deletion/expiry, rejects stale workers, serializes racing publishers, and survives process restart', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);
    const userA = await createTestUser('casA');
    const userB = await createTestUser('casB');

    const srcId = `kick:broadcast:cas_ch:sess_${runTag}` as const;
    createdSourceCanonicalIds.add(srcId);
    await instA.service.registry.registerOrGetMediaSource({
      canonicalId: srcId,
      provider: 'kick',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: 'cas_ch',
      channelId: 'kick:channel:cas_ch',
      broadcastId: `sess_${runTag}`,
    });
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: srcId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b7',
    });

    // 2a. Two workers race concurrently to reserve & publish the EXACT SAME artifact via real concurrent PostgreSQL transactions (Item #4)
    const raceDescriptor = {
      artifactKind: 'BASE_CLIP' as const,
      sourceRevision: 'v-race',
      timeRangeSec: { start: 10, end: 20 },
      algorithmVersion: 'v1.0-heuristic',
      rightsScope: 'SHARED_PERMITTED' as const,
    };

    const [res1, res2] = await Promise.all([
      instA.service.publisher.reservePublicationGeneration({
        requesterUserId: userA.id,
        canonicalSourceId: srcId,
        descriptor: raceDescriptor,
        workerId: 'race_worker_1',
        leaseMs: 10_000,
      }),
      instB.service.publisher.reservePublicationGeneration({
        requesterUserId: userB.id,
        canonicalSourceId: srcId,
        descriptor: raceDescriptor,
        workerId: 'race_worker_2',
        leaseMs: 10_000,
      }),
    ]);

    const reservedWins = [res1, res2].filter((r) => r.action === 'RESERVED');
    const inProgress = [res1, res2].filter((r) => r.action === 'ALREADY_IN_PROGRESS');
    expect(reservedWins).toHaveLength(1);
    expect(inProgress).toHaveLength(1);
    const firstRes = reservedWins[0] as Extract<typeof res1, { action: 'RESERVED' }>;
    expect(firstRes.generation).toBe(1);

    // Clean up race attempt so real clip pipeline below runs cleanly on default revision
    await instA.service.publisher.abortPublicationAttempt({
      artifactId: firstRes.artifactId,
      attemptId: firstRes.attemptId,
      workerId: res1.action === 'RESERVED' ? 'race_worker_1' : 'race_worker_2',
      reason: 'race test cleanup',
    });

    // 2b. Redis keys deleted mid-flight between acquisition and publication + stale worker tries to publish after newer generation (Items #2 & #3)
    let gen2ObjectKey = '';
    let clipCacheKey = '';
    const staleWorkerPromise = instA.service.requestDurableClip({
      canonicalSourceId: srcId,
      requesterUserId: userA.id,
      workerId: 'stale_worker_gen1',
      fixturePath,
      leaseMs: 10_000,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      onBeforeClipCommit: async ({ cacheKey, generation }) => {
        clipCacheKey = cacheKey;
        expect(generation).toBe(1);

        // WIPE ALL REDIS COORDINATION KEYS right before commit!
        const allRedisKeys = await redis.keys(`${redisKeyPrefix}*`);
        if (allRedisKeys.length > 0) {
          await redis.del(...allRedisKeys);
        }

        // Now worker_gen2 reserves generation=2 in PostgreSQL (simulating lease expiry takeover) and commits!
        const gen2Res = await instB.service.publisher.reservePublicationGeneration({
          requesterUserId: userB.id,
          canonicalSourceId: srcId,
          descriptor: {
            artifactKind: 'BASE_CLIP',
            sourceRevision: 'v1',
            timeRangeSec: { start: 10.5, end: 20.5 }, // will lookup exact descriptor from DB row below
            algorithmVersion: 'v1.0-heuristic',
            rightsScope: 'SHARED_PERMITTED',
          },
          workerId: 'winner_worker_gen2',
          leaseMs: 30_000,
          now: new Date(Date.now() + 20_000),
        });
        // Instead of guessing window, read the exact artifact row by cacheKey and reserve gen=2 directly!
        const artRow = await db.sharedCacheArtifact.findUniqueOrThrow({ where: { cacheKey } });
        const exactDescriptor = {
          artifactKind: 'BASE_CLIP' as const,
          sourceRevision: artRow.sourceRevision,
          timeRangeSec: { start: artRow.windowStartSec!, end: artRow.windowEndSec! },
          algorithmVersion: artRow.algorithmVersion,
          renderSettings: {
            format: 'reel' as const,
            width: 1280,
            height: 720,
            fps: 30,
            subtitles: false,
            zooms: false,
            transitions: 'none' as const,
            music: false,
          },
          rightsScope: 'SHARED_PERMITTED' as const,
        };
        // Clean up unused temp gen2Res if created on a different key
        if (gen2Res.action === 'RESERVED' && gen2Res.cacheKey !== cacheKey) {
          await instB.service.publisher.abortPublicationAttempt({
            artifactId: gen2Res.artifactId,
            attemptId: gen2Res.attemptId,
            workerId: 'winner_worker_gen2',
            reason: 'unused',
          });
        }

        const takeover = await instB.service.publisher.reservePublicationGeneration({
          requesterUserId: userB.id,
          canonicalSourceId: srcId,
          descriptor: exactDescriptor,
          workerId: 'winner_worker_gen2',
          leaseMs: 30_000,
          now: new Date(Date.now() + 20_000),
        });
        expect(takeover.action).toBe('RESERVED');
        if (takeover.action !== 'RESERVED') throw new Error('Expected RESERVED');
        // Generation monotonically advances 1 -> 2 in PostgreSQL EVEN AFTER REDIS WIPE!
        expect(takeover.generation).toBe(2);

        const fixtureBytes = await fs.readFile(fixturePath);
        const uploaded2 = await instB.service.publisher.uploadImmutableAttemptObject({
          requesterUserId: userB.id,
          canonicalSourceId: srcId,
          descriptor: exactDescriptor,
          artifactId: takeover.artifactId,
          attemptId: takeover.attemptId,
          generation: 2,
          workerId: 'winner_worker_gen2',
          body: fixtureBytes,
          contentType: 'video/mp4',
        });
        gen2ObjectKey = uploaded2.objectKey;

        await instB.service.publisher.commitPublishedArtifact({
          requesterUserId: userB.id,
          canonicalSourceId: srcId,
          descriptor: exactDescriptor,
          artifactId: takeover.artifactId,
          attemptId: takeover.attemptId,
          generation: 2,
          workerId: 'winner_worker_gen2',
          objectKey: uploaded2.objectKey,
          contentSha256: uploaded2.contentSha256,
          etag: uploaded2.etag,
          sizeBytes: uploaded2.sizeBytes,
          mimeType: 'video/mp4',
          mediaMetadata: {
            candidate: {
              candidateId: 'hl_gen2',
              canonicalSourceId: srcId,
              eventTimestampSec: 16.5,
              windowStartSec: artRow.windowStartSec!,
              windowEndSec: artRow.windowEndSec!,
              compositeScore: 95,
              contributingSignals: ['AUDIO_ENERGY'],
              pinnedSegmentIndices: [2, 3, 4],
              algorithmVersion: 'v1.0-heuristic',
            },
            clipMeta: {
              filePath: '(persisted-in-storage)',
              sizeBytes: uploaded2.sizeBytes,
              sha256: uploaded2.contentSha256,
              durationSec: 30,
              width: 1280,
              height: 720,
              fps: 30,
              videoCodec: 'h264',
              audioCodec: 'aac',
              hasVideo: true,
              hasAudio: true,
              encodingMode: 'stream-copy',
            },
          },
        });
      },
    });

    // Stale worker_gen1 MUST be atomically rejected by PostgreSQL CAS despite Redis wipe!
    await expect(staleWorkerPromise).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
    expect(instA.service.metrics.casRejections).toBe(1);

    const dbAfterRace = await db.sharedCacheArtifact.findUniqueOrThrow({
      where: { cacheKey: clipCacheKey },
    });
    expect(dbAfterRace.state).toBe('PUBLISHED');
    expect(dbAfterRace.publishedGeneration).toBe(2);
    expect(dbAfterRace.publishedObjectKey).toBe(gen2ObjectKey);

    // 2c. Redis key expires AND process restarts (brand-new service instance with zero local state) -> cached MP4 survives & reuses with 0 FFmpeg! (Items #1 & #8)
    const keysToWipe = await redis.keys(`${redisKeyPrefix}*`);
    if (keysToWipe.length > 0) await redis.del(...keysToWipe);

    const restartedInst = createService(workRootProbe);
    const afterRestart = await restartedInst.service.requestDurableClip({
      canonicalSourceId: srcId,
      requesterUserId: userA.id,
      workerId: 'restarted_proc_worker',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(afterRestart.reusedFromDbCache).toBe(true);
    expect(afterRestart.publishedGeneration).toBe(2);
    expect(afterRestart.objectKey).toBe(gen2ObjectKey);
    expect(restartedInst.service.metrics.ffmpegClipRenderCount).toBe(0);
  }, 120_000);

  it('3. handles 16-way concurrent repair (1 winner), corrupt MP4 rejection, DB rollback & cancellation preserving valid version, and safe delayed cleanup', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);
    const userA = await createTestUser('repA');

    const srcId = `twitch:broadcast:repair_ch:sess_${runTag}` as const;
    createdSourceCanonicalIds.add(srcId);
    await instA.service.registry.registerOrGetMediaSource({
      canonicalId: srcId,
      provider: 'twitch',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: 'repair_ch',
      channelId: 'twitch:channel:repair_ch',
      broadcastId: `sess_${runTag}`,
    });
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: srcId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b7',
    });

    // Publish initial healthy gen=1
    const gen1 = await instA.service.requestDurableClip({
      canonicalSourceId: srcId,
      requesterUserId: userA.id,
      workerId: 'instA_init',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(gen1.publishedGeneration).toBe(1);

    // 3a. 16 concurrent requests trigger repair of ONE missing MinIO object (even with Redis wiped!) -> strictly 1 repair winner! (Item #5)
    await storage.deleteObject({ key: gen1.objectKey });
    const wipeKeys = await redis.keys(`${redisKeyPrefix}*`);
    if (wipeKeys.length > 0) await redis.del(...wipeKeys);

    const rendersBefore =
      instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount;
    const repairsBefore =
      instA.service.metrics.repairCount + instB.service.metrics.repairCount;

    const repair16 = await Promise.all(
      Array.from({ length: 16 }, (_, i) => {
        const svc = i % 2 === 0 ? instA.service : instB.service;
        return svc.requestDurableClip({
          canonicalSourceId: srcId,
          requesterUserId: userA.id,
          workerId: `rep16_w_${i}`,
          fixturePath,
          bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
          pollInitialMs: 30,
          pollMaxMs: 80,
        });
      }),
    );

    const rendersAfter =
      instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount;
    const repairsAfter =
      instA.service.metrics.repairCount + instB.service.metrics.repairCount;

    expect(repairsAfter - repairsBefore).toBe(1);
    expect(rendersAfter - rendersBefore).toBe(1);
    expect(new Set(repair16.map((r) => r.objectKey)).size).toBe(1);
    const gen2 = repair16[0];
    expect(gen2.publishedGeneration).toBe(2);
    expect(gen2.objectKey).not.toBe(gen1.objectKey);

    // 3b. Corrupt MP4 (same-byte-length garbage!) is rejected & NEVER served (Item #7)
    const savedValidGen2Bytes = await instA.service.publisher.cache.getObjectBytesAtKey(
      (await instA.service.registry.resolveServerTrustedAuth({
        requesterUserId: userA.id,
        canonicalSourceId: srcId,
        requireSharedReuse: true,
      })).auth,
      gen2.descriptor,
      gen2.objectKey,
    );
    expect(savedValidGen2Bytes).not.toBeNull();

    const sameLengthGarbage = Buffer.alloc(gen2.sizeBytes, 0x42);
    await storage.putObject({
      key: gen2.objectKey,
      body: sameLengthGarbage,
      contentType: 'video/mp4',
    });

    await expect(
      instB.service.publisher.getAuthorizedPublishedArtifact({
        requesterUserId: userA.id,
        canonicalSourceId: srcId,
        descriptor: gen2.descriptor,
        verifyInStorage: true,
        verifyMediaIntegrity: true,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' });

    // Trigger repair to publish healthy gen=3
    const gen3 = await instB.service.requestDurableClip({
      canonicalSourceId: srcId,
      requesterUserId: userA.id,
      workerId: 'instB_corrupt_repair',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(gen3.publishedGeneration).toBe(3);

    // 3c. Simulated DB transaction failure inside commit rolls back cleanly AND preserves previously published valid gen=3! (Items #6 & #16)
    await expect(
      instA.service.requestDurableClip({
        canonicalSourceId: srcId,
        requesterUserId: userA.id,
        workerId: 'instA_tx_rollback',
        fixturePath,
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
        onInsideCommitTx: async () => {
          throw new Error('Simulated PostgreSQL commit failure');
        },
      }),
    ).rejects.toThrow(/Simulated PostgreSQL commit failure/);

    const stillHealthyAfterRollback = await instB.service.publisher.getAuthorizedPublishedArtifact({
      requesterUserId: userA.id,
      canonicalSourceId: srcId,
      descriptor: gen3.descriptor,
      verifyInStorage: true,
      verifyMediaIntegrity: true,
    });
    expect(stillHealthyAfterRollback.publishedGeneration).toBe(3);
    expect(stillHealthyAfterRollback.objectKey).toBe(gen3.objectKey);
    expect(stillHealthyAfterRollback.artifact.state).toBe('PUBLISHED');

    // 3d. Worker cancellation before publication aborts cleanly AND preserves gen=3! (Item #17)
    const abortCtrl = new AbortController();
    await expect(
      instA.service.requestDurableClip({
        canonicalSourceId: srcId,
        requesterUserId: userA.id,
        workerId: 'instA_cancel_before_pub',
        fixturePath,
        signal: abortCtrl.signal,
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
        onBeforeClipCommit: async () => {
          abortCtrl.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });

    const stillHealthyAfterCancel = await instB.service.publisher.getAuthorizedPublishedArtifact({
      requesterUserId: userA.id,
      canonicalSourceId: srcId,
      descriptor: gen3.descriptor,
      verifyInStorage: true,
    });
    expect(stillHealthyAfterCancel.publishedGeneration).toBe(3);
    expect(stillHealthyAfterCancel.objectKey).toBe(gen3.objectKey);

    // 3e. Safe delayed retention cleanup deletes abandoned/superseded orphan objects WITHOUT removing still-referenced valid gen=3! (Item #18)
    const futureAfterGrace = new Date(Date.now() + 600_000);
    const cleanupRes = await instA.service.publisher.cleanupAbandonedGenerations({
      now: futureAfterGrace,
    });
    expect(cleanupRes.deletedKeys.length).toBeGreaterThanOrEqual(2); // rolled-back + cancelled/superseded orphans deleted
    expect(cleanupRes.deletedKeys).not.toContain(gen3.objectKey);

    // Verify gen=3 is STILL downloadable and passes ffprobe after cleanup!
    const dlRes = await fetch(stillHealthyAfterCancel.downloadUrl);
    expect(dlRes.ok).toBe(true);
    const bytes = Buffer.from(await dlRes.arrayBuffer());
    await fs.mkdir(workRootProbe, { recursive: true });
    const probePath = path.join(workRootProbe, 'post-cleanup-gen3.mp4');
    await fs.writeFile(probePath, bytes);
    const probed = await probeAndValidateClipMp4(probePath, { requireAudio: true });
    expect(probed.sha256).toBe(gen3.contentSha256);
    expect(probed.videoCodec).toBe('h264');
    expect(probed.audioCodec).toBe('aac');
  }, 120_000);

  it('4. blocks shared downloads immediately when source rights are revoked after clip creation (Item #13)', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);
    const userA = await createTestUser('revA');
    const userB = await createTestUser('revB');

    const srcId = `youtube:broadcast:rev_${runTag}` as const;
    createdSourceCanonicalIds.add(srcId);
    await instA.service.registry.registerOrGetMediaSource({
      canonicalId: srcId,
      provider: 'youtube',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: `rev_${runTag}`,
      broadcastId: `rev_${runTag}`,
    });
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: srcId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b7',
    });

    const clip = await instA.service.requestDurableClip({
      canonicalSourceId: srcId,
      requesterUserId: userA.id,
      workerId: 'instA_rev',
      fixturePath,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });

    // Before revocation: userB can access & download the shared clip
    const beforeRevoke = await instB.service.publisher.getAuthorizedPublishedArtifact({
      requesterUserId: userB.id,
      canonicalSourceId: srcId,
      descriptor: clip.descriptor,
    });
    expect(beforeRevoke.objectKey).toBe(clip.objectKey);

    // Revoke rights in PostgreSQL!
    const revoked = await instA.service.registry.revokeSourceRights({
      canonicalSourceId: srcId,
      revokedReason: 'Rights holder revoked clip sharing permission',
    });
    expect(revoked.revokedCount).toBeGreaterThanOrEqual(1);
    expect(revoked.mediaSource.rightsStatus).toBe('DENIED');

    // Immediately after revocation: shared reads AND new requests are BLOCKED!
    await expect(
      instB.service.publisher.getAuthorizedPublishedArtifact({
        requesterUserId: userB.id,
        canonicalSourceId: srcId,
        descriptor: clip.descriptor,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    await expect(
      instA.service.requestDurableClip({
        canonicalSourceId: srcId,
        requesterUserId: userA.id,
        workerId: 'instA_after_revoke',
        fixturePath,
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  }, 90_000);

  it('5. scales DB-backed shared artifact reuse across 1,000 concurrent clippers and 5,000 authorized cached requests with 1 render', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);

    const srcId = `twitch:broadcast:scale3b7:sess_${runTag}` as const;
    createdSourceCanonicalIds.add(srcId);
    await instA.service.registry.registerOrGetMediaSource({
      canonicalId: srcId,
      provider: 'twitch',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: 'scale3b7',
      channelId: 'twitch:channel:scale3b7',
      broadcastId: `sess_${runTag}`,
    });
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: srcId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b7',
    });

    // 1,000 concurrent clippers across 2 independent instances (500 each)
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => {
        const svc = i % 2 === 0 ? instA.service : instB.service;
        return svc.requestDurableClip({
          canonicalSourceId: srcId,
          requesterUserId: `clipper_db_${i}`,
          workerId: `db_inst${i % 2 === 0 ? 'A' : 'B'}_w_${i}`,
          fixturePath,
          bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
        });
      }),
    );
    const fanInMs = Date.now() - t0;

    // Strictly 1 source job, 1 analysis pass, 1 FFmpeg clip render across BOTH instances!
    expect(instA.service.metrics.sourceProcessingCount + instB.service.metrics.sourceProcessingCount).toBe(1);
    expect(instA.service.metrics.analysisPassCount + instB.service.metrics.analysisPassCount).toBe(1);
    expect(instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount).toBe(1);
    expect(new Set(results.map((r) => r.cacheKey)).size).toBe(1);
    expect(new Set(results.map((r) => r.objectKey)).size).toBe(1);

    const first = results[0];
    // Verify strictly 1 MediaSource and 1 published BASE_CLIP SharedCacheArtifact in PostgreSQL
    const dbArtifact = await db.sharedCacheArtifact.findUniqueOrThrow({
      where: { cacheKey: first.cacheKey },
    });
    expect(dbArtifact.state).toBe('PUBLISHED');
    expect(dbArtifact.publishedGeneration).toBe(1);

    // 5,000 repeated authorized cached download requests (checking PostgreSQL rights + artifact + short-lived signed URL)
    const tDl = Date.now();
    const heapBefore = process.memoryUsage().heapUsed;
    let okCount = 0;
    const batchSize = 100;
    for (let offset = 0; offset < 5000; offset += batchSize) {
      // Authoritative DB rights + artifact check once per batch, short-lived signed URL per request
      const authCheck = await instA.service.publisher.getAuthorizedPublishedArtifact({
        requesterUserId: `dl_batch_user_${offset}`,
        canonicalSourceId: srcId,
        descriptor: first.descriptor,
        verifyInStorage: offset === 0,
        expiresIn: 300,
      });
      const resolvedAuth = await instB.service.registry.resolveServerTrustedAuth({
        requesterUserId: `dl_batch_user_${offset}`,
        canonicalSourceId: srcId,
        requireSharedReuse: true,
      });
      const urls = await Promise.all(
        Array.from({ length: batchSize }, () =>
          instB.service.publisher.cache.createAuthorizedDownloadUrlForObject(
            resolvedAuth.auth,
            first.descriptor,
            authCheck.objectKey,
            { expiresIn: 300 },
          ),
        ),
      );
      for (const u of urls) {
        expect(u).toContain(first.objectKey);
        okCount++;
      }
    }
    const dl5000Ms = Date.now() - tDl;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

    expect(okCount).toBe(5000);
    expect(instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount).toBe(1);
    expect(heapDeltaMb).toBeLessThan(150);

    console.log(
      `[Step 3B.7 Measured] DB-backed 1,000 clippers=${fanInMs}ms (renders=1, publishedGen=1) | 5,000 authorized requests=${dl5000Ms}ms (heapDelta=${heapDeltaMb.toFixed(1)}MB, 0 extra renders)`,
    );
  }, 120_000);
});
