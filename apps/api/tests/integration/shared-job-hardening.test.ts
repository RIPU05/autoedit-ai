import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { MediaProcessJobPayload, CacheableSourceId } from '@autoedit/contracts';
import {
  ensureControlledLiveFixture,
  ControlledVodAcquisitionAdapter,
  ControlledRealTimeStreamAdapter,
  probeAndValidateClipMp4,
  UniversalMediaApiService,
  SharedWorkCoordinator,
  SharedWorkRedisLock,
  generateWorkOwnerToken,
  registerControlledTestFixture,
  clearControlledTestFixtures,
} from '../../src/media/index.js';
import { createMediaWorker } from '../../src/queue/workers/media.worker.js';
import { bullConnection, connection as redis } from '../../src/lib/redis.js';
import { createStorageProvider, type MediaStorageProvider } from '../../src/storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const RAW_LOCAL_DB_URL =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('autoedit_test')
    ? process.env.DATABASE_URL
    : 'postgresql://autoedit:autoedit_local_pass@127.0.0.1:5432/autoedit_local?schema=public';
const BASE_LOCAL_DB_URL = RAW_LOCAL_DB_URL.replace('@localhost:', '@127.0.0.1:');
const LOCAL_DB_URL = BASE_LOCAL_DB_URL.includes('connection_limit=')
  ? BASE_LOCAL_DB_URL
  : `${BASE_LOCAL_DB_URL}${BASE_LOCAL_DB_URL.includes('?') ? '&' : '?'}connection_limit=5&pool_timeout=30`;

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ChildEvent {
  event: string;
  workerLabel?: string;
  pid?: number;
  generation?: number;
  ownerToken?: string;
  sharedWorkKey?: string;
}

function spawnWorkerChildProcess(envVars: Record<string, string>): {
  proc: ChildProcess;
  waitForEvent: (eventName: string, timeoutMs?: number) => Promise<ChildEvent>;
  killNow: () => Promise<void>;
} {
  const apiDir = path.resolve(__dirname, '../..');
  const scriptPath = path.resolve(__dirname, 'helpers/media-worker-child.ts');
  const tsxCli = path.resolve(apiDir, 'node_modules/tsx/dist/cli.mjs');

  const proc = spawn(process.execPath, [tsxCli, scriptPath], {
    cwd: apiDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ALLOW_CONTROLLED_MEDIA_FIXTURES: 'true',
      ...envVars,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const events: ChildEvent[] = [];
  const waiters: Array<{ eventName: string; resolve: (ev: ChildEvent) => void }> = [];
  let buf = '';
  let stderrBuf = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line) as ChildEvent;
          events.push(parsed);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].eventName === parsed.event) {
              const w = waiters.splice(i, 1)[0];
              w.resolve(parsed);
            }
          }
        } catch {
          // ignore non-JSON log lines
        }
      }
      nl = buf.indexOf('\n');
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const waitForEvent = (eventName: string, timeoutMs = 30_000): Promise<ChildEvent> => {
    const existing = events.find((e) => e.event === eventName);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for child worker event "${eventName}". stderr=${stderrBuf.slice(-400)}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        eventName,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev);
        },
      });
    });
  };

  const killNow = async () => {
    if (proc.exitCode === null && !proc.killed) {
      proc.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3_000);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };

  return { proc, waitForEvent, killNow };
}

describe('Step 3B.9.1: Distributed Job Reliability, Deduplication & Recovery Hardening', () => {
  const db = new PrismaClient({
    datasources: { db: { url: LOCAL_DB_URL } },
  });
  const dbApiA = new PrismaClient({
    datasources: { db: { url: LOCAL_DB_URL } },
  });
  const dbApiB = new PrismaClient({
    datasources: { db: { url: LOCAL_DB_URL } },
  });
  const dbWorker = new PrismaClient({
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
  const mainQueueName = `media-hardening-${runTag}`;
  const osQueueName = `media-hardening-os-${runTag}`;
  const keyPrefix = `autoedit:test:step3b91:${runTag}:`;
  const fixture30sPath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
  const workRootA = path.resolve(process.cwd(), 'tmp', `step3b91-apiA-${runTag}`);
  const workRootB = path.resolve(process.cwd(), 'tmp', `step3b91-apiB-${runTag}`);
  const workRootWorker = path.resolve(process.cwd(), 'tmp', `step3b91-worker-${runTag}`);
  const workRootChild = path.resolve(process.cwd(), 'tmp', `step3b91-child-${runTag}`);
  const workRootProbe = path.resolve(process.cwd(), 'tmp', `step3b91-probe-${runTag}`);

  const createdUserIds = new Set<string>();
  const createdSourceCanonicalIds = new Set<string>();
  const createdStorageKeys = new Set<string>();
  const spawnedChildren: Array<{ killNow: () => Promise<void> }> = [];

  let mainQueue: Queue<MediaProcessJobPayload>;
  let osQueue: Queue<MediaProcessJobPayload>;
  let workerHandle: ReturnType<typeof createMediaWorker>;
  let apiA: UniversalMediaApiService;
  let apiB: UniversalMediaApiService;

  const enqueuedByWorkKey = new Map<string, number>();
  const claimsByWorkKey = new Map<string, number>();

  /** Reconciles stranded outbox rows using a dedicated future clock WITHOUT perturbing the live worker's wall clock! */
  async function reconcileAtFuture(
    offsetMs: number,
    enqueueFn: (payload: MediaProcessJobPayload, opts: { jobId: string }) => Promise<{ id?: string }> = enqueueToMainQueue,
  ) {
    const reconciler = new SharedWorkCoordinator(dbApiB, redis as any, {
      keyPrefix,
      now: () => new Date(Date.now() + offsetMs),
    });
    return reconciler.reconcileStrandedWork({ enqueueFn, batchSize: 20 });
  }

  async function createTestUser(suffix: string) {
    const user = await db.user.create({
      data: {
        email: `step3b91_${runTag}_${suffix}@local.test`,
        name: `Hardening User ${suffix}`,
      },
    });
    createdUserIds.add(user.id);
    return user;
  }

  async function grantSharedRights(canonicalSourceId: string) {
    await apiA.registry.grantSourceRights({
      canonicalSourceId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      rightsStatus: 'PERMITTED_PUBLIC',
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b91',
    });
  }

  async function waitForUserJobTerminal(
    svc: UniversalMediaApiService,
    userId: string,
    jobId: string,
    timeoutMs = 60_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await svc.getUserJobStatus(userId, jobId);
      if (['READY', 'FAILED', 'CANCELLED'].includes(status.status)) {
        return status;
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for job ${jobId} to reach terminal status`);
  }

  async function enqueueToMainQueue(payload: MediaProcessJobPayload, opts?: { jobId?: string }) {
    enqueuedByWorkKey.set(
      payload.sharedWorkKey,
      (enqueuedByWorkKey.get(payload.sharedWorkKey) ?? 0) + 1,
    );
    const jobId =
      opts?.jobId ??
      `${payload.sharedWorkKey.replace(/[^a-zA-Z0-9_-]/g, '_')}__g${payload.generation ?? 1}`;
    const j = await mainQueue.add('process-media', payload, {
      jobId,
      attempts: 3,
      backoff: { type: 'fixed', delay: 350 },
    });
    return { id: j.id };
  }

  beforeAll(async () => {
    expect(await redis.ping()).toBe('PONG');
    expect((await storage.checkHealth()).ok).toBe(true);
    await db.$queryRaw`SELECT 1`;

    await ensureControlledLiveFixture(fixture30sPath, {
      durationSec: 30,
      spikeStartSec: 16,
      spikeEndSec: 19,
    });

    mainQueue = new Queue<MediaProcessJobPayload>(mainQueueName, {
      connection: bullConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 350 },
        removeOnComplete: 500,
        removeOnFail: 200,
      },
    });
    osQueue = new Queue<MediaProcessJobPayload>(osQueueName, {
      connection: bullConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 300 },
        removeOnComplete: 500,
        removeOnFail: 200,
      },
    });

    // Two independent API service instances with separate Prisma connection pools sharing PostgreSQL, Redis, MinIO, and BullMQ
    apiA = new UniversalMediaApiService({
      db: dbApiA,
      storage,
      redis: redis as any,
      workRootDir: workRootA,
      keyPrefix,
      leaseMs: 1_800,
      quotas: {
        maxActiveJobsPerUser: 20,
        maxDailyJobSubmissionsPerUser: 500,
        downloadUrlTtlSec: 300,
        maxClipsPerUserPerDay: 100,
      },
      enqueueJob: enqueueToMainQueue,
    });

    apiB = new UniversalMediaApiService({
      db: dbApiB,
      storage,
      redis: redis as any,
      workRootDir: workRootB,
      keyPrefix,
      leaseMs: 1_800,
      quotas: {
        maxActiveJobsPerUser: 20,
        maxDailyJobSubmissionsPerUser: 500,
        downloadUrlTtlSec: 300,
        maxClipsPerUserPerDay: 100,
      },
      enqueueJob: enqueueToMainQueue,
    });

    workerHandle = createMediaWorker({
      queueName: mainQueueName,
      db: dbWorker,
      storage,
      redis: redis as any,
      bullConnection,
      workRootDir: workRootWorker,
      keyPrefix,
      concurrency: 2,
      leaseMs: 1_800, // Short 1.8s lease with 600ms heartbeat to exercise real renewal & long-run durability!
      reconcileIntervalMs: 0,
      enqueueRecoveryJob: enqueueToMainQueue,
      onClaimed: (ctx) => {
        claimsByWorkKey.set(ctx.sharedWorkKey, (claimsByWorkKey.get(ctx.sharedWorkKey) ?? 0) + 1);
      },
    });
    await workerHandle.worker.waitUntilReady();
  }, 90_000);

  afterAll(async () => {
    clearControlledTestFixtures();
    for (const c of spawnedChildren) {
      await c.killNow().catch(() => {});
    }
    if (workerHandle) await workerHandle.worker.close(true).catch(() => {});
    if (mainQueue) {
      await mainQueue.obliterate({ force: true }).catch(() => {});
      await mainQueue.close().catch(() => {});
    }
    if (osQueue) {
      await osQueue.obliterate({ force: true }).catch(() => {});
      await osQueue.close().catch(() => {});
    }
    if (createdSourceCanonicalIds.size > 0) {
      const sources = await db.mediaSource.findMany({
        where: { canonicalId: { in: [...createdSourceCanonicalIds] } },
        include: { artifacts: { include: { attempts: true } } },
      });
      for (const s of sources) {
        for (const a of s.artifacts) {
          if (a.publishedObjectKey) createdStorageKeys.add(a.publishedObjectKey);
          for (const att of a.attempts) {
            if (att.objectKey) createdStorageKeys.add(att.objectKey);
          }
        }
      }
      await db.mediaSource.deleteMany({
        where: { canonicalId: { in: [...createdSourceCanonicalIds] } },
      });
    }
    if (createdUserIds.size > 0) {
      await db.mediaProcessingJob.deleteMany({
        where: { userId: { in: [...createdUserIds] } },
      });
      await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
    }
    const rKeys = await redis.keys(`${keyPrefix}*`);
    if (rKeys.length > 0) await redis.del(...rKeys).catch(() => {});
    for (const key of createdStorageKeys) {
      await storage.deleteObject({ key }).catch(() => {});
    }
    await Promise.all([
      fs.rm(workRootA, { recursive: true, force: true }).catch(() => {}),
      fs.rm(workRootB, { recursive: true, force: true }).catch(() => {}),
      fs.rm(workRootWorker, { recursive: true, force: true }).catch(() => {}),
      fs.rm(workRootChild, { recursive: true, force: true }).catch(() => {}),
      fs.rm(workRootProbe, { recursive: true, force: true }).catch(() => {}),
    ]);
    await Promise.allSettled([
      dbApiA.$disconnect(),
      dbApiB.$disconnect(),
      dbWorker.$disconnect(),
      db.$disconnect(),
    ]);
  }, 60_000);

  it('1 (Scenarios 4 & 5): enforces atomic owner-tokenized Redis lock acquire, renew, verify, expiry, and prevents an old worker from deleting a newer worker’s lock', async () => {
    const lock = new SharedWorkRedisLock(redis as any, `${keyPrefix}locktest:`);
    const workKey = `mwk_lock_${runTag}`;
    const oldToken = generateWorkOwnerToken('worker_old', 1);
    const newToken = generateWorkOwnerToken('worker_new', 2);

    // 1. Old worker acquires short 600ms lock
    const acq1 = await lock.acquire({ sharedWorkKey: workKey, token: oldToken, ttlMs: 600 });
    expect(acq1.acquired).toBe(true);
    expect(acq1.ownerToken).toBe(oldToken);

    // 2. New worker cannot steal active lock
    const acqFail = await lock.acquire({ sharedWorkKey: workKey, token: newToken, ttlMs: 1500 });
    expect(acqFail.acquired).toBe(false);
    expect(acqFail.ownerToken).toBe(oldToken);

    // 3. Old worker verifies & renews successfully
    expect((await lock.verifyOwner({ sharedWorkKey: workKey, token: oldToken })).isOwner).toBe(true);
    expect(await lock.renew({ sharedWorkKey: workKey, token: oldToken, ttlMs: 600 })).toBe(true);
    expect(await lock.renew({ sharedWorkKey: workKey, token: newToken, ttlMs: 1500 })).toBe(false);

    // 4. Wait for old worker's lock to expire naturally (simulating stalled worker past TTL)
    await sleep(750);
    expect((await lock.verifyOwner({ sharedWorkKey: workKey, token: oldToken })).isOwner).toBe(false);

    // 5. Newer worker legitimately acquires lock with newToken
    const acq2 = await lock.acquire({ sharedWorkKey: workKey, token: newToken, ttlMs: 5000 });
    expect(acq2.acquired).toBe(true);

    // 6. CRITICAL: Old worker wakes up and calls release(oldToken) -> MUST FAIL SAFELY & NOT DELETE newToken!
    const oldReleased = await lock.release({ sharedWorkKey: workKey, token: oldToken });
    expect(oldReleased).toBe(false);
    expect(await lock.getCurrentOwnerToken(workKey)).toBe(newToken);
    expect((await lock.verifyOwner({ sharedWorkKey: workKey, token: newToken })).isOwner).toBe(true);

    // 7. Only legitimate owner can release its own lock
    expect(await lock.release({ sharedWorkKey: workKey, token: newToken })).toBe(true);
    expect(await lock.getCurrentOwnerToken(workKey)).toBeNull();
  }, 20_000);

  it('2 (Scenarios 3, 5, 6, 16): keeps long-running work alive past lease TTL via continuous renewal, survives Redis lock deletion without duplicate processing, and rejects stale generation publishes', async () => {
    const user1 = await createTestUser('long_u1');
    const user2 = await createTestUser('long_u2');

    const vodId = `vod_long_${runTag}`;
    const adapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId,
      fixturePath: fixture30sPath,
      title: 'Long Running Lease Renewal VOD',
    });
    const reg = adapter.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(reg.canonicalId);
    await apiA.registry.registerOrGetMediaSource(reg);
    await grantSharedRights(reg.canonicalId);

    const fixtureKey = `fix_long_${runTag}`;
    let processingRuns = 0;
    let enteredProcessing!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      enteredProcessing = r;
    });
    let releaseLongWork!: () => void;
    const longWorkGate = new Promise<void>((r) => {
      releaseLongWork = r;
    });

    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey,
      canonicalSourceId: reg.canonicalId,
      adapter,
      onWorkerAttempt: async () => {
        processingRuns++;
        enteredProcessing();
        await longWorkGate;
      },
    });

    const sub1 = await apiA.submitMediaJob(user1.id, {
      input: { inputType: 'controlled_fixture', fixtureKey },
      idempotencyKey: `long_u1_${runTag}`,
    });
    await enteredPromise;

    const workBefore = await db.sharedMediaWork.findUniqueOrThrow({
      where: { sharedWorkKey: sub1.sharedWorkKey },
    });
    expect(workBefore.status).toBe('RUNNING');
    const initialExpiry = workBefore.leaseExpiresAt!.getTime();
    const activeToken = workBefore.ownerToken!;

    // Wait 2.4x the 1,500ms lease TTL (3,600ms) -> proves continuous lease renewal prevents expiry!
    // Mid-way, DELETE the Redis lock key completely to simulate Redis eviction / restart!
    await sleep(1_200);
    await redis.del(apiA.sharedWork.lock.lockKey(sub1.sharedWorkKey));
    expect(await apiA.sharedWork.lock.getCurrentOwnerToken(sub1.sharedWorkKey)).toBeNull();

    // Even with Redis lock deleted, another worker attempting to claim gets ALREADY_OWNED_BY_ACTIVE_WORKER!
    const dupClaim = await apiB.sharedWork.claimWorkExecution({
      sharedWorkKey: sub1.sharedWorkKey,
      payloadGeneration: workBefore.generation,
      workerId: 'intruder_worker_after_redis_wipe',
      leaseMs: 1_500,
    });
    expect(dupClaim.action).toBe('ALREADY_OWNED_BY_ACTIVE_WORKER');

    // Second user arriving via independent API instance B attaches cleanly with 0 duplicate enqueue!
    const enqBeforeU2 = enqueuedByWorkKey.get(sub1.sharedWorkKey) ?? 0;
    const sub2 = await apiB.submitMediaJob(user2.id, {
      input: { inputType: 'controlled_fixture', fixtureKey },
      idempotencyKey: `long_u2_${runTag}`,
    });
    expect(sub2.sharedWorkKey).toBe(sub1.sharedWorkKey);
    expect(enqueuedByWorkKey.get(sub1.sharedWorkKey)).toBe(enqBeforeU2);

    // Wait past 3.6s total (>2.4x original lease TTL) -> heartbeat renewed both Postgres lease AND Redis lock!
    await sleep(2_400);
    const workRenewed = await db.sharedMediaWork.findUniqueOrThrow({
      where: { sharedWorkKey: sub1.sharedWorkKey },
    });
    expect(workRenewed.status).toBe('RUNNING');
    expect(workRenewed.leaseExpiresAt!.getTime()).toBeGreaterThan(initialExpiry + 1_500);
    expect(await apiA.sharedWork.lock.getCurrentOwnerToken(sub1.sharedWorkKey)).toBe(activeToken);

    // Stale generation / wrong ownerToken CANNOT update progress or commit terminal READY!
    await expect(
      apiA.sharedWork.publishProgressFenced({
        sharedWorkKey: sub1.sharedWorkKey,
        generation: workBefore.generation,
        ownerToken: 'stale_wrong_token',
        stage: 'forged_stage',
        progressPercent: 99,
      }),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });

    await expect(
      apiA.sharedWork.commitWorkReady({
        sharedWorkKey: sub1.sharedWorkKey,
        generation: workBefore.generation - 1,
        ownerToken: activeToken,
        resultSummary: { forged: true },
      }),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });

    // Release long work -> completes cleanly with strictly 1 owner & 1 FFmpeg execution!
    releaseLongWork();

    const [done1, done2] = await Promise.all([
      waitForUserJobTerminal(apiA, user1.id, sub1.job.jobId),
      waitForUserJobTerminal(apiB, user2.id, sub2.job.jobId),
    ]);
    expect(done1.status).toBe('READY');
    expect(done2.status).toBe('READY');
    expect(processingRuns).toBe(1);
    expect(claimsByWorkKey.get(sub1.sharedWorkKey)).toBe(1);
  }, 60_000);

  it('3 (Scenarios 7, 8, 17): recovers safely from API crash after DB insert before enqueue and from transient enqueue failure with zero stranded jobs', async () => {
    const userCrash = await createTestUser('crash_enq');
    const userFail = await createTestUser('fail_enq');

    // Part A: API crashes after DB commit BEFORE BullMQ enqueue (skipImmediateEnqueue: true)
    const vodCrash = `vod_apicrash_${runTag}`;
    const adapterCrash = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodCrash,
      fixturePath: fixture30sPath,
      title: 'API Crash Before Enqueue VOD',
    });
    const regCrash = adapterCrash.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regCrash.canonicalId);
    await apiA.registry.registerOrGetMediaSource(regCrash);
    await grantSharedRights(regCrash.canonicalId);

    const fixCrash = `fix_apicrash_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixCrash,
      canonicalSourceId: regCrash.canonicalId,
      adapter: adapterCrash,
    });

    const crashingApi = new UniversalMediaApiService({
      db,
      storage,
      redis: redis as any,
      workRootDir: workRootA,
      keyPrefix,
      skipImmediateEnqueue: true, // Persists MediaProcessingJob + SharedMediaWork(PENDING_ENQUEUE) then simulates crash!
      enqueueJob: enqueueToMainQueue,
    });

    const strandedSub = await crashingApi.submitMediaJob(userCrash.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixCrash },
      idempotencyKey: `apicrash_${runTag}`,
    });
    expect(strandedSub.httpStatus).toBe(202);

    const strandedWork = await db.sharedMediaWork.findUniqueOrThrow({
      where: { sharedWorkKey: strandedSub.sharedWorkKey },
    });
    expect(strandedWork.status).toBe('PENDING_ENQUEUE');
    expect(strandedWork.bullJobId).toBeNull();
    expect(enqueuedByWorkKey.get(strandedSub.sharedWorkKey) ?? 0).toBe(0);

    // Run bounded reconciler past the 5s dispatch lease (without perturbing worker wall clock!)
    const rec = await reconcileAtFuture(6_000);
    expect(rec.requeuedPendingCount).toBeGreaterThanOrEqual(1);

    const recoveredDone = await waitForUserJobTerminal(apiB, userCrash.id, strandedSub.job.jobId);
    expect(recoveredDone.status).toBe('READY');
    expect(enqueuedByWorkKey.get(strandedSub.sharedWorkKey)).toBe(1);

    // Part B: Transient enqueue failure (BullMQ/Redis error on attempt 1) -> backoff & recovery!
    const vodFail = `vod_enqfail_${runTag}`;
    const adapterFail = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodFail,
      fixturePath: fixture30sPath,
      title: 'Transient Enqueue Outage VOD',
    });
    const regFail = adapterFail.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regFail.canonicalId);
    await apiA.registry.registerOrGetMediaSource(regFail);
    await grantSharedRights(regFail.canonicalId);

    const fixFail = `fix_enqfail_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixFail,
      canonicalSourceId: regFail.canonicalId,
      adapter: adapterFail,
    });

    let failOnce = true;
    const flakyApi = new UniversalMediaApiService({
      db,
      storage,
      redis: redis as any,
      workRootDir: workRootA,
      keyPrefix,
      enqueueJob: async (payload, opts) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('Simulated transient BullMQ/Redis outage during enqueue');
        }
        return enqueueToMainQueue(payload, opts);
      },
    });

    const flakySub = await flakyApi.submitMediaJob(userFail.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixFail },
      idempotencyKey: `enqfail_${runTag}`,
    });
    expect(flakySub.httpStatus).toBe(202);

    const afterFailWork = await db.sharedMediaWork.findUniqueOrThrow({
      where: { sharedWorkKey: flakySub.sharedWorkKey },
    });
    expect(afterFailWork.status).toBe('PENDING_ENQUEUE');
    expect(afterFailWork.enqueueAttempts).toBe(1);
    expect(afterFailWork.nextEnqueueAt).not.toBeNull();

    // Reconcile past backoff using dedicated future clock -> succeeds cleanly!
    const rec2 = await reconcileAtFuture(2_000);
    expect(rec2.requeuedPendingCount).toBeGreaterThanOrEqual(1);

    const doneFailRecovered = await waitForUserJobTerminal(
      flakyApi,
      userFail.id,
      flakySub.job.jobId,
    );
    expect(doneFailRecovered.status).toBe('READY');
    expect(enqueuedByWorkKey.get(flakySub.sharedWorkKey)).toBe(1);
  }, 60_000);

  it('4 (Scenarios 9, 10, 17): recovers cleanly across TWO SEPARATE WORKER OS PROCESSES after real SIGKILL worker process crash', async () => {
    const user = await createTestUser('os_crash');
    const vodId = `vod_oscrash_${runTag}`;
    const adapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId,
      fixturePath: fixture30sPath,
      title: 'Two OS Worker Process Crash Recovery VOD',
    });
    const reg = adapter.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(reg.canonicalId);
    await apiA.registry.registerOrGetMediaSource(reg);
    await grantSharedRights(reg.canonicalId);

    const fixKey = `fix_oscrash_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixKey,
      canonicalSourceId: reg.canonicalId,
      adapter,
    });

    // Dedicated API instance pointing at osQueue
    const osApi = new UniversalMediaApiService({
      db,
      storage,
      redis: redis as any,
      workRootDir: workRootA,
      keyPrefix: `${keyPrefix}os:`,
      leaseMs: 1_500,
      enqueueJob: async (payload, opts) => {
        const jobId =
          opts?.jobId ??
          `${payload.sharedWorkKey.replace(/[^a-zA-Z0-9_-]/g, '_')}__g${payload.generation ?? 1}`;
        const j = await osQueue.add('process-media', payload, {
          jobId,
          attempts: 3,
          backoff: { type: 'fixed', delay: 300 },
        });
        return { id: j.id };
      },
    });

    // Spawn Worker OS Process #1 (will claim gen 1 and stall so we can SIGKILL it mid-flight!)
    const worker1 = spawnWorkerChildProcess({
      CHILD_QUEUE_NAME: osQueueName,
      CHILD_KEY_PREFIX: `${keyPrefix}os:`,
      CHILD_FIXTURE_KEY: fixKey,
      CHILD_VOD_ID: vodId,
      CHILD_FIXTURE_PATH: fixture30sPath,
      CHILD_WORK_ROOT: path.join(workRootChild, 'w1'),
      CHILD_WORKER_LABEL: 'os_worker_1',
      CHILD_LEASE_MS: '1500',
      CHILD_STALL_MS: '60000',
    });
    spawnedChildren.push(worker1);
    const w1Ready = await worker1.waitForEvent('READY', 30_000);
    expect(w1Ready.pid).toBeGreaterThan(0);

    // Submit job -> Worker OS Process #1 claims generation 1!
    const sub = await osApi.submitMediaJob(user.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixKey },
      idempotencyKey: `oscrash_${runTag}`,
    });
    const claimed1 = await worker1.waitForEvent('CLAIMED', 30_000);
    expect(claimed1.generation).toBe(1);
    expect(claimed1.pid).toBe(w1Ready.pid);
    await worker1.waitForEvent('STALLING', 15_000);

    // ABRUPT OS CRASH: kill Worker #1 with SIGKILL (no finally block runs, Redis lock & DB lease remain dirty!)
    await worker1.killNow();

    // Spawn Worker OS Process #2 (completely separate OS PID!)
    const worker2 = spawnWorkerChildProcess({
      CHILD_QUEUE_NAME: osQueueName,
      CHILD_KEY_PREFIX: `${keyPrefix}os:`,
      CHILD_FIXTURE_KEY: fixKey,
      CHILD_VOD_ID: vodId,
      CHILD_FIXTURE_PATH: fixture30sPath,
      CHILD_WORK_ROOT: path.join(workRootChild, 'w2'),
      CHILD_WORKER_LABEL: 'os_worker_2',
      CHILD_LEASE_MS: '5000',
      CHILD_STALL_MS: '0',
    });
    spawnedChildren.push(worker2);
    const w2Ready = await worker2.waitForEvent('READY', 30_000);
    expect(w2Ready.pid).toBeGreaterThan(0);
    expect(w2Ready.pid).not.toBe(w1Ready.pid);

    // Wait for Worker #1's 1.5s durable PostgreSQL lease to expire, then trigger bounded reconciliation!
    await sleep(1_800);
    const rec = await osApi.reconcileStrandedWork(20);
    expect(rec.recoveredExpiredLeaseCount).toBeGreaterThanOrEqual(1);

    // Worker OS Process #2 claims generation 2 and completes the job to READY!
    const claimed2 = await worker2.waitForEvent('CLAIMED', 30_000);
    expect(claimed2.generation).toBe(2);
    expect(claimed2.pid).toBe(w2Ready.pid);

    const done = await waitForUserJobTerminal(osApi, user.id, sub.job.jobId, 60_000);
    expect(done.status).toBe('READY');
    expect(done.highlightsCount).toBeGreaterThanOrEqual(1);

    // Verify downloaded MP4 from recovered job passes ffprobe!
    const hl = await osApi.getUserJobHighlights(user.id, sub.job.jobId);
    expect(hl.highlights.length).toBeGreaterThanOrEqual(1);
    await fs.mkdir(workRootProbe, { recursive: true });
    const resp = await fetch(hl.highlights[0].downloadUrl!);
    expect(resp.status).toBe(200);
    const probePath = path.join(workRootProbe, `os_recovered_${runTag}.mp4`);
    await fs.writeFile(probePath, Buffer.from(await resp.arrayBuffer()));
    const meta = await probeAndValidateClipMp4(probePath);
    expect(meta.durationSec).toBeGreaterThan(0.5);

    await worker2.killNow();
  }, 120_000);

  it('5 (Scenarios 11, 12, 13, 14, 15): proves zero late-subscriber races during/after completion and handles all cancellation races cleanly', async () => {
    // ── Part A: Subscribers arriving BEFORE, DURING, and AFTER terminal completion + cancel racing completion ──
    const vodComp = `vod_term_${runTag}`;
    const adapterComp = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodComp,
      fixturePath: fixture30sPath,
      title: 'Terminal Race & Late Joiner VOD',
    });
    const regComp = adapterComp.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regComp.canonicalId);
    await apiA.registry.registerOrGetMediaSource(regComp);
    await grantSharedRights(regComp.canonicalId);

    let compStarted!: () => void;
    const compStartedP = new Promise<void>((r) => {
      compStarted = r;
    });
    let releaseComp!: () => void;
    const compGate = new Promise<void>((r) => {
      releaseComp = r;
    });
    let compRuns = 0;

    const fixComp = `fix_term_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixComp,
      canonicalSourceId: regComp.canonicalId,
      adapter: adapterComp,
      onWorkerAttempt: async () => {
        compRuns++;
        compStarted();
        await compGate;
      },
    });

    const leadUser = await createTestUser('term_lead');
    const cancelledUser = await createTestUser('term_cancelled');
    const duringUsers = await Promise.all(
      Array.from({ length: 16 }, (_, i) => createTestUser(`term_during_${i}`)),
    );
    const afterUsers = await Promise.all(
      Array.from({ length: 4 }, (_, i) => createTestUser(`term_after_${i}`)),
    );

    const leadSub = await apiA.submitMediaJob(leadUser.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixComp },
      idempotencyKey: `term_lead_${runTag}`,
    });
    const cancelSub = await apiB.submitMediaJob(cancelledUser.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixComp },
      idempotencyKey: `term_cancel_${runTag}`,
    });

    await compStartedP;

    // Cancel cancelledUser while RUNNING -> must stay CANCELLED forever (NEVER regress CANCELLED -> READY!)
    const cRes = await apiB.cancelUserJob(cancelledUser.id, cancelSub.job.jobId);
    expect(cRes.status).toBe('CANCELLED');
    expect(cRes.sharedWorkStillActive).toBe(true);

    // Release worker AND simultaneously fire 16 concurrent subscribers across apiA + apiB right across commitWorkReady!
    releaseComp();
    const duringSubs = await Promise.all(
      duringUsers.map((u, idx) =>
        (idx % 2 === 0 ? apiA : apiB).submitMediaJob(u.id, {
          input: { inputType: 'controlled_fixture', fixtureKey: fixComp },
          idempotencyKey: `term_dur_${idx}_${runTag}`,
        }),
      ),
    );

    // Wait for leadUser to reach READY
    const leadDone = await waitForUserJobTerminal(apiA, leadUser.id, leadSub.job.jobId);
    expect(leadDone.status).toBe('READY');

    // Fire 4 late joiners AFTER READY -> all receive immediate 200 READY!
    const afterSubs = await Promise.all(
      afterUsers.map((u, idx) =>
        apiB.submitMediaJob(u.id, {
          input: { inputType: 'controlled_fixture', fixtureKey: fixComp },
          idempotencyKey: `term_aft_${idx}_${runTag}`,
        }),
      ),
    );
    for (const s of afterSubs) {
      expect(s.httpStatus).toBe(200);
      expect(s.job.status).toBe('READY');
    }

    // EVERY SINGLE ONE of the 16 during-completion subscribers MUST be READY (ZERO stranded QUEUED!)
    for (let i = 0; i < duringUsers.length; i++) {
      const st = await apiA.getUserJobStatus(duringUsers[i].id, duringSubs[i].job.jobId);
      expect(st.status).toBe('READY');
    }

    // Cancelled user NEVER regressed CANCELLED -> READY!
    const cancelledFinal = await apiB.getUserJobStatus(cancelledUser.id, cancelSub.job.jobId);
    expect(cancelledFinal.status).toBe('CANCELLED');

    // Cancelling AFTER completion NEVER regresses READY -> CANCELLED!
    const cancelAfterDone = await apiA.cancelUserJob(leadUser.id, leadSub.job.jobId);
    expect(cancelAfterDone.status).toBe('READY');
    expect(cancelAfterDone.alreadyCompleted).toBe(true);
    expect((await apiA.getUserJobStatus(leadUser.id, leadSub.job.jobId)).status).toBe('READY');
    expect(compRuns).toBe(1);

    // ── Part B: Cancel BEFORE enqueue -> reconciler enqueues NOTHING ──
    const userPreCancel = await createTestUser('pre_cancel');
    const crashingPre = new UniversalMediaApiService({
      db,
      storage,
      redis: redis as any,
      workRootDir: workRootA,
      keyPrefix,
      skipImmediateEnqueue: true,
      enqueueJob: enqueueToMainQueue,
    });
    const vodPre = `vod_precancel_${runTag}`;
    const adapterPre = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodPre,
      fixturePath: fixture30sPath,
      title: 'Pre-Enqueue Cancel VOD',
    });
    const regPre = adapterPre.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regPre.canonicalId);
    await apiA.registry.registerOrGetMediaSource(regPre);
    await grantSharedRights(regPre.canonicalId);
    const fixPre = `fix_precancel_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixPre,
      canonicalSourceId: regPre.canonicalId,
      adapter: adapterPre,
    });

    const preSub = await crashingPre.submitMediaJob(userPreCancel.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixPre },
      idempotencyKey: `pre_cancel_${runTag}`,
    });
    const preCancelRes = await crashingPre.cancelUserJob(userPreCancel.id, preSub.job.jobId);
    expect(preCancelRes.status).toBe('CANCELLED');
    expect(preCancelRes.sharedWorkStillActive).toBe(false);
    const preWork = await db.sharedMediaWork.findUniqueOrThrow({
      where: { sharedWorkKey: preSub.sharedWorkKey },
    });
    expect(preWork.status).toBe('CANCELLED');
    expect(enqueuedByWorkKey.get(preSub.sharedWorkKey) ?? 0).toBe(0);

    // ── Part C: Subscriber joining AFTER all prior users cancelled -> bumps to generation 2 & succeeds READY! ──
    const userAfterCancel = await createTestUser('after_all_cancel');
    const postCancelSub = await apiA.submitMediaJob(userAfterCancel.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixPre },
      idempotencyKey: `post_cancel_${runTag}`,
    });
    expect(postCancelSub.httpStatus).toBe(202);
    const doneAfterCancel = await waitForUserJobTerminal(
      apiA,
      userAfterCancel.id,
      postCancelSub.job.jobId,
    );
    expect(doneAfterCancel.status).toBe('READY');
    const workGen2 = await db.sharedMediaWork.findUniqueOrThrow({
      where: { sharedWorkKey: postCancelSub.sharedWorkKey },
    });
    expect(workGen2.generation).toBe(2);
    expect(workGen2.status).toBe('READY');

    // ── Part D: Cancellation DURING retry backoff -> attempt 2 skips without executing! ──
    const userRetryCancel = await createTestUser('retry_cancel');
    const vodRC = `vod_retrycancel_${runTag}`;
    const adapterRC = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodRC,
      fixturePath: fixture30sPath,
      title: 'Cancel During Retry VOD',
    });
    const regRC = adapterRC.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regRC.canonicalId);
    await apiA.registry.registerOrGetMediaSource(regRC);
    await grantSharedRights(regRC.canonicalId);

    let rcAttempts = 0;
    let attempt1Failed!: () => void;
    const attempt1FailedP = new Promise<void>((r) => {
      attempt1Failed = r;
    });
    const fixRC = `fix_retrycancel_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixRC,
      canonicalSourceId: regRC.canonicalId,
      adapter: adapterRC,
      onWorkerAttempt: async (attempt) => {
        rcAttempts = attempt;
        if (attempt === 1) {
          attempt1Failed();
          throw new Error('Transient attempt 1 error before cancel');
        }
      },
    });

    const rcSub = await apiA.submitMediaJob(userRetryCancel.id, {
      input: { inputType: 'controlled_fixture', fixtureKey: fixRC },
      idempotencyKey: `retry_cancel_${runTag}`,
    });
    await attempt1FailedP;
    const rcCancel = await apiA.cancelUserJob(userRetryCancel.id, rcSub.job.jobId);
    expect(rcCancel.status).toBe('CANCELLED');
    await sleep(900);
    // Attempt 2 saw NO_ACTIVE_SUBSCRIBERS at durable claim and NEVER executed onWorkerAttempt(2)!
    expect(rcAttempts).toBe(1);
  }, 90_000);

  it('6 (Scenarios 1, 2, 18, 19, 20, 21, 22, 23, 24): deduplicates 1,000 clippers across TWO independent API instances (1 owner, 1 import, 1 analysis, 1 clip) + shared live ingestion + rights revocation & private upload isolation', async () => {
    // ── 6A. 1,000 concurrent clippers split across TWO independent API instances (apiA + apiB) ──
    const vod1k = `vod_1k_hard_${runTag}`;
    const adapter1k = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'twitch_vod',
      vodId: vod1k,
      fixturePath: fixture30sPath,
      title: '1000 Clippers Two-Instance VOD',
    });
    const reg1k = adapter1k.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(reg1k.canonicalId);
    await apiA.registry.registerOrGetMediaSource(reg1k);
    await grantSharedRights(reg1k.canonicalId);

    const fix1k = `fix_1k_hard_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fix1k,
      canonicalSourceId: reg1k.canonicalId,
      adapter: adapter1k,
    });

    await db.user.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({
        email: `hclip_${runTag}_${i}@local.test`,
        name: `HClipper ${i}`,
      })),
    });
    const clippers = await db.user.findMany({
      where: { email: { startsWith: `hclip_${runTag}_` } },
      select: { id: true, email: true },
    });
    expect(clippers.length).toBe(1000);
    for (const c of clippers) createdUserIds.add(c.id);

    const importsBefore = workerHandle.vodService.metrics.sourceImportCount;
    const analysisBefore = workerHandle.vodService.metrics.analysisPassCount;
    const clipsBefore = workerHandle.vodService.metrics.baseClipRenderCount;
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = Date.now();

    const submitted: Array<{ userId: string; jobId: string; sharedWorkKey: string }> = [];
    for (let start = 0; start < 1000; start += 16) {
      const slice = clippers.slice(start, start + 16);
      const batch = await Promise.all(
        slice.map((c, idx) => {
          const svc = (start + idx) % 2 === 0 ? apiA : apiB;
          return svc.submitMediaJob(c.id, {
            input: { inputType: 'controlled_fixture', fixtureKey: fix1k },
            idempotencyKey: `h1k_${start + idx}`,
          });
        }),
      );
      for (let i = 0; i < batch.length; i++) {
        submitted.push({
          userId: slice[i].id,
          jobId: batch[i].job.jobId,
          sharedWorkKey: batch[i].sharedWorkKey,
        });
      }
    }

    const sharedWorkKey = submitted[0].sharedWorkKey;
    expect(new Set(submitted.map((s) => s.sharedWorkKey)).size).toBe(1);

    const done0 = await waitForUserJobTerminal(apiA, submitted[0].userId, submitted[0].jobId, 90_000);
    expect(done0.status).toBe('READY');

    // EVERY SINGLE ONE of the 1,000 rows MUST already be READY immediately (zero double sweep lag!)
    const readyCount = await db.mediaProcessingJob.count({
      where: { sharedWorkKey, status: 'READY' },
    });
    expect(readyCount).toBe(1000);

    const elapsedMs = Date.now() - t0;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
    const actualEnqueues = enqueuedByWorkKey.get(sharedWorkKey) ?? 0;
    const actualClaims = claimsByWorkKey.get(sharedWorkKey) ?? 0;
    const actualImports = workerHandle.vodService.metrics.sourceImportCount - importsBefore;
    const actualAnalyses = workerHandle.vodService.metrics.analysisPassCount - analysisBefore;
    const actualClipRenders = workerHandle.vodService.metrics.baseClipRenderCount - clipsBefore;

    console.log(
      `[Step 3B.9.1 Measured 1,000 Clippers / 2 API Instances] elapsed=${elapsedMs}ms | enqueues=${actualEnqueues} | workerClaims=${actualClaims} | imports=${actualImports} | analyses=${actualAnalyses} | baseClipRenders=${actualClipRenders} | readySubscribers=${readyCount}/1000 | heapDelta=${heapDeltaMb.toFixed(1)}MB`,
    );

    expect(actualEnqueues).toBe(1);
    expect(actualClaims).toBe(1);
    expect(actualImports).toBe(1);
    expect(actualAnalyses).toBe(1);
    expect(actualClipRenders).toBe(1);

    // 21 & 22: Unauthorized cross-user access denied (404) & rights revocation blocks downloads immediately
    await expect(apiB.getUserJobStatus(clippers[1].id, submitted[0].jobId)).rejects.toMatchObject({
      statusCode: 404,
    });
    const hlOk = await apiB.getUserJobHighlights(clippers[999].id, submitted[999].jobId);
    expect(hlOk.highlights.length).toBeGreaterThanOrEqual(1);

    await apiA.registry.revokeSourceRights({
      canonicalSourceId: reg1k.canonicalId,
      revokedReason: 'Hardening revocation check',
    });
    await expect(
      apiB.getUserJobHighlights(clippers[999].id, submitted[999].jobId),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // ── 6B. Shared continuous LIVE ingestion across 20 concurrent clippers (2 API instances) -> 1 live owner ──
    const liveBroadcastId = `live_hard_${runTag}`;
    const liveAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath: fixture30sPath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'step3b91_live',
        broadcastId: liveBroadcastId,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4,
        segmentPaceMs: 100,
        maxQueueSize: 4,
      },
    });
    const verifiedLive = liveAdapter.buildVerifiedBroadcastSource();
    createdSourceCanonicalIds.add(verifiedLive.canonicalId);
    await apiA.registry.registerOrGetMediaSource({
      canonicalId: verifiedLive.canonicalId,
      provider: 'twitch',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: verifiedLive.externalId,
      channelId: verifiedLive.channelId,
      broadcastId: liveBroadcastId,
      availability: 'LIVE_NOW',
      metadata: { title: 'Step 3B.9.1 Shared Live Stream' },
    });
    await grantSharedRights(verifiedLive.canonicalId);

    const fixLive = `fix_live_hard_${runTag}`;
    registerControlledTestFixture({
      kind: 'live',
      fixtureKey: fixLive,
      canonicalSourceId: verifiedLive.canonicalId,
      adapter: liveAdapter,
    });

    const liveOwnersBefore = workerHandle.liveService.counters.sessionOwnersStarted;
    const liveSubs = await Promise.all(
      clippers.slice(0, 20).map((c, idx) =>
        (idx % 2 === 0 ? apiA : apiB).submitMediaJob(c.id, {
          input: { inputType: 'controlled_fixture', fixtureKey: fixLive },
          idempotencyKey: `hlive_${idx}_${runTag}`,
        }),
      ),
    );
    const liveWorkKey = liveSubs[0].sharedWorkKey;
    await waitForUserJobTerminal(apiA, clippers[0].id, liveSubs[0].job.jobId, 60_000);
    const liveReadyCount = await db.mediaProcessingJob.count({
      where: { sharedWorkKey: liveWorkKey, status: 'READY' },
    });
    expect(liveReadyCount).toBe(20);
    expect(enqueuedByWorkKey.get(liveWorkKey)).toBe(1);
    expect(workerHandle.liveService.counters.sessionOwnersStarted - liveOwnersBefore).toBe(1);

    // ── 6C. Private upload isolation (Scenario 23) ──
    const upOwner = clippers[0];
    const upIntruder = clippers[1];
    const uploadKey = `uploads/step3b91_${runTag}/${upOwner.id}/priv.mp4`;
    const upBytes = await fs.readFile(fixture30sPath);
    await storage.putObject({ key: uploadKey, body: upBytes, contentType: 'video/mp4' });
    createdStorageKeys.add(uploadKey);

    const asset = await db.asset.create({
      data: {
        kind: 'SOURCE_VIDEO',
        s3Key: uploadKey,
        bucket: MINIO_BUCKET,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(upBytes.length),
        durationSec: 30,
        width: 1280,
        height: 720,
      },
    });
    const privProject = await db.project.create({
      data: {
        userId: upOwner.id,
        title: 'Private Hardening Upload',
        sourceAssetId: asset.id,
      },
    });
    createdSourceCanonicalIds.add(`upload:uploaded:${asset.id}`);

    const intruderResolve = await apiB.resolveUniversalSource(upIntruder.id, {
      inputType: 'upload',
      projectId: privProject.id,
    });
    expect(intruderResolve.response.capabilityStatus).toBe('SOURCE_UNAVAILABLE');
    expect(intruderResolve.response.canSubmitJob).toBe(false);

    const ownerSub = await apiA.submitMediaJob(upOwner.id, {
      input: { inputType: 'upload', projectId: privProject.id },
      idempotencyKey: `priv_up_${runTag}`,
    });
    const ownerDone = await waitForUserJobTerminal(apiA, upOwner.id, ownerSub.job.jobId, 60_000);
    expect(ownerDone.status).toBe('READY');
    await expect(
      apiB.getUserJobHighlights(upIntruder.id, ownerSub.job.jobId),
    ).rejects.toMatchObject({ statusCode: 404 });
  }, 150_000);
});
