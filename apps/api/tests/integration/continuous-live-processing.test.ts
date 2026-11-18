import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  ensureControlledMultiEventLiveFixture,
  ControlledRealTimeStreamAdapter,
  SharedIngestionCoordinator,
  RedisCoordinationStore,
  SharedLiveProcessingService,
  FfmpegRollingSegmentBuffer,
  probeAndValidateClipMp4,
  resolveAuthorizedCacheIdentity,
  createTrustedCacheAuthContext,
  MediaSourceError,
  type PublishedLiveHighlight,
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

describe('Step 3B.6: Continuous Livestream Ingestion & Real-Time Highlight Generation (Real Redis + MinIO + FFmpeg)', () => {
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

  const fixturePath = path.resolve(process.cwd(), 'tmp', 'step3b6-3event-60s-fixture.mp4');
  const workRootA = path.resolve(process.cwd(), 'tmp', `step3b6-instA-${Date.now()}`);
  const workRootB = path.resolve(process.cwd(), 'tmp', `step3b6-instB-${Date.now()}`);
  const workRootProbe = path.resolve(process.cwd(), 'tmp', `step3b6-probe-${Date.now()}`);
  const redisKeyPrefix = `autoedit:test:step3b6:${Date.now()}:`;
  const createdStorageKeys = new Set<string>();

  function createService(workRoot: string, recordTtlMs = 180_000): {
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

  function trackHighlightStorage(
    adapter: ControlledRealTimeStreamAdapter,
    highlights: PublishedLiveHighlight[],
  ) {
    const auth = createTrustedCacheAuthContext({
      source: adapter.buildVerifiedBroadcastSource(),
      requesterUserId: 'cleanup_user',
      allowSharedCacheReuse: adapter.policy.allowSharedCacheReuse,
    });
    for (const h of highlights) {
      const id = resolveAuthorizedCacheIdentity(auth, h.descriptor);
      createdStorageKeys.add(id.storageKey);
      createdStorageKeys.add(`${id.storageKey}.manifest.json`);
      createdStorageKeys.add(h.objectKey);
    }
  }

  beforeAll(async () => {
    expect(await redis.ping()).toBe('PONG');
    const health = await storage.checkHealth();
    expect(health.ok).toBe(true);

    // Deterministically generate 60s 3-event fixture:
    // Event 1: 4–6s (early), Event 2: 26–29s (midstream), Event 3: 46–49s (late modulated)
    await ensureControlledMultiEventLiveFixture(fixturePath, {
      durationSec: 60,
    });
  }, 90_000);

  afterAll(async () => {
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

  it('1. streams 60s 3-event fixture incrementally, detects & renders highlights WHILE stream stays active, 0 false positives, valid MP4s, bounded disk & cleanup', async () => {
    const instA = createService(workRootA);
    const adapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'continuous_demo',
        broadcastId: `live_3ev_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4, // 15 segments total across 60s
        segmentPaceMs: 220, // real time-paced incremental emission (~3.5s+ wall-clock)
        maxQueueSize: 3,
      },
    });

    const readyCallbacks: PublishedLiveHighlight[] = [];
    const arrivalIndices: number[] = [];

    const result = await instA.service.joinOrStartContinuousBroadcast({
      adapter,
      requesterUserId: 'clipper_owner',
      workerId: 'instA_live_owner',
      bufferConfig: {
        segmentDurationSec: 4,
        preEventSec: 6, // > event 1 timestamp (4.5s) -> tests start-of-stream clamping at 0s!
        postEventSec: 4,
        maxRetentionSec: 60,
      },
      scoreThreshold: 65,
      cooldownSec: 12,
      aggregationWindowSec: 3,
      leaseMs: 2500, // short lease (~833ms heartbeat) so heartbeat MUST renew multiple times during continuous stream!
      onSegmentArrived: ({ index }) => {
        arrivalIndices.push(index);
      },
      onHighlightReady: (clip) => {
        readyCallbacks.push(clip);
      },
    });

    trackHighlightStorage(adapter, result.highlights);

    expect(result.wasSessionOwner).toBe(true);
    expect(result.streamStatus).toBe('ENDED');
    expect(result.metrics).not.toBeNull();
    const m = result.metrics!;

    // 1. Time-paced segment arrival (15 segments emitted over > 2.5s wall clock)
    expect(arrivalIndices).toHaveLength(15);
    expect(m.segmentsReceived).toBe(15);
    expect(m.validSegmentsReceived).toBe(15);
    expect(m.streamEndedAtMs - m.streamStartedAtMs).toBeGreaterThanOrEqual(2500);

    // 2. Incremental analysis: each segment analyzed strictly ONCE (never re-analyzing history!)
    expect(m.segmentsAnalyzedCount).toBe(15);
    expect(instA.service.continuous.counters.segmentsAnalyzed).toBe(15);

    // 3. THREE distinct highlights detected (4-6s, 26-29s, 46-49s) and ZERO false positives!
    expect(result.highlights).toHaveLength(3);
    expect(readyCallbacks).toHaveLength(3);
    expect(m.detectedCandidatesCount).toBe(3);
    expect(instA.service.continuous.counters.ffmpegClipExtractions).toBe(3);

    const [h1, h2, h3] = result.highlights;
    // Event 1: early event near stream start (4-6s), pre-event clamped at 0s
    expect(h1.candidate.eventTimestampSec).toBeGreaterThanOrEqual(3.5);
    expect(h1.candidate.eventTimestampSec).toBeLessThanOrEqual(6.5);
    expect(h1.candidate.windowStartSec).toBe(0);
    expect(h1.candidate.windowEndSec).toBeGreaterThanOrEqual(7.5);

    // Event 2: midstream loud event (26-29s) with full pre-event (6s) and post-event (4s) footage
    expect(h2.candidate.eventTimestampSec).toBeGreaterThanOrEqual(25.5);
    expect(h2.candidate.eventTimestampSec).toBeLessThanOrEqual(29.5);
    expect(h2.candidate.windowStartSec).toBeGreaterThanOrEqual(19);
    expect(h2.candidate.windowEndSec).toBeGreaterThanOrEqual(29.5);

    // Event 3: late modulated pattern event (46-49s)
    expect(h3.candidate.eventTimestampSec).toBeGreaterThanOrEqual(45.5);
    expect(h3.candidate.eventTimestampSec).toBeLessThanOrEqual(49.5);

    // 4. Detection AND clip generation happened WHILE THE STREAM WAS STILL ACTIVE!
    expect(h1.streamActiveAtDetection).toBe(true);
    expect(h1.segmentsEmittedAtDetection).toBeLessThan(15);
    expect(h1.streamActiveAtClipReady).toBe(true);
    expect(h1.segmentsEmittedAtClipReady).toBeLessThan(15);
    expect(m.clipsReadyWhileStreamActive).toBeGreaterThanOrEqual(2);
    expect(m.ingestionContinuedDuringClipRender).toBe(true);

    // 5. Long-running continuous lease heartbeat actively renewed during stream
    expect(m.heartbeatRenewals).toBeGreaterThanOrEqual(2);

    // 6. All 3 distinct highlights have unique cacheKeys, unique objectKeys, real sha256 != cacheKey, and pass ffprobe!
    expect(new Set(result.highlights.map((h) => h.cacheKey)).size).toBe(3);
    expect(new Set(result.highlights.map((h) => h.objectKey)).size).toBe(3);
    await fs.mkdir(workRootProbe, { recursive: true });

    for (let i = 0; i < result.highlights.length; i++) {
      const h = result.highlights[i];
      expect(h.clipMeta.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(h.clipMeta.sha256).not.toBe(h.cacheKey);

      const dlRes = await fetch(h.downloadUrl);
      expect(dlRes.ok).toBe(true);
      const bytes = Buffer.from(await dlRes.arrayBuffer());
      const tmpMp4 = path.join(workRootProbe, `continuous-hl-${i + 1}.mp4`);
      await fs.writeFile(tmpMp4, bytes);
      const probed = await probeAndValidateClipMp4(tmpMp4, { requireAudio: true });
      expect(probed.sizeBytes).toBe(h.clipMeta.sizeBytes);
      expect(probed.sha256).toBe(h.clipMeta.sha256);
      expect(probed.videoCodec).toBe('h264');
      expect(probed.audioCodec).toBe('aac');
      expect(probed.width).toBe(1280);
      expect(probed.height).toBe(720);
      expect(probed.durationSec).toBeGreaterThanOrEqual(6);
    }

    // 7. Bounded scratch disk & full cleanup after stream end
    expect(m.peakDiskBytes).toBeGreaterThan(0);
    expect(m.peakDiskBytes).toBeLessThan(64 * 1024 * 1024);
    const remainingEntries = await fs.readdir(workRootA).catch(() => []);
    expect(remainingEntries).toHaveLength(0);

    console.log(
      `[Step 3B.6 Measured] firstSeg->firstDetect=${m.firstSegmentToFirstDetectionMs}ms | detect->clipReady=${m.firstDetectionToClipReadyMs}ms | ingestRate=${m.segmentIngestionRatePerSec} seg/s | events=${m.detectedCandidatesCount} (0 false positives) | readyWhileLive=${m.clipsReadyWhileStreamActive}/${m.finalizedClipsCount} (h1 ready at seg ${h1.segmentsEmittedAtClipReady}/15) | peakDisk=${(m.peakDiskBytes / (1024 * 1024)).toFixed(2)}MB | peakHeap=${(m.peakHeapUsedBytes / (1024 * 1024)).toFixed(1)}MB | hbRenewals=${m.heartbeatRenewals}`,
    );
  }, 120_000);

  it('2. shares ONE continuous ingestion across 2 instances & 1,000 clippers, serves remote first_highlight while LIVE, reuses for late joiners, and separates different clip windows', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);

    const broadcastId = `live_shared_1000_${Date.now()}`;
    const makeAdapter = () =>
      new ControlledRealTimeStreamAdapter({
        fixturePath,
        policy: {
          enabled: true,
          provider: 'twitch',
          channelName: 'shared_live_1000',
          broadcastId,
          rightsStatus: 'PERMITTED_PUBLIC',
          allowSharedCacheReuse: true,
        },
        streamOptions: {
          segmentDurationSec: 4,
          segmentPaceMs: 200,
          maxQueueSize: 4,
        },
      });

    const adapter = makeAdapter();

    // Launch a remote 'first_highlight' clipper on instB slightly after stream starts to verify
    // remote clippers can receive Highlight #1 BEFORE the broadcast ends!
    const remoteEarlyPromise = new Promise<void>((r) => setTimeout(r, 120)).then(() =>
      instB.service.joinOrStartContinuousBroadcast({
        adapter,
        requesterUserId: 'remote_early_clipper',
        workerId: 'instB_remote_early',
        bufferConfig: { segmentDurationSec: 4, preEventSec: 4, postEventSec: 4, maxRetentionSec: 60 },
        scoreThreshold: 65,
        cooldownSec: 12,
        aggregationWindowSec: 3,
        waitMode: 'first_highlight',
        pollInitialMs: 40,
        pollMaxMs: 120,
      }),
    );

    // 1,000 concurrent clippers distributed across instA (500) and instB (500)!
    const t0 = Date.now();
    const allResults = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => {
        const svc = i % 2 === 0 ? instA.service : instB.service;
        return svc.joinOrStartContinuousBroadcast({
          adapter,
          requesterUserId: `live_clipper_${i}`,
          workerId: `inst${i % 2 === 0 ? 'A' : 'B'}_w_${i}`,
          bufferConfig: { segmentDurationSec: 4, preEventSec: 4, postEventSec: 4, maxRetentionSec: 60 },
          scoreThreshold: 65,
          cooldownSec: 12,
          aggregationWindowSec: 3,
          pollInitialMs: 60,
          pollMaxMs: 200,
        });
      }),
    );
    const fanInMs = Date.now() - t0;
    const remoteEarly = await remoteEarlyPromise;

    trackHighlightStorage(adapter, allResults[0].highlights);

    // Strictly ONE continuous ingestion owner across BOTH instances and all 1,000 clippers!
    const owners = allResults.filter((r) => r.wasSessionOwner);
    expect(owners).toHaveLength(1);
    expect(
      instA.service.continuous.counters.sessionOwnersStarted +
        instB.service.continuous.counters.sessionOwnersStarted,
    ).toBe(1);

    // Strictly 3 FFmpeg clip extractions total across BOTH instances (1 per distinct highlight)!
    expect(
      instA.service.continuous.counters.ffmpegClipExtractions +
        instB.service.continuous.counters.ffmpegClipExtractions,
    ).toBe(3);

    // Remote early clipper received Highlight #1 while stream was STILL LIVE!
    expect(remoteEarly.wasSessionOwner).toBe(false);
    expect(remoteEarly.highlights.length).toBeGreaterThanOrEqual(1);
    expect(remoteEarly.streamStatus).toBe('LIVE');

    // Every one of the 1,000 clippers got the exact same 3 verified highlight cacheKeys
    const expectedKeySignature = allResults[0].highlights.map((h) => h.cacheKey).join('|');
    for (const r of allResults) {
      expect(r.highlights).toHaveLength(3);
      expect(r.highlights.map((h) => h.cacheKey).join('|')).toBe(expectedKeySignature);
    }

    // Late-joining clipper after stream completion reuses cached highlights with ZERO FFmpeg renders!
    const lateJoiner = await instB.service.joinOrStartContinuousBroadcast({
      adapter,
      requesterUserId: 'late_clipper_9999',
      workerId: 'instB_late_joiner',
      bufferConfig: { segmentDurationSec: 4, preEventSec: 4, postEventSec: 4, maxRetentionSec: 60 },
      scoreThreshold: 65,
      cooldownSec: 12,
      aggregationWindowSec: 3,
    });
    expect(lateJoiner.coordinationAction).toBe('REUSE_READY');
    expect(lateJoiner.wasSessionOwner).toBe(false);
    expect(lateJoiner.highlights).toHaveLength(3);
    expect(
      instA.service.continuous.counters.ffmpegClipExtractions +
        instB.service.continuous.counters.ffmpegClipExtractions,
    ).toBe(3);

    // Different clip window (preEventSec=6, postEventSec=6) produces SEPARATE cached artifacts!
    const wideWindowAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'shared_live_1000',
        broadcastId,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4,
        segmentPaceMs: 50,
        maxSegments: 4, // fast check covering early event window
      },
    });
    const wideRes = await instB.service.joinOrStartContinuousBroadcast({
      adapter: wideWindowAdapter,
      requesterUserId: 'wide_window_user',
      workerId: 'instB_wide',
      sourceRevision: 'v1-wide',
      bufferConfig: { segmentDurationSec: 4, preEventSec: 6, postEventSec: 6, maxRetentionSec: 60 },
      scoreThreshold: 65,
      cooldownSec: 12,
      aggregationWindowSec: 3,
    });
    trackHighlightStorage(wideWindowAdapter, wideRes.highlights);
    expect(wideRes.highlights.length).toBeGreaterThanOrEqual(1);
    expect(wideRes.highlights[0].cacheKey).not.toBe(allResults[0].highlights[0].cacheKey);

    console.log(
      `[Step 3B.6 Multi-Instance] 1,000 clippers across 2 instances=${fanInMs}ms | owners=1 | totalClipRenders=3 | remoteEarlyStatus=${remoteEarly.streamStatus} | lateJoiner=${lateJoiner.coordinationAction}`,
    );
  }, 120_000);

  it('3. handles corrupt segments, missing gaps, late/out-of-order segments, and verifies buffer readiness & pinning', async () => {
    const instA = createService(workRootA);
    const adapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'kick',
        channelName: 'resilience_live',
        broadcastId: `live_faults_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4,
        segmentPaceMs: 80,
        injectCorruptAtIndex: 3, // quiet segment 12-16s is corrupt -> skipped cleanly!
        reorderSwapIndex: 5, // segment 6 arrives before segment 5 (late/out-of-order!)
        injectMissingAtIndex: 9, // quiet segment 36-40s is dropped (gap!)
      },
    });

    const res = await instA.service.joinOrStartContinuousBroadcast({
      adapter,
      requesterUserId: 'resilience_user',
      workerId: 'instA_resilience',
      bufferConfig: {
        segmentDurationSec: 4,
        preEventSec: 6, // > event 1 timestamp (4.5s) -> tests start-of-stream clamping at 0s!
        postEventSec: 4,
        maxRetentionSec: 60,
      },
      scoreThreshold: 65,
      cooldownSec: 12,
      aggregationWindowSec: 3,
    });
    trackHighlightStorage(adapter, res.highlights);

    expect(res.metrics).not.toBeNull();
    expect(res.metrics!.corruptSegmentsSkipped).toBeGreaterThanOrEqual(1);
    expect(res.metrics!.gapsDetected).toBeGreaterThanOrEqual(1);
    expect(res.metrics!.lateSegmentsReceived).toBeGreaterThanOrEqual(1);
    // All 3 valid highlight events still detected & extracted despite corrupt/missing/late quiet segments!
    expect(res.highlights).toHaveLength(3);

    // Direct readiness API unit verification on FfmpegRollingSegmentBuffer
    const buf = new FfmpegRollingSegmentBuffer({
      workDir: path.join(workRootProbe, `readiness_${Date.now()}`),
      bufferConfig: { segmentDurationSec: 4, preEventSec: 4, postEventSec: 4, maxRetentionSec: 60 },
    });
    try {
      buf.registerVerifiedSegment({
        index: 0,
        filePath: 'seg0.mp4',
        startSec: 0,
        endSec: 4,
        durationSec: 4,
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
        valid: true,
      });
      buf.registerVerifiedSegment({
        index: 1,
        filePath: 'seg1.mp4',
        startSec: 4,
        endSec: 8,
        durationSec: 4,
        sizeBytes: 1000,
        sha256: 'b'.repeat(64),
        valid: true,
      });

      // Event at 5s needs post-event up to 9s -> NOT ready yet!
      const beforePost = buf.checkCandidateWindowReadiness(5);
      expect(beforePost.preEventAvailable).toBe(true);
      expect(beforePost.postEventAvailable).toBe(false);
      expect(beforePost.canFinalize).toBe(false);

      // Pin segment 1 ONLY, leave segment 0 unpinned -> eviction drops unpinned segment 0 while keeping pinned segment 1!
      buf.pinSegments([1], 'test_lease');
      expect(buf.isPinned(1)).toBe(true);
      expect(buf.isPinned(0)).toBe(false);
      const evicted = await buf.evictExpired(500); // far past maxRetentionSec=60
      expect(evicted).toContain(0);
      expect(buf.getValidSegments().map((s) => s.index)).toEqual([1]);

      // Re-register segment 0 & add segment 2 (8-12s) -> post-event footage NOW available while stream is STILL live!
      buf.registerVerifiedSegment({
        index: 0,
        filePath: 'seg0.mp4',
        startSec: 0,
        endSec: 4,
        durationSec: 4,
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
        valid: true,
      });
      buf.registerVerifiedSegment({
        index: 2,
        filePath: 'seg2.mp4',
        startSec: 8,
        endSec: 12,
        durationSec: 4,
        sizeBytes: 1000,
        sha256: 'c'.repeat(64),
        valid: true,
      });
      const afterPost = buf.checkCandidateWindowReadiness(5);
      expect(afterPost.preEventAvailable).toBe(true);
      expect(afterPost.postEventAvailable).toBe(true);
      expect(afterPost.canFinalize).toBe(true);
      expect(afterPost.streamEnded).toBe(false);
    } finally {
      await buf.cleanupAll();
    }
  }, 120_000);

  it('4. supports graceful stream cancellation and interrupted-stream recovery reusing already-cached highlights', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);

    // 4a. Graceful cancellation stops ingestion cleanly and cleans up scratch directory
    const cancelAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'youtube',
        channelName: 'cancel_live',
        broadcastId: `yt_cancel_${Date.now().toString().slice(-6)}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4,
        segmentPaceMs: 150,
      },
    });
    const abortCtrl = new AbortController();
    let seenBeforeCancel = 0;

    await expect(
      instA.service.joinOrStartContinuousBroadcast({
        adapter: cancelAdapter,
        requesterUserId: 'cancel_user',
        workerId: 'instA_cancel',
        signal: abortCtrl.signal,
        bufferConfig: { segmentDurationSec: 4, preEventSec: 4, postEventSec: 4, maxRetentionSec: 60 },
        onSegmentArrived: ({ emittedCount }) => {
          seenBeforeCancel = emittedCount;
          if (emittedCount >= 2) {
            abortCtrl.abort();
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(seenBeforeCancel).toBeLessThan(15);

    // 4b. Interrupted stream recovery: instA crashes at segment 8 (AFTER Highlight #1 at 4-6s is cached!)
    //     instB recovers via ACQUIRED_RECOVERY, reuses Highlight #1 (0 extra render for #1!), and finishes #2 & #3!
    const recoveryBroadcastId = `live_recover_${Date.now()}`;
    const failingAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'recover_live',
        broadcastId: recoveryBroadcastId,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4,
        segmentPaceMs: 150,
        failAtSegmentIndex: 8, // interrupts at 32s, well AFTER Highlight #1 (4-6s) is finalized & cached!
      },
    });

    let highlightReadyBeforeCrash = 0;
    await expect(
      instA.service.joinOrStartContinuousBroadcast({
        adapter: failingAdapter,
        requesterUserId: 'rec_u1',
        workerId: 'instA_crash_midstream',
        bufferConfig: { segmentDurationSec: 4, preEventSec: 4, postEventSec: 4, maxRetentionSec: 60 },
        scoreThreshold: 65,
        cooldownSec: 12,
        aggregationWindowSec: 3,
        onHighlightReady: () => {
          highlightReadyBeforeCrash++;
        },
      }),
    ).rejects.toThrow(/Simulated live feed interruption at segment 8/);
    expect(highlightReadyBeforeCrash).toBeGreaterThanOrEqual(1);

    // instB recovers the interrupted broadcast on a healthy feed!
    const healthyRecoveryAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'recover_live',
        broadcastId: recoveryBroadcastId,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4,
        segmentPaceMs: 80,
      },
    });

    const recovered = await instB.service.joinOrStartContinuousBroadcast({
      adapter: healthyRecoveryAdapter,
      requesterUserId: 'rec_u2',
      workerId: 'instB_recover_owner',
      bufferConfig: { segmentDurationSec: 4, preEventSec: 4, postEventSec: 4, maxRetentionSec: 60 },
      scoreThreshold: 65,
      cooldownSec: 12,
      aggregationWindowSec: 3,
    });
    trackHighlightStorage(healthyRecoveryAdapter, recovered.highlights);

    expect(recovered.coordinationAction).toBe('ACQUIRED_RECOVERY');
    expect(recovered.fencingToken).toBe(2);
    expect(recovered.highlights).toHaveLength(3);
    // Highlight #1 was reused from MinIO cache (not re-rendered!)
    expect(recovered.highlights.some((h) => h.reusedFromCache)).toBe(true);
    expect(instB.service.continuous.counters.ffmpegClipExtractions).toBeLessThan(3);
  }, 120_000);

  it('5. denies unauthorized streams before touching Redis/MinIO and keeps private custom edits isolated', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);

    // 5a. Unauthorized / DRM-restricted broadcast fails closed BEFORE touching Redis or MinIO
    const deniedAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'drm_locked_live',
        broadcastId: `live_denied_${Date.now()}`,
        rightsStatus: 'RESTRICTED_DRM',
        allowSharedCacheReuse: true,
      },
      streamOptions: { segmentDurationSec: 4, segmentPaceMs: 50 },
    });
    const deniedSrc = deniedAdapter.buildVerifiedBroadcastSource();

    await expect(
      instA.service.joinOrStartContinuousBroadcast({
        adapter: deniedAdapter,
        requesterUserId: 'unauth_user',
        workerId: 'instA_denied',
      }),
    ).rejects.toThrow(MediaSourceError);

    expect(instA.service.continuous.counters.sessionOwnersStarted).toBe(0);
    expect(instA.service.continuous.counters.segmentsIngested).toBe(0);
    const leaked = await redis.keys(`${redisKeyPrefix}${deniedSrc.canonicalId}*`);
    expect(leaked).toHaveLength(0);

    // 5b. Private custom edits derived from the same continuous broadcast remain isolated per user
    const permittedAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'priv_live_demo',
        broadcastId: `live_priv_${Date.now()}`,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: { segmentDurationSec: 4, segmentPaceMs: 50 },
    });

    const editA = await instA.service.renderPrivateUserEdit({
      adapter: permittedAdapter,
      requesterUserId: 'clipper_A',
      ownerUserId: 'clipper_A',
      customEditHash: 'clipper_A_custom_cut',
      windowStartSec: 2,
      windowEndSec: 8,
      bufferConfig: { segmentDurationSec: 4 },
    });
    const editB = await instB.service.renderPrivateUserEdit({
      adapter: permittedAdapter,
      requesterUserId: 'clipper_B',
      ownerUserId: 'clipper_B',
      customEditHash: 'clipper_B_custom_cut',
      windowStartSec: 24,
      windowEndSec: 30,
      bufferConfig: { segmentDurationSec: 4 },
    });

    expect(editA.cacheKey).not.toBe(editB.cacheKey);
    expect(editA.downloadUrl).toContain('cache/private/clipper_A/');
    expect(editB.downloadUrl).toContain('cache/private/clipper_B/');

    const src = permittedAdapter.buildVerifiedBroadcastSource();
    createdStorageKeys.add(
      resolveAuthorizedCacheIdentity(
        createTrustedCacheAuthContext({ source: src, requesterUserId: 'clipper_A', ownerUserId: 'clipper_A' }),
        editA.descriptor,
      ).storageKey,
    );
    createdStorageKeys.add(
      resolveAuthorizedCacheIdentity(
        createTrustedCacheAuthContext({ source: src, requesterUserId: 'clipper_B', ownerUserId: 'clipper_B' }),
        editB.descriptor,
      ).storageKey,
    );

    // Cross-user access strictly denied!
    await expect(
      instB.service.requestAuthorizedCachedClipDownload({
        adapter: permittedAdapter,
        requesterUserId: 'clipper_B',
        ownerUserId: 'clipper_A',
        descriptor: editA.descriptor,
      }),
    ).rejects.toThrow(/Cross-user access/);
  }, 90_000);
});
