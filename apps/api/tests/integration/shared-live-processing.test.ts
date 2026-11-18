import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  buildSourceWorkId,
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

describe('Step 3B.5.1: Multi-Instance Distributed Shared Live Processing & Cache Recovery Integration', () => {
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
  const workRootA = path.resolve(process.cwd(), 'tmp', `step3b51-instA-${Date.now()}`);
  const workRootB = path.resolve(process.cwd(), 'tmp', `step3b51-instB-${Date.now()}`);
  const workRootProbe = path.resolve(process.cwd(), 'tmp', `step3b51-probe-${Date.now()}`);
  const redisKeyPrefix = `autoedit:test:step3b51:${Date.now()}:`;
  const createdStorageKeys = new Set<string>();

  function createIndependentService(workRoot: string, recordTtlMs = 120_000): {
    coordinator: SharedIngestionCoordinator;
    service: SharedLiveProcessingService;
  } {
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix: redisKeyPrefix,
      recordTtlMs,
    });
    const coordinator = new SharedIngestionCoordinator(store);
    const service = new SharedLiveProcessingService(coordinator, storage, workRoot);
    return { coordinator, service };
  }

  function trackDescriptorAndObject(
    adapter: ControlledLocalStreamAdapter,
    descriptor: Parameters<typeof resolveAuthorizedCacheIdentity>[1],
    objectKey?: string,
    ownerUserId?: string,
  ) {
    const auth = createTrustedCacheAuthContext({
      source: adapter.buildVerifiedBroadcastSource(),
      requesterUserId: ownerUserId ?? 'cleanup_user',
      ownerUserId,
      allowSharedCacheReuse: adapter.policy.allowSharedCacheReuse,
    });
    const id = resolveAuthorizedCacheIdentity(auth, descriptor);
    createdStorageKeys.add(id.storageKey);
    createdStorageKeys.add(`${id.storageKey}.manifest.json`);
    if (objectKey) createdStorageKeys.add(objectKey);
  }

  beforeAll(async () => {
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
    // Clean up all Redis keys created under our test prefix
    const keys = await redis.keys(`${redisKeyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys).catch(() => {});
    }
    for (const sKey of createdStorageKeys) {
      await storage.deleteObject({ key: sKey }).catch(() => {});
    }
    await fs.rm(workRootA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootB, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootProbe, { recursive: true, force: true }).catch(() => {});
  });

  it('1. coordinates 1,000 concurrent clippers across TWO independent instances -> 1 FFmpeg render -> verified MP4 -> 5,000 authorized download URL issuances', async () => {
    const instA = createIndependentService(workRootA);
    const instB = createIndependentService(workRootB);

    const adapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'gta6_multi',
        broadcastId: `session_multi_1000_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });

    const t0 = Date.now();
    // 500 concurrent requests on Service A + 500 concurrent requests on Service B (separate local state!)
    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => {
        const svc = i % 2 === 0 ? instA.service : instB.service;
        return svc.requestSharedBroadcastHighlight({
          adapter,
          requesterUserId: `clipper_${i}`,
          workerId: `inst${i % 2 === 0 ? 'A' : 'B'}_worker_${i}`,
          bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
          scoreThreshold: 65,
          cooldownSec: 15,
        });
      }),
    );
    const fanInMs = Date.now() - t0;

    // Strictly ONE logical owner across BOTH independent service instances!
    const acquiredNew = results.filter((r) => r.coordinationAction === 'ACQUIRED_NEW');
    const attachedOrReused = results.filter(
      (r) => r.coordinationAction === 'ATTACH_EXISTING' || r.coordinationAction === 'REUSE_READY',
    );
    expect(acquiredNew).toHaveLength(1);
    expect(attachedOrReused).toHaveLength(999);

    const totalSource = instA.service.metrics.sourceProcessingCount + instB.service.metrics.sourceProcessingCount;
    const totalAnalysis = instA.service.metrics.analysisPassCount + instB.service.metrics.analysisPassCount;
    const totalClipRenders = instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount;
    expect(totalSource).toBe(1);
    expect(totalAnalysis).toBe(1);
    expect(totalClipRenders).toBe(1);

    // Proof that the non-owner remote instance waited via ATTACH_EXISTING and ran ZERO clip renders!
    const nonOwnerRenders = Math.min(
      instA.service.metrics.ffmpegClipRenderCount,
      instB.service.metrics.ffmpegClipRenderCount,
    );
    expect(nonOwnerRenders).toBe(0);

    // All 1,000 clippers received the exact same verified cacheKey, immutable objectKey, and REAL MP4 sha256
    const uniqueCacheKeys = new Set(results.map((r) => r.cacheKey));
    const uniqueObjectKeys = new Set(results.map((r) => r.objectKey));
    const uniqueShas = new Set(results.map((r) => r.clipMeta.sha256));
    expect(uniqueCacheKeys.size).toBe(1);
    expect(uniqueObjectKeys.size).toBe(1);
    expect(uniqueShas.size).toBe(1);

    const first = results[0];
    // Real MP4 content SHA-256 must NEVER be fabricated from cacheKey
    expect(first.clipMeta.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.clipMeta.sha256).not.toBe(first.cacheKey);
    expect(first.candidate.eventTimestampSec).toBeGreaterThanOrEqual(15.5);
    expect(first.candidate.eventTimestampSec).toBeLessThanOrEqual(19.5);

    trackDescriptorAndObject(adapter, first.descriptor, first.objectKey);

    // Verify Redis clip coordination record stays compact O(1) with exact attachedCount=1000
    const clipRecord = await instA.coordinator.getState(first.workIds.clipWorkId);
    expect(clipRecord?.state).toBe('READY');
    expect(clipRecord?.attachedCount).toBe(1000);
    expect(JSON.stringify(clipRecord).length).toBeLessThan(450);

    // Download actual MP4 bytes from MinIO via presigned URL and probe with ffprobe
    const res = await fetch(first.downloadUrl);
    expect(res.ok).toBe(true);
    const downloadedBuf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(workRootProbe, { recursive: true });
    const downloadedPath = path.join(workRootProbe, 'verified-multi-inst.mp4');
    await fs.writeFile(downloadedPath, downloadedBuf);

    const probed = await probeAndValidateClipMp4(downloadedPath, { requireAudio: true });
    expect(probed.sizeBytes).toBe(first.clipMeta.sizeBytes);
    expect(probed.sha256).toBe(first.clipMeta.sha256);
    expect(probed.videoCodec).toBe('h264');
    expect(probed.audioCodec).toBe('aac');
    expect(probed.width).toBe(1280);
    expect(probed.height).toBe(720);
    expect(probed.durationSec).toBeGreaterThanOrEqual(8);

    // Honest 5,000-download test: measures authorized cache lookups + short-lived signed URL issuance
    // across both instances (NOT 5,000 full MP4 network transfers / CDN load test).
    const tDl = Date.now();
    const memBefore = process.memoryUsage().heapUsed;
    let verifiedCount = 0;
    const batchSize = 250;
    for (let offset = 0; offset < 5000; offset += batchSize) {
      const batch = await Promise.all(
        Array.from({ length: batchSize }, (_, j) => {
          const idx = offset + j;
          const svc = idx % 2 === 0 ? instA.service : instB.service;
          return svc.requestAuthorizedCachedClipDownload({
            adapter,
            requesterUserId: `downloader_${idx}`,
            descriptor: first.descriptor,
            objectKey: first.objectKey,
            verifyExistsInStorage: j === 0,
            expiresIn: 600,
          });
        }),
      );
      for (const item of batch) {
        expect(item.cacheKey).toBe(first.cacheKey);
        expect(item.objectKey).toBe(first.objectKey);
        expect(item.downloadUrl).toContain(first.objectKey);
        verifiedCount++;
      }
    }
    const dl5000Ms = Date.now() - tDl;
    const heapDeltaMb = (process.memoryUsage().heapUsed - memBefore) / (1024 * 1024);

    expect(verifiedCount).toBe(5000);
    // Zero extra FFmpeg runs after 5,000 authorized download URL issuances
    expect(instA.service.metrics.sourceProcessingCount + instB.service.metrics.sourceProcessingCount).toBe(1);
    expect(instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount).toBe(1);
    expect(heapDeltaMb).toBeLessThan(150);

    console.log(
      `[Step 3B.5.1 Measured] 1,000 multi-instance clippers=${fanInMs}ms (instA renders=${instA.service.metrics.ffmpegClipRenderCount}, instB renders=${instB.service.metrics.ffmpegClipRenderCount}) | 5,000 authorized URL issuances=${dl5000Ms}ms (heapDelta=${heapDeltaMb.toFixed(1)}MB) | MP4=${probed.sizeBytes}B sha256=${probed.sha256.slice(0, 12)} ${probed.durationSec}s ${probed.videoCodec}/${probed.audioCodec} ${probed.width}x${probed.height}`,
    );
  }, 120_000);

  it('2. separates renderSettings, algorithmVersion, and sourceRevision while reusing upstream source acquisition', async () => {
    const instA = createIndependentService(workRootA);
    const instB = createIndependentService(workRootB);

    const adapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'scoped_demo',
        broadcastId: `session_scoped_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });

    // Baseline: v1, v1.0-heuristic, 1280x720@30fps on instA
    const base720 = await instA.service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c1',
      workerId: 'instA_w1',
      sourceRevision: 'v1',
      algorithmVersion: 'v1.0-heuristic',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    trackDescriptorAndObject(adapter, base720.descriptor, base720.objectKey);
    expect(instA.service.metrics.sourceProcessingCount).toBe(1);
    expect(instA.service.metrics.analysisPassCount).toBe(1);
    expect(instA.service.metrics.ffmpegClipRenderCount).toBe(1);

    // Different renderSettings (640x360@24fps) on instB -> REUSES Layer A & Layer B, creates DISTINCT clip!
    const variant360 = await instB.service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c2',
      workerId: 'instB_w2',
      sourceRevision: 'v1',
      algorithmVersion: 'v1.0-heuristic',
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
    trackDescriptorAndObject(adapter, variant360.descriptor, variant360.objectKey);

    expect(variant360.cacheKey).not.toBe(base720.cacheKey);
    expect(variant360.objectKey).not.toBe(base720.objectKey);
    expect(variant360.workIds.sourceWorkId).toBe(base720.workIds.sourceWorkId);
    expect(variant360.workIds.analysisWorkId).toBe(base720.workIds.analysisWorkId);
    expect(variant360.workIds.clipWorkId).not.toBe(base720.workIds.clipWorkId);
    expect(variant360.clipMeta.width).toBe(640);
    expect(variant360.clipMeta.height).toBe(360);
    // Upstream source segmentation & analysis were NOT duplicated on instB!
    expect(instB.service.metrics.sourceProcessingCount).toBe(0);
    expect(instB.service.metrics.analysisPassCount).toBe(0);
    expect(instB.service.metrics.ffmpegClipRenderCount).toBe(1);

    // Different algorithmVersion on instB -> REUSES Layer A, runs distinct Layer B & Layer C!
    const altAlgo = await instB.service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c3',
      workerId: 'instB_w3',
      sourceRevision: 'v1',
      algorithmVersion: 'v1.1-multimodal',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    trackDescriptorAndObject(adapter, altAlgo.descriptor, altAlgo.objectKey);
    expect(altAlgo.workIds.sourceWorkId).toBe(base720.workIds.sourceWorkId);
    expect(altAlgo.workIds.analysisWorkId).not.toBe(base720.workIds.analysisWorkId);
    expect(altAlgo.cacheKey).not.toBe(base720.cacheKey);
    expect(instB.service.metrics.sourceProcessingCount).toBe(0);
    expect(instB.service.metrics.analysisPassCount).toBe(1);

    // Different sourceRevision ('v2') on instB -> distinct Layer A, B, C (does NOT share v1 output!)
    const revV2 = await instB.service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c4',
      workerId: 'instB_w4',
      sourceRevision: 'v2',
      algorithmVersion: 'v1.0-heuristic',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    trackDescriptorAndObject(adapter, revV2.descriptor, revV2.objectKey);
    expect(revV2.workIds.sourceWorkId).not.toBe(base720.workIds.sourceWorkId);
    expect(revV2.workIds.analysisWorkId).not.toBe(base720.workIds.analysisWorkId);
    expect(revV2.workIds.clipWorkId).not.toBe(base720.workIds.clipWorkId);
    expect(revV2.cacheKey).not.toBe(base720.cacheKey);
    expect(instB.service.metrics.sourceProcessingCount).toBe(1);
  }, 120_000);

  it('3. coordinates across TWO SEPARATE NODE OS PROCESSES sharing only Redis and MinIO', async () => {
    const instA = createIndependentService(workRootA);
    const broadcastId = `session_multiproc_${Date.now()}`;
    const adapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'multiproc_demo',
        broadcastId,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });

    // Spawn a genuinely separate Node child process running its own SharedLiveProcessingService!
    const helperScriptPath = path.join(workRootProbe, 'child-worker.mjs');
    await fs.mkdir(workRootProbe, { recursive: true });
    const distMediaUrl = new URL('../../dist/media/index.js', import.meta.url).href;
    const distStorageUrl = new URL('../../dist/storage/index.js', import.meta.url).href;
    const distRedisUrl = new URL('../../dist/lib/redis.js', import.meta.url).href;

    const childCode = `
import { ControlledLocalStreamAdapter, SharedIngestionCoordinator, RedisCoordinationStore, SharedLiveProcessingService } from ${JSON.stringify(distMediaUrl)};
import { createStorageProvider } from ${JSON.stringify(distStorageUrl)};
import { connection as redis } from ${JSON.stringify(distRedisUrl)};

const storage = createStorageProvider({
  providerType: 'minio',
  bucket: ${JSON.stringify(MINIO_BUCKET)},
  region: ${JSON.stringify(process.env.AWS_REGION || 'us-east-1')},
  accessKeyId: ${JSON.stringify(MINIO_ACCESS_KEY)},
  secretAccessKey: ${JSON.stringify(MINIO_SECRET_KEY)},
  endpoint: ${JSON.stringify(MINIO_ENDPOINT)},
  forcePathStyle: true,
  presignTtlSec: 3600,
});
const store = new RedisCoordinationStore(redis, {
  keyPrefix: ${JSON.stringify(redisKeyPrefix)},
  recordTtlMs: 120000,
});
const coordinator = new SharedIngestionCoordinator(store);
const service = new SharedLiveProcessingService(coordinator, storage, ${JSON.stringify(path.join(workRootProbe, 'child-work'))});
const adapter = new ControlledLocalStreamAdapter({
  fixturePath: ${JSON.stringify(fixturePath)},
  policy: {
    enabled: true,
    provider: 'twitch',
    channelName: 'multiproc_demo',
    broadcastId: ${JSON.stringify(broadcastId)},
    rightsStatus: 'PERMITTED_PUBLIC',
    allowSharedCacheReuse: true,
  },
});

const result = await service.requestSharedBroadcastHighlight({
  adapter,
  requesterUserId: 'child_clipper',
  workerId: 'child_proc_worker_' + process.pid,
  bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
});

process.stdout.write(JSON.stringify({
  pid: process.pid,
  action: result.coordinationAction,
  cacheKey: result.cacheKey,
  objectKey: result.objectKey,
  sha256: result.clipMeta.sha256,
  metrics: service.metrics,
}) + '\\n');
await redis.quit();
`;
    await fs.writeFile(helperScriptPath, childCode, 'utf-8');

    const runChild = () =>
      new Promise<{
        pid: number;
        action: string;
        cacheKey: string;
        objectKey: string;
        sha256: string;
        metrics: { sourceProcessingCount: number; analysisPassCount: number; ffmpegClipRenderCount: number };
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [helperScriptPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += String(d)));
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            return reject(new Error(`Child process failed (code ${code}): ${stderr}`));
          }
          const lastLine = stdout.trim().split('\n').pop() || '';
          resolve(JSON.parse(lastLine));
        });
      });

    // Race parent OS process and child OS process concurrently against the exact same broadcast!
    const [parentRes, childRes] = await Promise.all([
      instA.service.requestSharedBroadcastHighlight({
        adapter,
        requesterUserId: 'parent_clipper',
        workerId: `parent_proc_worker_${process.pid}`,
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      }),
      runChild(),
    ]);

    trackDescriptorAndObject(adapter, parentRes.descriptor, parentRes.objectKey);

    expect(childRes.pid).not.toBe(process.pid);
    expect(childRes.cacheKey).toBe(parentRes.cacheKey);
    expect(childRes.objectKey).toBe(parentRes.objectKey);
    expect(childRes.sha256).toBe(parentRes.clipMeta.sha256);

    // Strictly ONE source segmentation, ONE analysis, ONE clip render across BOTH OS processes!
    expect(instA.service.metrics.sourceProcessingCount + childRes.metrics.sourceProcessingCount).toBe(1);
    expect(instA.service.metrics.analysisPassCount + childRes.metrics.analysisPassCount).toBe(1);
    expect(instA.service.metrics.ffmpegClipRenderCount + childRes.metrics.ffmpegClipRenderCount).toBe(1);
  }, 90_000);

  it('4. recovers on remote instance when owner crashes while waiting, and recovers after lease expiration', async () => {
    const instA = createIndependentService(workRootA);
    const instB = createIndependentService(workRootB);

    // 4a. Owner (instA) crashes while remote instance (instB) is waiting via ATTACH_EXISTING -> instB recovers cleanly!
    const crashAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'kick',
        channelName: 'crash_wait_demo',
        broadcastId: `session_crash_wait_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });

    let releaseCrash!: () => void;
    const ownerStartedClip = new Promise<void>((res) => {
      releaseCrash = res;
    });

    const ownerPromise = instA.service.requestSharedBroadcastHighlight({
      adapter: crashAdapter,
      requesterUserId: 'clipper_owner',
      workerId: 'instA_owner_crash',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      onAfterExtractBeforeUpload: async () => {
        releaseCrash();
        // Hold briefly so instB definitely attaches to the active clip workId before crash
        await new Promise((r) => setTimeout(r, 150));
        throw new Error('Simulated instA storage crash');
      },
    });

    await ownerStartedClip;
    // Start remote waiter instB while instA is actively running Layer C
    const waiterPromise = instB.service.requestSharedBroadcastHighlight({
      adapter: crashAdapter,
      requesterUserId: 'clipper_waiter',
      workerId: 'instB_remote_recover',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      pollInitialMs: 20,
      pollMaxMs: 60,
    });

    await expect(ownerPromise).rejects.toThrow(/Simulated instA storage crash/);
    const recoveredByB = await waiterPromise;
    trackDescriptorAndObject(crashAdapter, recoveredByB.descriptor, recoveredByB.objectKey);

    expect(recoveredByB.coordinationAction).toBe('ACQUIRED_RECOVERY');
    expect(recoveredByB.sizeBytes).toBeGreaterThan(10_000);
    expect(instB.service.metrics.recoveryRuns).toBeGreaterThanOrEqual(1);
    expect(instB.service.metrics.ffmpegClipRenderCount).toBe(1);

    // 4b. Recovery after lease expiration (abandoned dead owner in Redis with short lease)
    const expAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'kick',
        channelName: 'lease_exp_demo',
        broadcastId: `session_exp_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    const expSrc = expAdapter.buildVerifiedBroadcastSource();
    const expSourceWorkId = buildSourceWorkId(expSrc.canonicalId, 'v1_s5');

    // Simulate dead worker holding an abandoned 250ms lease on Layer A (no heartbeat renewing it)
    const deadAcq = await instA.coordinator.requestIngestion({
      canonicalSourceId: expSourceWorkId,
      requesterId: 'dead_req',
      workerId: 'dead_worker_hung',
      leaseMs: 250,
    });
    expect(deadAcq.action).toBe('ACQUIRED_NEW');

    // instB arrives immediately -> attaches, waits for dead lease expiry, recovers cleanly!
    const afterExpiry = await instB.service.requestSharedBroadcastHighlight({
      adapter: expAdapter,
      requesterUserId: 'live_req',
      workerId: 'instB_expiry_recover',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      pollInitialMs: 30,
      pollMaxMs: 80,
    });
    trackDescriptorAndObject(expAdapter, afterExpiry.descriptor, afterExpiry.objectKey);
    expect(afterExpiry.sizeBytes).toBeGreaterThan(10_000);
    const srcState = await instB.coordinator.getState(expSourceWorkId);
    expect(srcState?.state).toBe('READY');
    expect(srcState?.fencingToken).toBe(2);
  }, 120_000);

  it('5. handles Redis key loss, concurrent missing-object repair (1 owner), and corrupt-object detection without serving corrupt bytes', async () => {
    const instA = createIndependentService(workRootA);
    const instB = createIndependentService(workRootB);

    const adapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'youtube',
        channelName: 'yt_repair_demo',
        broadcastId: `yt51_${Date.now().toString().slice(-6)}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });

    // Initial run on instA
    const initial = await instA.service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c1',
      workerId: 'instA_w1',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    trackDescriptorAndObject(adapter, initial.descriptor, initial.objectKey);
    expect(instA.service.metrics.ffmpegClipRenderCount).toBe(1);

    // 5a. Redis keys disappear while durable valid manifests + MP4 remain in MinIO
    await redis.del(
      `${redisKeyPrefix}${initial.workIds.sourceWorkId}`,
      `${redisKeyPrefix}${initial.workIds.analysisWorkId}`,
      `${redisKeyPrefix}${initial.workIds.clipWorkId}`,
    );

    const afterRedisLoss = await instB.service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c2',
      workerId: 'instB_w2',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    expect(afterRedisLoss.cacheKey).toBe(initial.cacheKey);
    expect(afterRedisLoss.objectKey).toBe(initial.objectKey);
    // Rehydrated REAL probe metadata from persisted manifest (NOT fabricated!)
    expect(afterRedisLoss.clipMeta.sha256).toBe(initial.clipMeta.sha256);
    expect(afterRedisLoss.clipMeta.sha256).not.toBe(afterRedisLoss.cacheKey);
    // ZERO extra FFmpeg runs!
    expect(instB.service.metrics.sourceProcessingCount).toBe(0);
    expect(instB.service.metrics.analysisPassCount).toBe(0);
    expect(instB.service.metrics.ffmpegClipRenderCount).toBe(0);

    // 5b. Missing cached MP4 object under 16 CONCURRENT repair requests across instA & instB -> strictly 1 repair owner!
    await storage.deleteObject({ key: initial.objectKey });
    const rendersBeforeRepair =
      instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount;
    const repairsBefore =
      instA.service.metrics.repairAcquisitions + instB.service.metrics.repairAcquisitions;

    const repairResults = await Promise.all(
      Array.from({ length: 16 }, (_, i) => {
        const svc = i % 2 === 0 ? instA.service : instB.service;
        return svc.requestSharedBroadcastHighlight({
          adapter,
          requesterUserId: `repair_user_${i}`,
          workerId: `repair_w_${i}`,
          bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
          pollInitialMs: 20,
          pollMaxMs: 60,
        });
      }),
    );

    const rendersAfterRepair =
      instA.service.metrics.ffmpegClipRenderCount + instB.service.metrics.ffmpegClipRenderCount;
    const repairsAfter =
      instA.service.metrics.repairAcquisitions + instB.service.metrics.repairAcquisitions;

    expect(repairsAfter - repairsBefore).toBe(1);
    expect(rendersAfterRepair - rendersBeforeRepair).toBe(1);
    const repairedObjKey = repairResults[0].objectKey;
    trackDescriptorAndObject(adapter, repairResults[0].descriptor, repairedObjKey);
    expect(new Set(repairResults.map((r) => r.objectKey)).size).toBe(1);
    expect(repairedObjKey).not.toBe(initial.objectKey); // new immutable generation key!
    expect(repairResults[0].fencingToken).toBeGreaterThan(afterRedisLoss.fencingToken);

    // 5c. Corrupt cached MP4 object (same-byte-length garbage!) is NEVER served -> detected & repaired!
    const garbageSameLength = Buffer.alloc(repairResults[0].clipMeta.sizeBytes, 0x58);
    await storage.putObject({
      key: repairedObjKey,
      body: garbageSameLength,
      contentType: 'video/mp4',
    });

    // Direct authorized download check refuses to serve corrupt object!
    await expect(
      instB.service.requestAuthorizedCachedClipDownload({
        adapter,
        requesterUserId: 'dl_check',
        descriptor: repairResults[0].descriptor,
        verifyExistsInStorage: true,
      }),
    ).rejects.toThrow(MediaSourceError);

    // Shared highlight request detects corruption, invalidates atomically, and repairs cleanly!
    const afterCorruptRepair = await instB.service.requestSharedBroadcastHighlight({
      adapter,
      requesterUserId: 'c_corrupt_repair',
      workerId: 'instB_corrupt_repair',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    trackDescriptorAndObject(adapter, afterCorruptRepair.descriptor, afterCorruptRepair.objectKey);
    expect(instB.service.metrics.corruptArtifactsDetected).toBeGreaterThanOrEqual(1);
    expect(afterCorruptRepair.objectKey).not.toBe(repairedObjKey);
    expect(afterCorruptRepair.fencingToken).toBeGreaterThan(repairResults[0].fencingToken);

    // Verify downloaded repaired MP4 is genuinely playable via ffprobe
    const dlRes = await fetch(afterCorruptRepair.downloadUrl);
    expect(dlRes.ok).toBe(true);
    const dlBytes = Buffer.from(await dlRes.arrayBuffer());
    await fs.mkdir(workRootProbe, { recursive: true });
    const probePath = path.join(workRootProbe, 'repaired-after-corrupt.mp4');
    await fs.writeFile(probePath, dlBytes);
    const probed = await probeAndValidateClipMp4(probePath, { requireAudio: true });
    expect(probed.sha256).toBe(afterCorruptRepair.clipMeta.sha256);
    expect(probed.videoCodec).toBe('h264');
    expect(probed.audioCodec).toBe('aac');
  }, 120_000);

  it('6. prevents stale worker overwrites, renews leases during long processing, and cleans up on cancellation/timeout', async () => {
    const instA = createIndependentService(workRootA);
    const instB = createIndependentService(workRootB);

    // 6a. Stale worker cannot overwrite a newer artifact (fenced by Redis AND manifest fencingToken)
    const staleAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'kick',
        channelName: 'stale_fence_demo',
        broadcastId: `session_stale_51_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });

    let newerPublishedObjKey = '';
    const stalePromise = instA.service.requestSharedBroadcastHighlight({
      adapter: staleAdapter,
      requesterUserId: 'c_stale',
      workerId: 'worker_stale',
      leaseMs: 10_000,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      onBeforePublishReady: async ({ workId }) => {
        // Simulate worker_stale stalling past lease expiry while instB takes over (token=2) and publishes newer artifact!
        const takeover = await instB.coordinator.requestIngestion({
          canonicalSourceId: workId,
          requesterId: 'c_newer',
          workerId: 'worker_newer',
          leaseMs: 30_000,
          nowMs: Date.now() + 20_000,
        });
        expect(takeover.action).toBe('ACQUIRED_RECOVERY');
        expect(takeover.fencingToken).toBe(2);
        newerPublishedObjKey = `cache/shared/newer-token-2-${Date.now()}.mp4`;
        await instB.coordinator.markReady({
          canonicalSourceId: workId,
          workerId: 'worker_newer',
          fencingToken: 2,
          artifactRef: newerPublishedObjKey,
        });
      },
    });

    await expect(stalePromise).rejects.toThrow(/Cannot renew lease|lost lease|LEASE_EXPIRED/);

    // 6b. Long-running processing actively renews its lease via heartbeat without losing ownership
    const hbAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'heartbeat_demo',
        broadcastId: `session_hb_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });

    const hbBefore = instA.service.metrics.heartbeatRenewals;
    let clipStarted!: () => void;
    const clipStartedPromise = new Promise<void>((r) => (clipStarted = r));

    const longOwnerPromise = instA.service.requestSharedBroadcastHighlight({
      adapter: hbAdapter,
      requesterUserId: 'hb_owner',
      workerId: 'instA_long_owner',
      leaseMs: 600, // heartbeat fires every 200ms!
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      onAfterExtractBeforeUpload: async () => {
        clipStarted();
        // Hold 1,100ms (> 600ms lease!) -> ONLY succeeds if heartbeat continuously renews lease!
        await new Promise((r) => setTimeout(r, 1100));
      },
    });

    await clipStartedPromise;
    // Waiter arrives on instB during the 1,100ms hold; sees continuously renewed lease, waits cleanly!
    const waiterResPromise = instB.service.requestSharedBroadcastHighlight({
      adapter: hbAdapter,
      requesterUserId: 'hb_waiter',
      workerId: 'instB_hb_waiter',
      leaseMs: 600,
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      pollInitialMs: 40,
      pollMaxMs: 100,
    });

    // Also test 6c: a third caller with a short waitTimeoutMs (120ms) times out cleanly without starting FFmpeg!
    await expect(
      instB.service.requestSharedBroadcastHighlight({
        adapter: hbAdapter,
        requesterUserId: 'hb_timeout',
        workerId: 'instB_timeout',
        waitTimeoutMs: 120,
        pollInitialMs: 20,
        pollMaxMs: 40,
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      }),
    ).rejects.toMatchObject({ code: 'COORDINATION_TIMEOUT' });

    // Also test 6d: a fourth caller cancelled via AbortController exits immediately!
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 80);
    await expect(
      instB.service.requestSharedBroadcastHighlight({
        adapter: hbAdapter,
        requesterUserId: 'hb_cancel',
        workerId: 'instB_cancel',
        signal: abortCtrl.signal,
        pollInitialMs: 20,
        pollMaxMs: 40,
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });

    const [longOwnerRes, waiterRes] = await Promise.all([longOwnerPromise, waiterResPromise]);
    trackDescriptorAndObject(hbAdapter, longOwnerRes.descriptor, longOwnerRes.objectKey);

    expect(longOwnerRes.coordinationAction).toBe('ACQUIRED_NEW');
    expect(waiterRes.coordinationAction).toBe('ATTACH_EXISTING');
    expect(waiterRes.objectKey).toBe(longOwnerRes.objectKey);
    expect(instA.service.metrics.heartbeatRenewals - hbBefore).toBeGreaterThanOrEqual(3);
    expect(instB.service.metrics.ffmpegClipRenderCount).toBe(0);

    // 6e. Cancelling an active owner aborts FFmpeg/processing, cleans up scratch files, and lets another instance recover
    const cancelOwnerAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'owner_cancel_demo',
        broadcastId: `session_owner_cancel_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    const ownerCancelCtrl = new AbortController();
    await expect(
      instA.service.requestSharedBroadcastHighlight({
        adapter: cancelOwnerAdapter,
        requesterUserId: 'owner_cancel_u',
        workerId: 'instA_owner_cancel',
        signal: ownerCancelCtrl.signal,
        bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
        onAfterExtractBeforeUpload: async () => {
          ownerCancelCtrl.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });

    // instB cleanly recovers the cancelled clip work item and produces a valid MP4
    const recoveredAfterCancel = await instB.service.requestSharedBroadcastHighlight({
      adapter: cancelOwnerAdapter,
      requesterUserId: 'owner_recover_u',
      workerId: 'instB_owner_recover',
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });
    trackDescriptorAndObject(cancelOwnerAdapter, recoveredAfterCancel.descriptor, recoveredAfterCancel.objectKey);
    expect(recoveredAfterCancel.coordinationAction).toBe('ACQUIRED_RECOVERY');
    expect(recoveredAfterCancel.sizeBytes).toBeGreaterThan(10_000);
  }, 120_000);

  it('7. denies unauthorized rights before touching Redis/MinIO, separates broadcasts, and isolates private edits', async () => {
    const instA = createIndependentService(workRootA);
    const instB = createIndependentService(workRootB);

    // 7a. Rights/access denial occurs BEFORE accessing Redis or MinIO
    const deniedAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'locked_channel',
        broadcastId: `session_denied_${Date.now()}`,
        rightsStatus: 'RESTRICTED_DRM',
        allowSharedCacheReuse: true,
      },
    });
    const deniedSrc = deniedAdapter.buildVerifiedBroadcastSource();
    await expect(
      instA.service.requestSharedBroadcastHighlight({
        adapter: deniedAdapter,
        requesterUserId: 'user_1',
        workerId: 'w1',
      }),
    ).rejects.toThrow(MediaSourceError);
    expect(instA.service.metrics.sourceProcessingCount).toBe(0);
    const leakedKeys = await redis.keys(`${redisKeyPrefix}${deniedSrc.canonicalId}*`);
    expect(leakedKeys).toHaveLength(0);

    // 7b. Different broadcasts from the same channel remain distinct
    const monAdapter = new ControlledLocalStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'same_channel_51',
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
        channelName: 'same_channel_51',
        broadcastId: `tue_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
    });
    expect(monAdapter.buildVerifiedBroadcastSource().canonicalId).not.toBe(
      tueAdapter.buildVerifiedBroadcastSource().canonicalId,
    );

    // 7c. Private personalized edits remain isolated across instances and users
    const editA = await instA.service.renderPrivateUserEdit({
      adapter: monAdapter,
      requesterUserId: 'user_A',
      ownerUserId: 'user_A',
      customEditHash: 'user_A_prompt_cut_1',
      windowStartSec: 12,
      windowEndSec: 18,
      bufferConfig: { segmentDurationSec: 5 },
    });
    const editB = await instB.service.renderPrivateUserEdit({
      adapter: monAdapter,
      requesterUserId: 'user_B',
      ownerUserId: 'user_B',
      customEditHash: 'user_B_prompt_cut_2',
      windowStartSec: 14,
      windowEndSec: 20,
      bufferConfig: { segmentDurationSec: 5 },
    });

    trackDescriptorAndObject(monAdapter, editA.descriptor, undefined, 'user_A');
    trackDescriptorAndObject(monAdapter, editB.descriptor, undefined, 'user_B');

    expect(editA.cacheKey).not.toBe(editB.cacheKey);
    expect(editA.downloadUrl).toContain('cache/private/user_A/');
    expect(editB.downloadUrl).toContain('cache/private/user_B/');

    // Cross-user access to private edit is strictly denied even from a different instance!
    await expect(
      instB.service.requestAuthorizedCachedClipDownload({
        adapter: monAdapter,
        requesterUserId: 'user_B',
        ownerUserId: 'user_A',
        descriptor: editA.descriptor,
      }),
    ).rejects.toThrow(/Cross-user access/);
  }, 90_000);
});
