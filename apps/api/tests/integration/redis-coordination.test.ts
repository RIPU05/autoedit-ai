import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import {
  SharedIngestionCoordinator,
  RedisCoordinationStore,
  buildRequestIngestionLuaArgs,
  buildMutateLeaseLuaArgs,
  buildInvalidateReadyLuaArgs,
  buildSourceWorkId,
  buildAnalysisWorkId,
  buildClipWorkId,
  resolveMediaSourceFromUrl,
  MediaSourceError,
} from '../../src/media/index.js';
import { connection as redis } from '../../src/lib/redis.js';

describe('Real Local Redis Shared Ingestion Coordination Integration (Step 3B.4.2)', () => {
  const createdKeys: string[] = [];
  const keyPrefix = `autoedit:test:redis-coord:${Date.now()}:`;

  function trackKey(sourceId: string): string {
    const full = `${keyPrefix}${sourceId}`;
    createdKeys.push(full);
    return full;
  }

  beforeAll(async () => {
    // Fail clearly if real local Redis is unreachable — never silently fall back to in-memory
    const pong = await redis.ping();
    expect(pong).toBe('PONG');
  });

  afterEach(async () => {
    while (createdKeys.length > 0) {
      const k = createdKeys.pop()!;
      await redis.del(k).catch(() => {});
    }
  });

  it('1. verifies explicit positional Lua argument packers match Redis script contracts', () => {
    const reqArgs = buildRequestIngestionLuaArgs({
      canonicalSourceId: 'youtube:broadcast:GTA6Live999',
      workerId: 'worker_1',
      leaseMs: 30_000,
      maxRetries: 3,
      nowMs: 1_000,
      recordTtlMs: 60_000,
    });
    expect(reqArgs).toEqual(['youtube:broadcast:GTA6Live999', 'worker_1', 30_000, 3, 1_000, 60_000]);

    const mutArgs = buildMutateLeaseLuaArgs({
      mode: 'transition',
      workerId: 'worker_1',
      fencingToken: 1,
      nextState: 'READY',
      leaseMs: 0,
      artifactRef: 'cache/shared/ref',
      lastError: '',
      nowMs: 2_000,
      recordTtlMs: 60_000,
    });
    expect(mutArgs).toEqual(['transition', 'worker_1', 1, 'READY', 0, 'cache/shared/ref', '', 2_000, 60_000]);
  });

  it('2. coordinates 1,000 concurrent clipper requests on real Redis into 1 owner and 999 ATTACH_EXISTING', async () => {
    const sourceId = 'youtube:broadcast:GTA6Redis01' as const;
    trackKey(sourceId);

    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix,
      recordTtlMs: 60_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);

    const urlTemplates = [
      (i: number) => `https://www.youtube.com/live/GTA6Redis01?si=t${i}&utm_campaign=c${i}`,
      (i: number) => `https://m.youtube.com/live/GTA6Redis01?feature=share_${i}`,
      (i: number) => `https://youtube.com/live/GTA6Redis01?ref=clipper_${i}`,
    ];

    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => {
        const src = resolveMediaSourceFromUrl(urlTemplates[i % urlTemplates.length](i));
        return coordinator.requestIngestion({
          canonicalSourceId: src.canonicalId,
          requesterId: `redis_clipper_${i}`,
          workerId: `redis_worker_${i}`,
          leaseMs: 60_000,
          maxRetries: 3,
          nowMs: 10_000,
        });
      }),
    );

    const acquiredNew = results.filter((r) => r.action === 'ACQUIRED_NEW');
    const attachedExisting = results.filter((r) => r.action === 'ATTACH_EXISTING');

    expect(acquiredNew).toHaveLength(1);
    expect(attachedExisting).toHaveLength(999);

    const initialOwner = acquiredNew[0].record.ownerWorkerId;
    expect(initialOwner).toMatch(/^redis_worker_\d+$/);

    // Every attached request saw the exact same owner and fencingToken=1
    for (const r of attachedExisting) {
      expect(r.deduplicated).toBe(true);
      expect(r.fencingToken).toBe(1);
      expect(r.record.ownerWorkerId).toBe(initialOwner);
    }

    // Verify stored record in real Redis has exact attachedCount=1000 and stays O(1) compact
    const stored = await coordinator.getState(sourceId);
    expect(stored).not.toBeNull();
    expect(stored!.ownerWorkerId).toBe(initialOwner);
    expect(stored!.attachedCount).toBe(1000);
    expect(stored!.fencingToken).toBe(1);
    expect(JSON.stringify(stored).length).toBeLessThan(350);
  });

  it('3. verifies lease renewal, valid/invalid state transitions, and READY reuse on real Redis', async () => {
    const sourceId = 'twitch:broadcast:shroud:real_redis_42' as const;
    trackKey(sourceId);

    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix,
      recordTtlMs: 60_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);

    const first = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_1',
      workerId: 'worker_alpha',
      leaseMs: 10_000,
      maxRetries: 3,
      nowMs: 1_000,
    });
    expect(first.action).toBe('ACQUIRED_NEW');
    expect(first.record.leaseExpiresAtMs).toBe(11_000);

    // Lease renewal extends expiry
    const renewed = await coordinator.renewLease({
      canonicalSourceId: sourceId,
      workerId: 'worker_alpha',
      fencingToken: 1,
      leaseMs: 15_000,
      nowMs: 5_000,
    });
    expect(renewed.leaseExpiresAtMs).toBe(20_000);

    // Valid transition ACQUIRING -> INGESTING
    const ingesting = await coordinator.markIngesting({
      canonicalSourceId: sourceId,
      workerId: 'worker_alpha',
      fencingToken: 1,
      nowMs: 6_000,
    });
    expect(ingesting.state).toBe('INGESTING');

    // Invalid READY with empty artifactRef rejected by Lua script
    await expect(
      coordinator.markReady({
        canonicalSourceId: sourceId,
        workerId: 'worker_alpha',
        fencingToken: 1,
        artifactRef: '',
        nowMs: 7_000,
      }),
    ).rejects.toThrow(MediaSourceError);

    // Valid transition INGESTING -> READY with artifactRef
    const ready = await coordinator.markReady({
      canonicalSourceId: sourceId,
      workerId: 'worker_alpha',
      fencingToken: 1,
      artifactRef: 'cache/shared/source_media/real_redis_ok',
      nowMs: 8_000,
    });
    expect(ready.state).toBe('READY');
    expect(ready.artifactRef).toBe('cache/shared/source_media/real_redis_ok');
    expect(ready.ownerWorkerId).toBeNull();

    // Subsequent clipper gets REUSE_READY with valid artifactRef
    const reused = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_2',
      workerId: 'worker_beta',
      nowMs: 9_000,
    });
    expect(reused.action).toBe('REUSE_READY');
    expect(reused.deduplicated).toBe(true);
    expect(reused.record.artifactRef).toBe('cache/shared/source_media/real_redis_ok');

    // READY artifact cannot be mutated or released
    await expect(
      coordinator.markFailed({
        canonicalSourceId: sourceId,
        workerId: 'worker_alpha',
        fencingToken: 1,
        error: 'late fail',
        nowMs: 9_500,
      }),
    ).rejects.toThrow(/Invalid state transition/);
    expect(
      await coordinator.releaseLease({
        canonicalSourceId: sourceId,
        workerId: 'worker_alpha',
        fencingToken: 1,
        nowMs: 9_500,
      }),
    ).toBe(false);
  });

  it('4. verifies stale worker fencing after lease expiry, crash recovery, and bounded retries on real Redis', async () => {
    const sourceId = 'kick:broadcast:xqc:real_redis_recovery' as const;
    trackKey(sourceId);

    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix,
      recordTtlMs: 60_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);

    // Attempt 1: worker_dead acquires lease
    const r1 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c1',
      workerId: 'worker_dead',
      leaseMs: 5_000,
      maxRetries: 2,
      nowMs: 1_000,
    });
    expect(r1.action).toBe('ACQUIRED_NEW');
    expect(r1.fencingToken).toBe(1);

    // Lease expires at t=6_000 -> worker_recovery takes over at t=10_000 (attempt 2, token 2)
    const r2 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c2',
      workerId: 'worker_recovery',
      leaseMs: 5_000,
      maxRetries: 2,
      nowMs: 10_000,
    });
    expect(r2.action).toBe('ACQUIRED_RECOVERY');
    expect(r2.fencingToken).toBe(2);
    expect(r2.record.ownerWorkerId).toBe('worker_recovery');
    expect(r2.record.attempts).toBe(2);

    // Stale worker_dead with token 1 is fenced off on renew and transition
    await expect(
      coordinator.renewLease({
        canonicalSourceId: sourceId,
        workerId: 'worker_dead',
        fencingToken: 1,
        leaseMs: 5_000,
        nowMs: 11_000,
      }),
    ).rejects.toThrow(/Cannot renew lease/);
    await expect(
      coordinator.markReady({
        canonicalSourceId: sourceId,
        workerId: 'worker_dead',
        fencingToken: 1,
        artifactRef: 'cache/shared/corrupt',
        nowMs: 11_000,
      }),
    ).rejects.toThrow(/lost lease/);

    // Attempt 2 fails -> attempt 3 hits maxRetries=2 -> FAILED_MAX_RETRIES
    await coordinator.markFailed({
      canonicalSourceId: sourceId,
      workerId: 'worker_recovery',
      fencingToken: 2,
      error: 'upstream error',
      nowMs: 12_000,
    });

    const r3 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c3',
      workerId: 'worker_3',
      leaseMs: 5_000,
      maxRetries: 2,
      nowMs: 13_000,
    });
    expect(r3.action).toBe('FAILED_MAX_RETRIES');
    expect(r3.record.state).toBe('FAILED');
  });

  it('5. verifies Redis key TTL expiration resets coordination cleanly', async () => {
    const sourceId = 'twitch:vod:9988776655' as const;
    trackKey(sourceId);

    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix,
      recordTtlMs: 250,
    });
    const coordinator = new SharedIngestionCoordinator(store);

    const first = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c1',
      workerId: 'w1',
      leaseMs: 5_000,
      nowMs: 1_000,
    });
    expect(first.action).toBe('ACQUIRED_NEW');
    expect(first.fencingToken).toBe(1);

    await new Promise((r) => setTimeout(r, 350));

    expect(await coordinator.getState(sourceId)).toBeNull();

    const afterExpiry = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c2',
      workerId: 'w2',
      leaseMs: 5_000,
      nowMs: 10_000,
    });
    expect(afterExpiry.action).toBe('ACQUIRED_NEW');
    expect(afterExpiry.fencingToken).toBe(1);
    expect(afterExpiry.record.ownerWorkerId).toBe('w2');
  });

  it('6. verifies conditional invalidateReadyArtifact fencing & scoped work IDs on real Redis (Step 3B.5.1)', async () => {
    const baseSource = 'twitch:broadcast:shroud:repair_demo_1' as const;
    const srcWork = buildSourceWorkId(baseSource, 'v1');
    const anaWork = buildAnalysisWorkId(baseSource, {
      sourceRevision: 'v1',
      algorithmVersion: 'v1.0-heuristic',
      scoreThreshold: 65,
      cooldownSec: 15,
    });
    const clipWorkA = buildClipWorkId(baseSource, 'aaaa1111222233334444555566667777');
    const clipWorkB = buildClipWorkId(baseSource, 'bbbb1111222233334444555566667777');
    expect(new Set([srcWork, anaWork, clipWorkA, clipWorkB]).size).toBe(4);

    // Channel-only IDs remain rejected by scoped work ID builders
    expect(() => buildSourceWorkId('twitch:channel:shroud', 'v1')).toThrow(MediaSourceError);

    const invArgs = buildInvalidateReadyLuaArgs({
      expectedArtifactRef: 'cache/shared/clip/v/gen-1.mp4',
      expectedFencingToken: 1,
      repairWorkerId: 'repair_1',
      leaseMs: 10_000,
      maxRetries: 3,
      nowMs: 5_000,
      recordTtlMs: 60_000,
    });
    expect(invArgs).toEqual([
      'cache/shared/clip/v/gen-1.mp4',
      1,
      'repair_1',
      10_000,
      3,
      5_000,
      60_000,
    ]);

    trackKey(clipWorkA);
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix,
      recordTtlMs: 60_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);

    const acq = await coordinator.requestIngestion({
      canonicalSourceId: clipWorkA,
      requesterId: 'c1',
      workerId: 'w1',
      leaseMs: 10_000,
      nowMs: 1_000,
    });
    expect(acq.fencingToken).toBe(1);
    await coordinator.markReady({
      canonicalSourceId: clipWorkA,
      workerId: 'w1',
      fencingToken: 1,
      artifactRef: 'cache/shared/clip/v/gen-1.mp4',
      nowMs: 2_000,
    });

    // Wrong expectedFencingToken or wrong expectedArtifactRef is rejected without mutation
    const mismatchRef = await coordinator.invalidateReadyArtifact({
      canonicalSourceId: clipWorkA,
      expectedArtifactRef: 'cache/shared/clip/v/WRONG.mp4',
      expectedFencingToken: 1,
      repairWorkerId: 'repair_wrong',
      leaseMs: 10_000,
      nowMs: 3_000,
    });
    expect(mismatchRef.action).toBe('CONFLICT_ALREADY_RECOVERING');

    const mismatchToken = await coordinator.invalidateReadyArtifact({
      canonicalSourceId: clipWorkA,
      expectedArtifactRef: 'cache/shared/clip/v/gen-1.mp4',
      expectedFencingToken: 99,
      repairWorkerId: 'repair_wrong_tok',
      leaseMs: 10_000,
      nowMs: 3_000,
    });
    expect(mismatchToken.action).toBe('CONFLICT_ALREADY_RECOVERING');

    // 50 concurrent repair workers race to invalidate missing artifact -> STRICTLY 1 wins!
    const race = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        coordinator.invalidateReadyArtifact({
          canonicalSourceId: clipWorkA,
          expectedArtifactRef: 'cache/shared/clip/v/gen-1.mp4',
          expectedFencingToken: 1,
          repairWorkerId: `repair_worker_${i}`,
          leaseMs: 10_000,
          nowMs: 4_000,
        }),
      ),
    );

    const winners = race.filter((r) => r.action === 'ACQUIRED_REPAIR');
    const losers = race.filter((r) => r.action === 'CONFLICT_ALREADY_RECOVERING');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(49);
    expect(winners[0].fencingToken).toBe(2);
    expect(winners[0].record?.state).toBe('ACQUIRING');
    expect(winners[0].record?.ownerWorkerId).toMatch(/^repair_worker_\d+$/);
  });
});
