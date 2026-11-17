import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  ensureControlledLiveFixture,
  ControlledLocalStreamAdapter,
  SharedIngestionCoordinator,
  RedisCoordinationStore,
  SharedLiveProcessingService,
  probeAndValidateClipMp4,
  resolveAuthorizedCacheIdentity,
  createTrustedCacheAuthContext,
  MediaSourceError,
} from '../../src/media/index.js';
import { connection as redis } from '../../src/lib/redis.js';
import { createStorageProvider, type MediaStorageProvider } from '../../src/storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

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

describe('Step 3B.5: Real Redis + MinIO + FFmpeg Shared Live Processing & Concurrency Integration', () => {
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
  const fixturePath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
  const workRoot = path.resolve(process.cwd(), 'tmp', `step3b5-int-${Date.now()}`);
  const redisKeyPrefix = `autoedit:test:step3b5:${Date.now()}:`;
  const createdRedisKeys: string[] = [];
  const createdStorageKeys: string[] = [];

  function trackRedis(canonicalId: string) {
    createdRedisKeys.push(`${redisKeyPrefix}${canonicalId}`);
  }

  beforeAll(async () => {
    // Fail clearly if local Redis or local MinIO is unavailable
    expect(await redis.ping()).toBe('PONG');
    const storageHealth = await storage.checkHealth();
    expect(storageHealth.ok).toBe(true);

    await ensureControlledLiveFixture(fixturePath, {
      durationSec: 30,
      spikeStartSec: 16,
      spikeEndSec: 19,
    });
  }, 60_000);

  afterAll(async () => {
    for (const key of createdRedisKeys) {
      await redis.del(key).catch(() => {});
    }
    for (const sKey of createdStorageKeys) {
      await storage.deleteObject({ key: sKey }).catch(() => {});
    }
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('1. coordinates 1,000 clippers -> 1 FFmpeg run -> real cached MP4 in MinIO -> 5,000 authorized download requests', async () => {
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix: redisKeyPrefix,
      recordTtlMs: 120_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);
    const service = new SharedLiveProcessingService(coordinator, storage, workRoot);

    const adapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'gta6_demo',
        broadcastId: `session_1000_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    const source = adapter.buildVerifiedBroadcastSource();
    trackRedis(source.canonicalId);

    const t0 = Date.now();
    // 1,000 concurrent clippers requesting the exact same authorized broadcast
    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        service.requestSharedBroadcastHighlight({
          adapter,
          requesterUserId: `clipper_${i}`,
          workerId: `worker_${i}`,
          bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
          scoreThreshold: 65,
          cooldownSec: 15,
        }),
      ),
    );
    const fanInMs = Date.now() - t0;

    const acquiredNew = results.filter((r) => r.coordinationAction === 'ACQUIRED_NEW');
    const attachedOrReused = results.filter(
      (r) => r.coordinationAction === 'ATTACH_EXISTING' || r.coordinationAction === 'REUSE_READY',
    );
    expect(acquiredNew).toHaveLength(1);
    expect(attachedOrReused).toHaveLength(999);

    // Strictly ONE source processing job, ONE analysis pass, ONE FFmpeg render!
    expect(service.metrics.sourceProcessingCount).toBe(1);
    expect(service.metrics.analysisPassCount).toBe(1);
    expect(service.metrics.ffmpegClipRenderCount).toBe(1);

    const uniqueKeys = new Set(results.map((r) => r.cacheKey));
    expect(uniqueKeys.size).toBe(1);
    const sharedCacheKey = results[0].cacheKey;
    const candidate = results[0].candidate;
    expect(candidate.eventTimestampSec).toBeGreaterThanOrEqual(15.5);
    expect(candidate.eventTimestampSec).toBeLessThanOrEqual(19.5);

    // Track MinIO storage key for cleanup
    const auth0 = createTrustedCacheAuthContext({
      source,
      requesterUserId: 'clipper_0',
      allowSharedCacheReuse: true,
    });
    const descriptor = {
      artifactKind: 'BASE_CLIP' as const,
      sourceRevision: 'v1',
      timeRangeSec: { start: candidate.windowStartSec, end: candidate.windowEndSec },
      algorithmVersion: 'v1.0-heuristic',
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
    const identity = resolveAuthorizedCacheIdentity(auth0, descriptor);
    createdStorageKeys.push(identity.storageKey);

    // Verify Redis record stays compact O(1) with exact attachedCount=1000
    const redisRecord = await coordinator.getState(source.canonicalId);
    expect(redisRecord?.state).toBe('READY');
    expect(redisRecord?.attachedCount).toBe(1000);
    expect(JSON.stringify(redisRecord).length).toBeLessThan(350);

    // Download ACTUAL MP4 bytes from MinIO via presigned URL and probe with ffprobe!
    const res = await fetch(results[0].downloadUrl);
    expect(res.ok).toBe(true);
    const downloadedBuf = Buffer.from(await res.arrayBuffer());
    const downloadedPath = path.join(workRoot, 'verified-minio-download.mp4');
    await fs.mkdir(workRoot, { recursive: true });
    await fs.writeFile(downloadedPath, downloadedBuf);

    const probed = await probeAndValidateClipMp4(downloadedPath, { requireAudio: true });
    expect(probed.sizeBytes).toBeGreaterThan(10_000);
    expect(probed.videoCodec).toBe('h264');
    expect(probed.audioCodec).toBe('aac');
    expect(probed.width).toBe(1280);
    expect(probed.height).toBe(720);
    expect(probed.durationSec).toBeGreaterThanOrEqual(8);

    // Now simulate 5,000 authorized requests for the exact same cached clip
    const tDl = Date.now();
    let verifiedCount = 0;
    const batchSize = 250;
    for (let offset = 0; offset < 5000; offset += batchSize) {
      const batch = await Promise.all(
        Array.from({ length: batchSize }, (_, j) => {
          const idx = offset + j;
          return service.requestAuthorizedCachedClipDownload({
            adapter,
            requesterUserId: `downloader_${idx}`,
            descriptor,
            // Verify MinIO existence on the first request of every batch; sign all 5,000 URLs
            verifyExistsInStorage: j === 0,
          });
        }),
      );
      for (const item of batch) {
        expect(item.cacheKey).toBe(sharedCacheKey);
        expect(item.downloadUrl).toContain(identity.storageKey);
        verifiedCount++;
      }
    }
    const dl5000Ms = Date.now() - tDl;

    expect(verifiedCount).toBe(5000);
    // Still strictly 1 source processing and 1 FFmpeg render after 5,000 downloads!
    expect(service.metrics.sourceProcessingCount).toBe(1);
    expect(service.metrics.ffmpegClipRenderCount).toBe(1);

    console.log(
      `[Step 3B.5 Measured] 1,000 clippers=${fanInMs}ms | 5,000 authorized downloads=${dl5000Ms}ms | MP4=${probed.sizeBytes} bytes, ${probed.durationSec}s, ${probed.videoCodec}/${probed.audioCodec}, ${probed.width}x${probed.height}, mode=${results[0].clipMeta?.encodingMode}`,
    );
  }, 120_000);

  it('2. recovers cleanly from worker crash / storage write failure and stale-worker lease expiry', async () => {
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix: redisKeyPrefix,
      recordTtlMs: 60_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);
    const service = new SharedLiveProcessingService(coordinator, storage, workRoot);

    const adapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'kick',
        channelName: 'recovery_demo',
        broadcastId: `session_crash_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    const source = adapter.buildVerifiedBroadcastSource();
    trackRedis(source.canonicalId);

    // Attempt 1: simulate storage write failure before READY
    await expect(
      service.requestSharedBroadcastHighlight({
        adapter,
        requesterUserId: 'clipper_1',
        workerId: 'worker_crash_1',
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
        onAfterExtractBeforeUpload: async () => {
          throw new Error('Simulated storage write failure');
        },
      }),
    ).rejects.toThrow(/Simulated storage write failure/);

    const failedState = await coordinator.getState(source.canonicalId);
    expect(failedState?.state).toBe('FAILED');

    // Attempt 2: worker_recovery takes over via ACQUIRED_RECOVERY and succeeds
    const recovered = await service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'clipper_2',
      workerId: 'worker_recovery_2',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(recovered.coordinationAction).toBe('ACQUIRED_RECOVERY');
    expect(recovered.sizeBytes).toBeGreaterThan(10_000);
    expect(service.metrics.recoveryRuns).toBeGreaterThanOrEqual(1);

    // Cleanup MinIO object
    const auth = createTrustedCacheAuthContext({ source, requesterUserId: 'clipper_2', allowSharedCacheReuse: true });
    const id = resolveAuthorizedCacheIdentity(auth, {
      artifactKind: 'BASE_CLIP',
      sourceRevision: 'v1',
      timeRangeSec: { start: recovered.candidate.windowStartSec, end: recovered.candidate.windowEndSec },
      algorithmVersion: 'v1.0-heuristic',
      renderSettings: {
        format: 'reel',
        width: 1280,
        height: 720,
        fps: 30,
        subtitles: false,
        zooms: false,
        transitions: 'none',
        music: false,
      },
      rightsScope: 'SHARED_PERMITTED',
    });
    createdStorageKeys.push(id.storageKey);

    // Separate broadcast: simulate lease expiration during FFmpeg + stale worker trying to publish
    const staleAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'kick',
        channelName: 'stale_demo',
        broadcastId: `session_stale_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    const staleSource = staleAdapter.buildVerifiedBroadcastSource();
    trackRedis(staleSource.canonicalId);

    const stalePromise = service.requestSharedBroadcastHighlight({
      adapter: staleAdapter,
      requesterUserId: 'c_stale',
      workerId: 'worker_stale',
      leaseMs: 10_000,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      onBeforePublishReady: async () => {
        // Simulate worker_stale stalling past lease expiry while worker_new recovers ownership
        const rec = await coordinator.requestIngestion({
          canonicalSourceId: staleSource.canonicalId,
          requesterId: 'c_new',
          workerId: 'worker_new',
          leaseMs: 30_000,
          nowMs: Date.now() + 20_000,
        });
        expect(rec.action).toBe('ACQUIRED_RECOVERY');
        expect(rec.fencingToken).toBe(2);
      },
    });

    // Stale worker MUST fail with LEASE_EXPIRED and cannot publish READY
    await expect(stalePromise).rejects.toThrow(/Cannot renew lease|lost lease/);
    const stateAfterStale = await coordinator.getState(staleSource.canonicalId);
    expect(stateAfterStale?.ownerWorkerId).toBe('worker_new');
    expect(stateAfterStale?.fencingToken).toBe(2);
  }, 90_000);

  it('3. handles Redis record loss by reusing MinIO cache and recovers when MinIO object is missing', async () => {
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix: redisKeyPrefix,
      recordTtlMs: 60_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);
    const service = new SharedLiveProcessingService(coordinator, storage, workRoot);

    const adapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'youtube',
        channelName: 'yt_demo',
        broadcastId: `yt3b5_${Date.now().toString().slice(-5)}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    const source = adapter.buildVerifiedBroadcastSource();
    trackRedis(source.canonicalId);

    const first = await service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c1',
      workerId: 'w1',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(service.metrics.ffmpegClipRenderCount).toBe(1);

    const auth = createTrustedCacheAuthContext({ source, requesterUserId: 'c1', allowSharedCacheReuse: true });
    const id = resolveAuthorizedCacheIdentity(auth, {
      artifactKind: 'BASE_CLIP',
      sourceRevision: 'v1',
      timeRangeSec: { start: first.candidate.windowStartSec, end: first.candidate.windowEndSec },
      algorithmVersion: 'v1.0-heuristic',
      renderSettings: {
        format: 'reel',
        width: 1280,
        height: 720,
        fps: 30,
        subtitles: false,
        zooms: false,
        transitions: 'none',
        music: false,
      },
      rightsScope: 'SHARED_PERMITTED',
    });
    createdStorageKeys.push(id.storageKey);

    // 3a. Simulate Redis record loss (key eviction / TTL expiry) while MinIO object still exists
    await redis.del(`${redisKeyPrefix}${source.canonicalId}`);
    const afterRedisLoss = await service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c2',
      workerId: 'w2',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(afterRedisLoss.cacheKey).toBe(first.cacheKey);
    // Durable MinIO object was detected before FFmpeg clip render -> ZERO extra FFmpeg clip renders!
    expect(service.metrics.ffmpegClipRenderCount).toBe(1);

    // 3b. Simulate missing MinIO object while Redis STILL says READY -> triggers recovery & regeneration!
    await storage.deleteObject({ key: id.storageKey });
    const afterMissingObj = await service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c3',
      workerId: 'w3',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(afterMissingObj.coordinationAction).toBe('ACQUIRED_RECOVERY');
    expect(afterMissingObj.sizeBytes).toBeGreaterThan(10_000);
    expect(service.metrics.recoveryRuns).toBeGreaterThanOrEqual(1);
    expect(service.metrics.ffmpegClipRenderCount).toBe(2);
  }, 90_000);

  it('4. blocks unauthorized rights, separates consecutive broadcasts, and isolates private user edits', async () => {
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix: redisKeyPrefix,
      recordTtlMs: 60_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);
    const service = new SharedLiveProcessingService(coordinator, storage, workRoot);

    // 4a. Unauthorized rights fail closed BEFORE Redis or FFmpeg
    const deniedAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'locked_channel',
        broadcastId: 'session_denied',
        rightsStatus: 'RESTRICTED_DRM',
        allowSharedCacheReuse: true,
      },
    });
    await expect(
      service.requestSharedBroadcastHighlight({
        adapter: deniedAdapter,
        requesterUserId: 'user_1',
        workerId: 'w1',
      }),
    ).rejects.toThrow(MediaSourceError);
    expect(service.metrics.sourceProcessingCount).toBe(0);

    // 4b. Different broadcasts on the same channel do not collide
    const monAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'same_channel',
        broadcastId: `mon_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    const tueAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'same_channel',
        broadcastId: `tue_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    expect(monAdapter.buildVerifiedBroadcastSource().canonicalId).not.toBe(
      tueAdapter.buildVerifiedBroadcastSource().canonicalId,
    );

    // 4c. Two users create distinct PRIVATE edits from the same shared broadcast; cross-user access DENIED!
    const editA = await service.renderPrivateUserEdit({
      adapter: monAdapter,
      requesterUserId: 'user_A',
      ownerUserId: 'user_A',
      customEditHash: 'user_A_prompt_cut_1',
      windowStartSec: 12,
      windowEndSec: 18,
      bufferConfig: { segmentDurationSec: 5 },
    });
    const editB = await service.renderPrivateUserEdit({
      adapter: monAdapter,
      requesterUserId: 'user_B',
      ownerUserId: 'user_B',
      customEditHash: 'user_B_prompt_cut_2',
      windowStartSec: 14,
      windowEndSec: 20,
      bufferConfig: { segmentDurationSec: 5 },
    });

    expect(editA.cacheKey).not.toBe(editB.cacheKey);
    expect(editA.downloadUrl).toContain('cache/private/user_A/');
    expect(editB.downloadUrl).toContain('cache/private/user_B/');

    const srcMon = monAdapter.buildVerifiedBroadcastSource();
    createdStorageKeys.push(
      resolveAuthorizedCacheIdentity(
        createTrustedCacheAuthContext({ source: srcMon, requesterUserId: 'user_A', ownerUserId: 'user_A' }),
        editA.descriptor,
      ).storageKey,
      resolveAuthorizedCacheIdentity(
        createTrustedCacheAuthContext({ source: srcMon, requesterUserId: 'user_B', ownerUserId: 'user_B' }),
        editB.descriptor,
      ).storageKey,
    );

    // User B trying to download User A's private edit is strictly denied!
    await expect(
      service.requestAuthorizedCachedClipDownload({
        adapter: monAdapter,
        requesterUserId: 'user_B',
        ownerUserId: 'user_A',
        descriptor: editA.descriptor,
      }),
    ).rejects.toThrow(/Cross-user access/);
  }, 90_000);
});
