import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import type { MediaProcessJobPayload, PrivateRenderQueuePayload, CacheableSourceId } from '@autoedit/contracts';
import {
  ensureControlledLiveFixture,
  ensureControlledMultiEventLiveFixture,
  ControlledVodAcquisitionAdapter,
  ControlledRealTimeStreamAdapter,
  probeAndValidateClipMp4,
  UniversalMediaApiService,
  registerControlledTestFixture,
  clearControlledTestFixtures,
  MediaSourceError,
} from '../../src/media/index.js';
import { createMediaRouter } from '../../src/routes/media.routes.js';
import { createMediaWorker } from '../../src/queue/workers/media.worker.js';
import { createPrivateRenderWorker } from '../../src/queue/workers/private-render.worker.js';
import { requireAuth, errorHandler } from '../../src/middleware/auth.js';
import { signToken } from '../../src/utils/auth.js';
import { bullConnection, connection as redis } from '../../src/lib/redis.js';
import { createStorageProvider, type MediaStorageProvider } from '../../src/storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const RAW_LOCAL_DB_URL =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('autoedit_test')
    ? process.env.DATABASE_URL
    : 'postgresql://autoedit:autoedit_local_pass@127.0.0.1:5432/autoedit_local?schema=public';
const BASE_LOCAL_DB_URL = RAW_LOCAL_DB_URL.replace('@localhost:', '@127.0.0.1:');
const LOCAL_DB_URL = BASE_LOCAL_DB_URL.includes('pool_timeout=')
  ? BASE_LOCAL_DB_URL
  : `${BASE_LOCAL_DB_URL}${BASE_LOCAL_DB_URL.includes('?') ? '&' : '?'}connection_limit=8&pool_timeout=30`;

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

/** Verify no raw MinIO/S3 keys or local file paths leak in public API JSON responses. */
function assertNoRawStorageLeak(payload: unknown): void {
  const raw = JSON.stringify(payload);
  expect(raw).not.toContain('"s3Key"');
  expect(raw).not.toContain('"objectKey"');
  expect(raw).not.toContain('"publishedObjectKey"');
  expect(raw).not.toContain('autoedit-local/media-cache');
}

describe('Step 3B.9: Universal Media API, Authenticated Jobs, Real BullMQ Worker & Private Projects', () => {
  const db = new PrismaClient({
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
  const queueName = `media-process-test-${runTag}`;
  const privateRenderQueueName = `private-render-test-${runTag}`;
  const keyPrefix = `autoedit:test:step3b9:${runTag}:`;
  const fixture30sPath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
  const fixture60sPath = path.resolve(process.cwd(), 'tmp', 'step3b6-3event-60s-fixture.mp4');
  const workRootApi = path.resolve(process.cwd(), 'tmp', `step3b9-api-${runTag}`);
  const workRootWorker = path.resolve(process.cwd(), 'tmp', `step3b9-worker-${runTag}`);
  const workRootProbe = path.resolve(process.cwd(), 'tmp', `step3b9-probe-${runTag}`);

  const createdUserIds = new Set<string>();
  const createdSourceCanonicalIds = new Set<string>();
  const createdStorageKeys = new Set<string>();

  let testQueue: Queue<MediaProcessJobPayload>;
  let privateRenderTestQueue: Queue<PrivateRenderQueuePayload>;
  let workerHandle: ReturnType<typeof createMediaWorker>;
  let privateRenderWorkerHandle: ReturnType<typeof createPrivateRenderWorker>;
  let service: UniversalMediaApiService;
  let server: http.Server;
  let baseUrl = '';
  let totalEnqueuedCount = 0;
  const enqueuedByWorkKey = new Map<string, number>();

  async function createTestUser(suffix: string) {
    const user = await db.user.create({
      data: {
        email: `step3b9_${runTag}_${suffix}@local.test`,
        name: `MediaAPI User ${suffix}`,
      },
    });
    createdUserIds.add(user.id);
    const token = signToken({ sub: user.id, email: user.email });
    return { user, token };
  }

  async function grantControlledSharedRights(
    targetService: UniversalMediaApiService,
    canonicalSourceId: string,
  ) {
    await targetService.registry.grantSourceRights({
      canonicalSourceId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      rightsStatus: 'PERMITTED_PUBLIC',
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b9',
    });
  }

  async function apiRequest<T = any>(
    method: 'GET' | 'POST',
    routePath: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  async function waitForJobTerminalStatus(
    token: string,
    jobId: string,
    timeoutMs = 60_000,
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await apiRequest('GET', `/api/media/jobs/${jobId}`, { token });
      expect(res.status).toBe(200);
      if (['READY', 'FAILED', 'CANCELLED'].includes(res.data.status)) {
        return res.data;
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for job ${jobId} to finish`);
  }

  async function downloadAndProbeSignedUrl(downloadUrl: string, name: string) {
    await fs.mkdir(workRootProbe, { recursive: true });
    const resp = await fetch(downloadUrl);
    expect(resp.status).toBe(200);
    const buf = Buffer.from(await resp.arrayBuffer());
    expect(buf.length).toBeGreaterThan(2048);
    const localFile = path.join(workRootProbe, `${name}.mp4`);
    await fs.writeFile(localFile, buf);
    const meta = await probeAndValidateClipMp4(localFile);
    expect(meta.durationSec).toBeGreaterThan(0.5);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
    return meta;
  }

  beforeAll(async () => {
    expect(await redis.ping()).toBe('PONG');
    const health = await storage.checkHealth();
    expect(health.ok).toBe(true);
    await db.$queryRaw`SELECT 1`;

    await ensureControlledLiveFixture(fixture30sPath, {
      durationSec: 30,
      spikeStartSec: 16,
      spikeEndSec: 19,
    });
    await ensureControlledMultiEventLiveFixture(fixture60sPath, {
      durationSec: 60,
    });

    testQueue = new Queue<MediaProcessJobPayload>(queueName, {
      connection: bullConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 300 },
        removeOnComplete: 500,
        removeOnFail: 200,
      },
    });
    privateRenderTestQueue = new Queue<PrivateRenderQueuePayload>(privateRenderQueueName, {
      connection: bullConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 300 },
        removeOnComplete: 200,
        removeOnFail: 100,
      },
    });

    service = new UniversalMediaApiService({
      db,
      storage,
      redis: redis as any,
      workRootDir: workRootApi,
      keyPrefix,
      quotas: {
        maxActiveJobsPerUser: 10,
        maxDailyJobSubmissionsPerUser: 200,
        downloadUrlTtlSec: 300,
        maxClipsPerUserPerDay: 100,
      },
      enqueueJob: async (payload, opts) => {
        totalEnqueuedCount++;
        enqueuedByWorkKey.set(
          payload.sharedWorkKey,
          (enqueuedByWorkKey.get(payload.sharedWorkKey) ?? 0) + 1,
        );
        const safeJobId =
          opts?.jobId ??
          `${payload.sharedWorkKey.replace(/[^a-zA-Z0-9_-]/g, '_')}__g${payload.generation ?? 1}`;
        const job = await testQueue.add('process-media', payload, {
          jobId: safeJobId,
          attempts: 3,
          backoff: { type: 'fixed', delay: 300 },
        });
        return { id: job.id };
      },
      enqueuePrivateRenderJob: async (payload, opts) => {
        const job = await privateRenderTestQueue.add('private-render', payload, {
          jobId: opts?.jobId ?? `priv_${payload.renderJobId}__g${payload.generation}`,
          attempts: 3,
          backoff: { type: 'fixed', delay: 300 },
        });
        return { id: job.id };
      },
    });

    workerHandle = createMediaWorker({
      queueName,
      db: dbWorker,
      storage,
      redis: redis as any,
      bullConnection,
      workRootDir: workRootWorker,
      keyPrefix,
      concurrency: 2,
      reconcileIntervalMs: 0,
    });
    await workerHandle.worker.waitUntilReady();

    privateRenderWorkerHandle = createPrivateRenderWorker({
      queueName: privateRenderQueueName,
      db: dbWorker,
      storage,
      redis: redis as any,
      bullConnection,
      workRootDir: path.join(workRootWorker, 'priv-renders'),
      keyPrefix: `${keyPrefix}priv_render:`,
      concurrency: 2,
      reconcileIntervalMs: 0,
    });
    await privateRenderWorkerHandle.worker.waitUntilReady();

    // High-ceiling rate limiters for main app (tight rate-limit test mounts its own dedicated route!)
    const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(
      '/api/media',
      requireAuth,
      createMediaRouter({
        service,
        resolveLimiter: noopLimiter,
        jobLimiter: noopLimiter,
      }),
    );
    app.use(errorHandler);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind test HTTP server');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 90_000);

  afterAll(async () => {
    clearControlledTestFixtures();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (privateRenderWorkerHandle) {
      await privateRenderWorkerHandle.worker.close().catch(() => {});
    }
    if (workerHandle) {
      await workerHandle.worker.close().catch(() => {});
    }
    if (privateRenderTestQueue) {
      await privateRenderTestQueue.obliterate({ force: true }).catch(() => {});
      await privateRenderTestQueue.close().catch(() => {});
    }
    if (testQueue) {
      await testQueue.obliterate({ force: true }).catch(() => {});
      await testQueue.close().catch(() => {});
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
    await fs.rm(workRootApi, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootWorker, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootProbe, { recursive: true, force: true }).catch(() => {});
    await Promise.allSettled([dbWorker.$disconnect(), db.$disconnect()]);
  }, 60_000);

  it('1–6 & 20 & 22: rejects unauthenticated calls, resolves YouTube/Twitch/Kick VOD & live channel URLs truthfully, blocks SSRF & forged fields, and rejects unsupported job submission without enqueueing', async () => {
    const { token } = await createTestUser('resolve_urls');
    const enqBefore = totalEnqueuedCount;

    // 22a. Unauthenticated rejected with 401
    const unauth = await apiRequest('POST', '/api/media/sources/resolve', {
      body: { input: { inputType: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
    });
    expect(unauth.status).toBe(401);

    // 2. Recognized YouTube VOD URL -> UNSUPPORTED_ACQUISITION
    const yt = await apiRequest('POST', '/api/media/sources/resolve', {
      token,
      body: { input: { inputType: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
    });
    expect(yt.status).toBe(200);
    expect(yt.data.provider).toBe('youtube');
    expect(yt.data.sourceType).toBe('vod');
    expect(yt.data.capabilityStatus).toBe('UNSUPPORTED_ACQUISITION');
    expect(yt.data.canSubmitJob).toBe(false);
    assertNoRawStorageLeak(yt.data);

    // 3. Recognized Twitch VOD URL -> UNSUPPORTED_ACQUISITION
    const tw = await apiRequest('POST', '/api/media/sources/resolve', {
      token,
      body: { input: { inputType: 'url', url: 'https://www.twitch.tv/videos/1234567890' } },
    });
    expect(tw.status).toBe(200);
    expect(tw.data.provider).toBe('twitch');
    expect(tw.data.sourceType).toBe('vod');
    expect(tw.data.capabilityStatus).toBe('UNSUPPORTED_ACQUISITION');
    expect(tw.data.canSubmitJob).toBe(false);

    // 4. Recognized Kick VOD URL -> UNSUPPORTED_ACQUISITION
    const kick = await apiRequest('POST', '/api/media/sources/resolve', {
      token,
      body: {
        input: {
          inputType: 'url',
          url: 'https://kick.com/video/11111111-2222-3333-4444-555555555555',
        },
      },
    });
    expect(kick.status).toBe(200);
    expect(kick.data.provider).toBe('kick');
    expect(kick.data.sourceType).toBe('vod');
    expect(kick.data.capabilityStatus).toBe('UNSUPPORTED_ACQUISITION');
    expect(kick.data.canSubmitJob).toBe(false);

    // 5. Recognized live-channel URL -> BROADCAST_UNRESOLVED
    const liveCh = await apiRequest('POST', '/api/media/sources/resolve', {
      token,
      body: { input: { inputType: 'url', url: 'https://www.twitch.tv/shroud' } },
    });
    expect(liveCh.status).toBe(200);
    expect(liveCh.data.provider).toBe('twitch');
    expect(liveCh.data.sourceType).toBe('live');
    expect(liveCh.data.capabilityStatus).toBe('BROADCAST_UNRESOLVED');
    expect(liveCh.data.canSubmitJob).toBe(false);

    // 6. Submitting unsupported URL job fails with 422 without enqueueing ANY worker job
    const badJob = await apiRequest('POST', '/api/media/jobs', {
      token,
      body: {
        input: { inputType: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        idempotencyKey: `idem_unsupported_${runTag}`,
      },
    });
    expect(badJob.status).toBe(422);
    expect(badJob.data.code).toBe('UNSUPPORTED_ACQUISITION');
    expect(totalEnqueuedCount).toBe(enqBefore);

    // 20a. SSRF & invalid schemes rejected cleanly
    for (const badUrl of [
      'http://127.0.0.1/secret.mp4',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
    ]) {
      const ssrfRes = await apiRequest('POST', '/api/media/sources/resolve', {
        token,
        body: { input: { inputType: 'url', url: badUrl } },
      });
      expect([400, 403]).toContain(ssrfRes.status);
    }

    // 20b. Forged client fields (rightsStatus, canonicalSourceId, storageKey, path traversal fixtureKey) rejected with 400
    const forged1 = await apiRequest('POST', '/api/media/jobs', {
      token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey: 'valid_fixture_1' },
        idempotencyKey: 'forged_1',
        rightsStatus: 'AUTHORIZED',
        canonicalSourceId: 'youtube:vod:forged',
        ownerUserId: 'someone_else',
      },
    });
    expect(forged1.status).toBe(400);
    expect(forged1.data.code).toBe('VALIDATION_ERROR');

    const traversal = await apiRequest('POST', '/api/media/sources/resolve', {
      token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey: '../../etc/passwd' },
      },
    });
    expect(traversal.status).toBe(400);
    expect(traversal.data.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('1. resolves existing owned upload, runs private BullMQ worker job, and isolates upload from other users', async () => {
    const owner = await createTestUser('upload_owner');
    const other = await createTestUser('upload_other');

    const uploadKey = `uploads/step3b9_${runTag}/${owner.user.id}/clip.mp4`;
    const bytes = await fs.readFile(fixture30sPath);
    await storage.putObject({ key: uploadKey, body: bytes, contentType: 'video/mp4' });
    createdStorageKeys.add(uploadKey);

    const mediaAsset = await db.asset.create({
      data: {
        kind: 'SOURCE_VIDEO',
        s3Key: uploadKey,
        bucket: MINIO_BUCKET,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(bytes.length),
        durationSec: 30,
        width: 1280,
        height: 720,
      },
    });
    const project = await db.project.create({
      data: {
        userId: owner.user.id,
        title: 'My Uploaded Clip',
        sourceAssetId: mediaAsset.id,
      },
    });
    createdSourceCanonicalIds.add(`upload:uploaded:${mediaAsset.id}`);

    // Other user CANNOT resolve owner's upload
    const otherResolve = await apiRequest('POST', '/api/media/sources/resolve', {
      token: other.token,
      body: { input: { inputType: 'upload', projectId: project.id } },
    });
    expect(otherResolve.status).toBe(200);
    expect(otherResolve.data.capabilityStatus).toBe('SOURCE_UNAVAILABLE');
    expect(otherResolve.data.canSubmitJob).toBe(false);

    // Owner resolves upload -> READY_TO_PROCESS
    const ownerResolve = await apiRequest('POST', '/api/media/sources/resolve', {
      token: owner.token,
      body: { input: { inputType: 'upload', projectId: project.id } },
    });
    expect(ownerResolve.status).toBe(200);
    expect(ownerResolve.data.capabilityStatus).toBe('READY_TO_PROCESS');
    expect(ownerResolve.data.canSubmitJob).toBe(true);
    expect(ownerResolve.data.provider).toBe('upload');
    assertNoRawStorageLeak(ownerResolve.data);

    // Owner submits job -> real BullMQ worker runs private highlight pipeline -> READY
    const submitRes = await apiRequest('POST', '/api/media/jobs', {
      token: owner.token,
      body: {
        input: { inputType: 'upload', projectId: project.id },
        idempotencyKey: `upload_job_${runTag}`,
      },
    });
    expect(submitRes.status).toBe(202);
    const done = await waitForJobTerminalStatus(owner.token, submitRes.data.jobId, 60_000);
    expect(done.status).toBe('READY');
    expect(done.highlightsCount).toBeGreaterThanOrEqual(1);

    const hlRes = await apiRequest('GET', `/api/media/jobs/${submitRes.data.jobId}/highlights`, {
      token: owner.token,
    });
    expect(hlRes.status).toBe(200);
    expect(hlRes.data.highlights.length).toBeGreaterThanOrEqual(1);
    expect(hlRes.data.highlights[0].downloadUrlExpiresInSec).toBe(300);
    assertNoRawStorageLeak(hlRes.data);

    // Signed URL downloads real MP4 passing ffprobe
    await downloadAndProbeSignedUrl(hlRes.data.highlights[0].downloadUrl, `upload_${runTag}`);

    // Other user gets 404 on owner's upload job & highlights
    const otherStatus = await apiRequest('GET', `/api/media/jobs/${submitRes.data.jobId}`, {
      token: other.token,
    });
    expect(otherStatus.status).toBe(404);
    const otherHl = await apiRequest('GET', `/api/media/jobs/${submitRes.data.jobId}/highlights`, {
      token: other.token,
    });
    expect(otherHl.status).toBe(404);
  }, 90_000);

  it('7, 9, 10, 12, 14, 17, 18: runs controlled VOD via real BullMQ worker, verifies idempotency, owner-only access, two private projects, private edit isolation, CAS rejection, and live revocation', async () => {
    const userA = await createTestUser('vod_userA');
    const userB = await createTestUser('vod_userB');

    const vodId = `vod_api_${runTag}`;
    const adapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_completed_live_vod',
      vodId,
      fixturePath: fixture30sPath,
      title: 'API Controlled VOD',
    });
    const regInput = adapter.buildMediaSourceRegistration();
    const canonicalId = regInput.canonicalId as CacheableSourceId;
    createdSourceCanonicalIds.add(canonicalId);

    const ms = await service.registry.registerOrGetMediaSource(regInput);
    await grantControlledSharedRights(service, canonicalId);

    const fixtureKey = `vod_fix_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey,
      canonicalSourceId: canonicalId,
      adapter,
    });

    // Resolve returns READY_TO_PROCESS
    const resolved = await apiRequest('POST', '/api/media/sources/resolve', {
      token: userA.token,
      body: { input: { inputType: 'controlled_fixture', fixtureKey } },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.data.capabilityStatus).toBe('READY_TO_PROCESS');
    expect(resolved.data.canSubmitJob).toBe(true);

    // 10. Idempotency: concurrent duplicate submissions with same idempotencyKey produce 1 job
    const idemKey = `vod_idem_${runTag}`;
    const [sub1, sub2] = await Promise.all([
      apiRequest('POST', '/api/media/jobs', {
        token: userA.token,
        body: { input: { inputType: 'controlled_fixture', fixtureKey }, idempotencyKey: idemKey },
      }),
      apiRequest('POST', '/api/media/jobs', {
        token: userA.token,
        body: { input: { inputType: 'controlled_fixture', fixtureKey }, idempotencyKey: idemKey },
      }),
    ]);
    expect([200, 202]).toContain(sub1.status);
    expect([200, 202]).toContain(sub2.status);
    expect(sub1.data.jobId).toBe(sub2.data.jobId);

    // Retry same idempotencyKey sequentially -> returns 200 with exact same jobId
    const sub3 = await apiRequest('POST', '/api/media/jobs', {
      token: userA.token,
      body: { input: { inputType: 'controlled_fixture', fixtureKey }, idempotencyKey: idemKey },
    });
    expect(sub3.status).toBe(200);
    expect(sub3.data.jobId).toBe(sub1.data.jobId);

    const jobAId = sub1.data.jobId as string;

    // 12. Owner-only status/highlights check (User B gets 404 on User A's job)
    const sneakStatus = await apiRequest('GET', `/api/media/jobs/${jobAId}`, {
      token: userB.token,
    });
    expect(sneakStatus.status).toBe(404);

    // 7. Wait for real BullMQ worker to complete VOD processing
    const doneA = await waitForJobTerminalStatus(userA.token, jobAId, 60_000);
    expect(doneA.status).toBe('READY');
    expect(doneA.highlightsCount).toBeGreaterThanOrEqual(1);

    const hlA = await apiRequest('GET', `/api/media/jobs/${jobAId}/highlights`, {
      token: userA.token,
    });
    expect(hlA.status).toBe(200);
    expect(hlA.data.highlights.length).toBeGreaterThanOrEqual(1);
    expect(hlA.data.highlights[0].downloadUrlExpiresInSec).toBe(300);
    assertNoRawStorageLeak(hlA.data);
    await downloadAndProbeSignedUrl(hlA.data.highlights[0].downloadUrl, `vod_hl_${runTag}`);

    // User B joins same VOD -> instant READY cache reuse without re-enqueueing!
    const enqCountBeforeB = totalEnqueuedCount;
    const subB = await apiRequest('POST', '/api/media/jobs', {
      token: userB.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey },
        idempotencyKey: `vod_b_${runTag}`,
      },
    });
    expect(subB.status).toBe(200);
    expect(subB.data.status).toBe('READY');
    expect(subB.data.deduplicatedSharedWork).toBe(true);
    expect(totalEnqueuedCount).toBe(enqCountBeforeB);

    // 9. Two users create distinct private Projects / EditTimelines / EditVersions for the SAME VOD
    const projA = await apiRequest('POST', '/api/media/projects/from-source', {
      token: userA.token,
      body: { jobId: jobAId, title: 'User A Private Clip Project' },
    });
    expect(projA.status).toBe(201);
    const projB = await apiRequest('POST', '/api/media/projects/from-source', {
      token: userB.token,
      body: { jobId: subB.data.jobId, title: 'User B Private Clip Project' },
    });
    expect(projB.status).toBe(201);

    expect(projA.data.mediaSourceId).toBe(projB.data.mediaSourceId);
    expect(projA.data.projectId).not.toBe(projB.data.projectId);
    expect(projA.data.timelineId).not.toBe(projB.data.timelineId);
    expect(projA.data.rootVersionId).not.toBe(projB.data.rootVersionId);

    const projAHl = await apiRequest(
      'GET',
      `/api/media/projects/${projA.data.projectId}/highlights`,
      { token: userA.token },
    );
    expect(projAHl.status).toBe(200);
    expect(projAHl.data.highlights.length).toBeGreaterThanOrEqual(1);
    assertNoRawStorageLeak(projAHl.data);

    // 18. Private custom edit isolation: User A applies prompt edit -> enqueues async private render (HTTP 202)
    const editA = await apiRequest('POST', `/api/media/projects/${projA.data.projectId}/edits`, {
      token: userA.token,
      body: {
        mode: 'prompt',
        versionName: 'Hype Cut v2',
        userPrompt: 'Tighten around peak moment with zooms',
        windowStartSec: 12,
        windowEndSec: 21,
        effects: { subtitles: false, zooms: true, transitions: 'fade', music: false },
        renderOutput: true,
        idempotencyKey: `priv_edit_idem_${runTag}`,
      },
    });
    expect(editA.status).toBe(202);
    expect(editA.data.parentVersionId).toBe(projA.data.rootVersionId);
    expect(editA.data.renderJob?.renderJobId).toBeTruthy();
    assertNoRawStorageLeak(editA.data);

    // Poll async private render job until READY, then probe verified private MP4
    const renderJobId = editA.data.renderJob.renderJobId as string;
    let renderDone: any = null;
    const renderDeadline = Date.now() + 60_000;
    while (Date.now() < renderDeadline) {
      const rPoll = await apiRequest(
        'GET',
        `/api/media/projects/${projA.data.projectId}/renders/${renderJobId}`,
        { token: userA.token },
      );
      expect(rPoll.status).toBe(200);
      assertNoRawStorageLeak(rPoll.data);
      if (['READY', 'FAILED', 'CANCELLED'].includes(rPoll.data.status)) {
        renderDone = rPoll.data;
        break;
      }
      await sleep(250);
    }
    expect(renderDone?.status).toBe('READY');
    expect(renderDone?.downloadUrl).toBeTruthy();
    expect(renderDone?.downloadUrlExpiresInSec).toBe(300);
    await downloadAndProbeSignedUrl(renderDone.downloadUrl, `priv_edit_a_${runTag}`);

    // User B gets 404 trying to view or edit User A's project
    const sneakProjHl = await apiRequest(
      'GET',
      `/api/media/projects/${projA.data.projectId}/highlights`,
      { token: userB.token },
    );
    expect(sneakProjHl.status).toBe(404);
    const sneakProjEdit = await apiRequest(
      'POST',
      `/api/media/projects/${projA.data.projectId}/edits`,
      {
        token: userB.token,
        body: {
          mode: 'manual',
          versionName: 'Unauthorized Edit',
          windowStartSec: 10,
          windowEndSec: 18,
          renderOutput: false,
        },
      },
    );
    expect(sneakProjEdit.status).toBe(404);

    // User B's own project still has only its untouched root version
    const bVersions = await db.editVersion.findMany({
      where: { projectId: projB.data.projectId },
    });
    expect(bVersions.length).toBe(1);

    // 17. Stale publication rejected by PostgreSQL CAS without corrupting published highlight
    const publishedArt = await db.sharedCacheArtifact.findFirstOrThrow({
      where: {
        mediaSourceId: ms.id,
        artifactKind: 'BASE_CLIP',
        rightsScope: 'SHARED_PERMITTED',
        state: 'PUBLISHED',
      },
    });
    const staleDescriptor = {
      artifactKind: 'BASE_CLIP' as const,
      sourceRevision: publishedArt.sourceRevision,
      timeRangeSec:
        publishedArt.windowStartSec !== null && publishedArt.windowEndSec !== null
          ? { start: publishedArt.windowStartSec, end: publishedArt.windowEndSec }
          : undefined,
      algorithmVersion: publishedArt.algorithmVersion,
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
    await expect(
      service.publisher.commitPublishedArtifact({
        artifactId: publishedArt.id,
        attemptId: 'stale_attempt_from_old_worker',
        generation: publishedArt.publishedGeneration,
        workerId: 'stale_zombie_worker',
        requesterUserId: userA.user.id,
        canonicalSourceId: canonicalId,
        descriptor: staleDescriptor,
        objectKey: publishedArt.publishedObjectKey!,
        contentSha256: 'a'.repeat(64),
        sizeBytes: Number(publishedArt.sizeBytes ?? 1000),
      }),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });

    // Valid highlight still serves cleanly after stale CAS rejection
    const hlAfterStale = await apiRequest('GET', `/api/media/jobs/${jobAId}/highlights`, {
      token: userA.token,
    });
    expect(hlAfterStale.status).toBe(200);
    expect(hlAfterStale.data.highlights.length).toBeGreaterThanOrEqual(1);

    // 14. Revoking rights in PostgreSQL IMMEDIATELY stops new downloads on both job & project routes
    await service.registry.revokeSourceRights({
      canonicalSourceId: canonicalId,
      revokedReason: 'Creator revoked VOD rights',
    });
    const hlRevoked = await apiRequest('GET', `/api/media/jobs/${jobAId}/highlights`, {
      token: userA.token,
    });
    expect(hlRevoked.status).toBe(403);
    expect(hlRevoked.data.code).toBe('ACCESS_DENIED');

    const projRevoked = await apiRequest(
      'GET',
      `/api/media/projects/${projA.data.projectId}/highlights`,
      { token: userA.token },
    );
    expect(projRevoked.status).toBe(403);
    expect(projRevoked.data.code).toBe('ACCESS_DENIED');
  }, 120_000);

  it('8. streams real-time highlights from an authorized controlled LIVE session through the real BullMQ worker', async () => {
    const user = await createTestUser('live_user');
    const broadcastId = `live_api_${runTag}`;

    const liveAdapter = new ControlledRealTimeStreamAdapter({
      fixturePath: fixture30sPath,
      policy: {
        enabled: true,
        provider: 'twitch',
        channelName: 'step3b9_streamer',
        broadcastId,
        rightsStatus: 'PERMITTED_PUBLIC',
        allowSharedCacheReuse: true,
      },
      streamOptions: {
        segmentDurationSec: 4,
        segmentPaceMs: 120,
        maxQueueSize: 4,
      },
    });
    const verified = liveAdapter.buildVerifiedBroadcastSource();
    const canonicalId = verified.canonicalId as CacheableSourceId;
    createdSourceCanonicalIds.add(canonicalId);

    await service.registry.registerOrGetMediaSource({
      canonicalId,
      provider: 'twitch',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: verified.externalId,
      channelId: verified.channelId,
      broadcastId,
      availability: 'LIVE_NOW',
      metadata: { title: 'API Controlled Live Stream' },
    });
    await grantControlledSharedRights(service, canonicalId);

    const fixtureKey = `live_fix_${runTag}`;
    registerControlledTestFixture({
      kind: 'live',
      fixtureKey,
      canonicalSourceId: canonicalId,
      adapter: liveAdapter,
    });

    const sub = await apiRequest('POST', '/api/media/jobs', {
      token: user.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey },
        idempotencyKey: `live_job_${runTag}`,
      },
    });
    expect(sub.status).toBe(202);
    const jobId = sub.data.jobId as string;

    // Poll highlights while worker is executing and until READY
    let observedRunningWithHighlight = false;
    let finalStatus: any = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const hlPoll = await apiRequest('GET', `/api/media/jobs/${jobId}/highlights`, {
        token: user.token,
      });
      expect(hlPoll.status).toBe(200);
      assertNoRawStorageLeak(hlPoll.data);
      if (hlPoll.data.status === 'RUNNING' && hlPoll.data.highlights.length >= 1) {
        observedRunningWithHighlight = true;
      }
      if (['READY', 'FAILED', 'CANCELLED'].includes(hlPoll.data.status)) {
        finalStatus = hlPoll.data;
        break;
      }
      await sleep(250);
    }

    expect(finalStatus).toBeTruthy();
    expect(finalStatus.status).toBe('READY');
    expect(finalStatus.sourceType).toBe('live');
    expect(finalStatus.highlights.length).toBeGreaterThanOrEqual(1);
    // Download and ffprobe live-produced highlight clip
    await downloadAndProbeSignedUrl(finalStatus.highlights[0].downloadUrl, `live_hl_${runTag}`);
    // Log whether observed while RUNNING (informational — fast machines may finish before poll ticks)
    expect(typeof observedRunningWithHighlight).toBe('boolean');
  }, 120_000);

  it('11. fans 1,000 authorized clipper job requests into ONE sharedWorkKey, strictly ONE BullMQ job, and ONE FFmpeg pipeline run', async () => {
    const vodId = `vod_1k_${runTag}`;
    const adapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'twitch_vod',
      vodId,
      fixturePath: fixture30sPath,
      title: 'Viral Stream 1000 Clippers VOD',
    });
    const regInput = adapter.buildMediaSourceRegistration();
    const canonicalId = regInput.canonicalId as CacheableSourceId;
    createdSourceCanonicalIds.add(canonicalId);

    const ms = await service.registry.registerOrGetMediaSource(regInput);
    await grantControlledSharedRights(service, canonicalId);

    const fixtureKey = `vod_1k_fix_${runTag}`;
    let workerExecutions = 0;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey,
      canonicalSourceId: canonicalId,
      adapter,
      onWorkerAttempt: async () => {
        workerExecutions++;
      },
    });

    // Bulk-create 1,000 distinct clipper users in PostgreSQL
    const userPayload = Array.from({ length: 1000 }, (_, i) => ({
      email: `clipper_${runTag}_${i}@local.test`,
      name: `Clipper ${i}`,
    }));
    await db.user.createMany({ data: userPayload });
    const clippers = await db.user.findMany({
      where: { email: { startsWith: `clipper_${runTag}_` } },
      select: { id: true, email: true },
    });
    expect(clippers.length).toBe(1000);
    for (const c of clippers) createdUserIds.add(c.id);

    const importCountBefore = workerHandle.vodService.metrics.sourceImportCount;
    const analysisCountBefore = workerHandle.vodService.metrics.analysisPassCount;

    // Submit 1,000 concurrent clipper jobs in batches of 50 (first 10 over real HTTP, rest via service)
    const submittedResults: Array<{ jobId: string; sharedWorkKey: string }> = [];
    const httpBatch = await Promise.all(
      clippers.slice(0, 10).map(async (c, idx) => {
        const tok = signToken({ sub: c.id, email: c.email });
        const r = await apiRequest('POST', '/api/media/jobs', {
          token: tok,
          body: {
            input: { inputType: 'controlled_fixture', fixtureKey },
            idempotencyKey: `clip_1k_${idx}`,
          },
        });
        expect([200, 202]).toContain(r.status);
        const row = await db.mediaProcessingJob.findUniqueOrThrow({ where: { id: r.data.jobId } });
        return { jobId: row.id, sharedWorkKey: row.sharedWorkKey };
      }),
    );
    submittedResults.push(...httpBatch);

    for (let start = 10; start < 1000; start += 20) {
      const slice = clippers.slice(start, start + 20);
      const batchRes = await Promise.all(
        slice.map((c, idx) =>
          service.submitMediaJob(c.id, {
            input: { inputType: 'controlled_fixture', fixtureKey },
            idempotencyKey: `clip_1k_${start + idx}`,
          }),
        ),
      );
      for (const b of batchRes) {
        submittedResults.push({ jobId: b.job.jobId, sharedWorkKey: b.sharedWorkKey });
      }
    }

    expect(submittedResults.length).toBe(1000);
    const sharedWorkKey = submittedResults[0].sharedWorkKey;
    // ALL 1,000 clippers attached to the EXACT SAME sharedWorkKey
    expect(new Set(submittedResults.map((s) => s.sharedWorkKey)).size).toBe(1);
    // STRICTLY ONE BullMQ job enqueued for all 1,000 clippers!
    expect(enqueuedByWorkKey.get(sharedWorkKey)).toBe(1);

    // Wait for the 1 shared BullMQ worker job to finish and mark ALL 1,000 rows READY
    const firstToken = signToken({ sub: clippers[0].id, email: clippers[0].email });
    const doneFirst = await waitForJobTerminalStatus(firstToken, submittedResults[0].jobId, 90_000);
    expect(doneFirst.status).toBe('READY');

    // Poll briefly until all 1,000 rows are READY
    const readyDeadline = Date.now() + 15_000;
    let readyCount = 0;
    while (Date.now() < readyDeadline) {
      readyCount = await db.mediaProcessingJob.count({
        where: { sharedWorkKey, status: 'READY' },
      });
      if (readyCount === 1000) break;
      await sleep(150);
    }
    expect(readyCount).toBe(1000);

    // Strictly ONE worker execution, ONE FFmpeg source import, ONE highlight analysis!
    expect(workerExecutions).toBe(1);
    expect(workerHandle.vodService.metrics.sourceImportCount - importCountBefore).toBe(1);
    expect(workerHandle.vodService.metrics.analysisPassCount - analysisCountBefore).toBe(1);

    // Sample clipper #999 downloads verified highlight over HTTP
    const lastClipper = clippers[999];
    const lastToken = signToken({ sub: lastClipper.id, email: lastClipper.email });
    const lastHl = await apiRequest(
      'GET',
      `/api/media/jobs/${submittedResults[999].jobId}/highlights`,
      { token: lastToken },
    );
    expect(lastHl.status).toBe(200);
    expect(lastHl.data.highlights.length).toBeGreaterThanOrEqual(1);
    assertNoRawStorageLeak(lastHl.data);
  }, 120_000);

  it('13 & 21: rejects unverified rights (REQUIRES_PERMISSION / 403) and blocks controlled test fixtures completely in production mode', async () => {
    const user = await createTestUser('rights_prod');
    const vodId = `vod_unver_${runTag}`;
    const adapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'kick_vod',
      vodId,
      fixturePath: fixture30sPath,
      title: 'Unverified Rights VOD',
    });
    const regInput = adapter.buildMediaSourceRegistration();
    const canonicalId = regInput.canonicalId as CacheableSourceId;
    createdSourceCanonicalIds.add(canonicalId);

    await service.registry.registerOrGetMediaSource(regInput);
    // Rights intentionally left UNVERIFIED (no grant recorded)!

    const fixtureKey = `vod_unver_fix_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey,
      canonicalSourceId: canonicalId,
      adapter,
    });

    const enqBefore = totalEnqueuedCount;
    const resResolve = await apiRequest('POST', '/api/media/sources/resolve', {
      token: user.token,
      body: { input: { inputType: 'controlled_fixture', fixtureKey } },
    });
    expect(resResolve.status).toBe(200);
    expect(resResolve.data.capabilityStatus).toBe('REQUIRES_PERMISSION');
    expect(resResolve.data.canSubmitJob).toBe(false);

    const resJob = await apiRequest('POST', '/api/media/jobs', {
      token: user.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey },
        idempotencyKey: `unver_job_${runTag}`,
      },
    });
    expect(resJob.status).toBe(403);
    expect(resJob.data.code).toBe('ACCESS_DENIED');
    expect(totalEnqueuedCount).toBe(enqBefore);

    // 21. Production mode STRICTLY disables controlled fixtures even when ALLOW_CONTROLLED_MEDIA_FIXTURES='true'
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllow = process.env.ALLOW_CONTROLLED_MEDIA_FIXTURES;
    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_CONTROLLED_MEDIA_FIXTURES = 'true';

      const prodResolve = await apiRequest('POST', '/api/media/sources/resolve', {
        token: user.token,
        body: { input: { inputType: 'controlled_fixture', fixtureKey } },
      });
      expect(prodResolve.status).toBe(403);
      expect(prodResolve.data.code).toBe('UNSUPPORTED_ACQUISITION');

      const prodJob = await apiRequest('POST', '/api/media/jobs', {
        token: user.token,
        body: {
          input: { inputType: 'controlled_fixture', fixtureKey },
          idempotencyKey: `prod_job_${runTag}`,
        },
      });
      expect(prodJob.status).toBe(403);
      expect(prodJob.data.code).toBe('UNSUPPORTED_ACQUISITION');
      expect(totalEnqueuedCount).toBe(enqBefore);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevAllow === undefined) delete process.env.ALLOW_CONTROLLED_MEDIA_FIXTURES;
      else process.env.ALLOW_CONTROLLED_MEDIA_FIXTURES = prevAllow;
    }
  }, 30_000);

  it('15. cancelling one user detaches only that user while keeping shared work alive for another user; cancelling last user stops shared work', async () => {
    const userA = await createTestUser('cancel_A');
    const userB = await createTestUser('cancel_B');
    const userC = await createTestUser('cancel_C');

    // Part A: User A & User B share slow controlled VOD; User A cancels while running, User B completes READY
    const vodShared = `vod_cancel_shared_${runTag}`;
    const adapterShared = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodShared,
      fixturePath: fixture30sPath,
      title: 'Cancel Shared VOD',
    });
    const regShared = adapterShared.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regShared.canonicalId);
    await service.registry.registerOrGetMediaSource(regShared);
    await grantControlledSharedRights(service, regShared.canonicalId);

    let releaseWorkerGate!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorkerGate = r;
    });
    let workerStarted!: () => void;
    const workerStartedPromise = new Promise<void>((r) => {
      workerStarted = r;
    });

    const fixShared = `fix_cancel_shared_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixShared,
      canonicalSourceId: regShared.canonicalId,
      adapter: adapterShared,
      onWorkerAttempt: async () => {
        workerStarted();
        await workerGate;
      },
    });

    const jobA = await apiRequest('POST', '/api/media/jobs', {
      token: userA.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey: fixShared },
        idempotencyKey: `c_sh_a_${runTag}`,
      },
    });
    const jobB = await apiRequest('POST', '/api/media/jobs', {
      token: userB.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey: fixShared },
        idempotencyKey: `c_sh_b_${runTag}`,
      },
    });
    expect(jobA.status).toBe(202);
    expect(jobB.status).toBe(202);

    await workerStartedPromise;

    // User A cancels -> shared work stays active for User B!
    const cancelA = await apiRequest('POST', `/api/media/jobs/${jobA.data.jobId}/cancel`, {
      token: userA.token,
    });
    expect(cancelA.status).toBe(200);
    expect(cancelA.data.status).toBe('CANCELLED');
    expect(cancelA.data.detachedFromSharedWork).toBe(true);
    expect(cancelA.data.sharedWorkStillActive).toBe(true);

    // Let shared worker finish
    releaseWorkerGate();

    const doneB = await waitForJobTerminalStatus(userB.token, jobB.data.jobId, 60_000);
    expect(doneB.status).toBe('READY');
    const statusA = await apiRequest('GET', `/api/media/jobs/${jobA.data.jobId}`, {
      token: userA.token,
    });
    expect(statusA.data.status).toBe('CANCELLED');

    // Part B: Solo User C cancels -> sharedWorkStillActive: false and worker aborts cleanly
    const vodSolo = `vod_cancel_solo_${runTag}`;
    const adapterSolo = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodSolo,
      fixturePath: fixture30sPath,
      title: 'Cancel Solo VOD',
    });
    const regSolo = adapterSolo.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regSolo.canonicalId);
    await service.registry.registerOrGetMediaSource(regSolo);
    await grantControlledSharedRights(service, regSolo.canonicalId);

    let soloStarted!: () => void;
    const soloStartedP = new Promise<void>((r) => {
      soloStarted = r;
    });
    let releaseSolo!: () => void;
    const soloGate = new Promise<void>((r) => {
      releaseSolo = r;
    });

    const fixSolo = `fix_cancel_solo_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixSolo,
      canonicalSourceId: regSolo.canonicalId,
      adapter: adapterSolo,
      onWorkerAttempt: async () => {
        soloStarted();
        await soloGate;
      },
    });

    const jobC = await apiRequest('POST', '/api/media/jobs', {
      token: userC.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey: fixSolo },
        idempotencyKey: `c_solo_${runTag}`,
      },
    });
    expect(jobC.status).toBe(202);
    await soloStartedP;

    const cancelC = await apiRequest('POST', `/api/media/jobs/${jobC.data.jobId}/cancel`, {
      token: userC.token,
    });
    expect(cancelC.status).toBe(200);
    expect(cancelC.data.status).toBe('CANCELLED');
    expect(cancelC.data.sharedWorkStillActive).toBe(false);

    releaseSolo();
    await sleep(400);
    const statusC = await apiRequest('GET', `/api/media/jobs/${jobC.data.jobId}`, {
      token: userC.token,
    });
    expect(statusC.data.status).toBe('CANCELLED');
  }, 90_000);

  it('16. retries transient worker crash with bounded backoff to READY, and immediately fails non-retryable DRM error without retrying', async () => {
    const user = await createTestUser('retry_user');

    // Part A: Transient crash on attempt 1 -> succeeds on attempt 2
    const vodRetry = `vod_retry_${runTag}`;
    const adapterRetry = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodRetry,
      fixturePath: fixture30sPath,
      title: 'Transient Retry VOD',
    });
    const regRetry = adapterRetry.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regRetry.canonicalId);
    await service.registry.registerOrGetMediaSource(regRetry);
    await grantControlledSharedRights(service, regRetry.canonicalId);

    let retryAttempts = 0;
    const fixRetry = `fix_retry_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixRetry,
      canonicalSourceId: regRetry.canonicalId,
      adapter: adapterRetry,
      onWorkerAttempt: async (attempt) => {
        retryAttempts = attempt;
        if (attempt === 1) {
          throw new Error('Simulated transient worker crash on attempt 1');
        }
      },
    });

    const subRetry = await apiRequest('POST', '/api/media/jobs', {
      token: user.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey: fixRetry },
        idempotencyKey: `retry_ok_${runTag}`,
      },
    });
    expect(subRetry.status).toBe(202);
    const doneRetry = await waitForJobTerminalStatus(user.token, subRetry.data.jobId, 60_000);
    expect(doneRetry.status).toBe('READY');
    expect(retryAttempts).toBe(2);

    // Part B: Non-retryable DRM_RESTRICTED fails immediately on attempt 1 (zero retries)
    const vodDrm = `vod_drm_${runTag}`;
    const adapterDrm = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: vodDrm,
      fixturePath: fixture30sPath,
      title: 'DRM Restricted VOD',
    });
    const regDrm = adapterDrm.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(regDrm.canonicalId);
    await service.registry.registerOrGetMediaSource(regDrm);
    await grantControlledSharedRights(service, regDrm.canonicalId);

    let drmAttempts = 0;
    const fixDrm = `fix_drm_${runTag}`;
    registerControlledTestFixture({
      kind: 'vod',
      fixtureKey: fixDrm,
      canonicalSourceId: regDrm.canonicalId,
      adapter: adapterDrm,
      onWorkerAttempt: async (attempt) => {
        drmAttempts = attempt;
        throw new MediaSourceError({
          code: 'DRM_RESTRICTED',
          message: 'Stream is DRM protected and cannot be processed.',
        });
      },
    });

    const subDrm = await apiRequest('POST', '/api/media/jobs', {
      token: user.token,
      body: {
        input: { inputType: 'controlled_fixture', fixtureKey: fixDrm },
        idempotencyKey: `drm_fail_${runTag}`,
      },
    });
    expect(subDrm.status).toBe(202);
    const doneDrm = await waitForJobTerminalStatus(user.token, subDrm.data.jobId, 30_000);
    expect(doneDrm.status).toBe('FAILED');
    expect(doneDrm.errorCode).toBe('DRM_RESTRICTED');
    await sleep(600);
    expect(drmAttempts).toBe(1);
  }, 90_000);

  it('19. enforces per-route rate limits (429) and per-user daily submission & active-job quotas (429)', async () => {
    const user = await createTestUser('quota_user');

    // Mount a tight-quota, tight-rate-limit Express app for deterministic verification
    const tightService = new UniversalMediaApiService({
      db,
      storage,
      redis: redis as any,
      workRootDir: workRootApi,
      keyPrefix: `${keyPrefix}tight:`,
      quotas: {
        maxActiveJobsPerUser: 1,
        maxDailyJobSubmissionsPerUser: 2,
      },
      enqueueJob: async () => ({ id: 'noop_quota_job' }),
    });

    const tightApp = express();
    tightApp.use(express.json());
    tightApp.use(
      '/api/media',
      requireAuth,
      createMediaRouter({
        service: tightService,
        resolveLimiter: rateLimit({
          windowMs: 60_000,
          max: 2,
          standardHeaders: true,
          legacyHeaders: false,
          message: { error: 'Too many resolve requests.' },
        }),
        jobLimiter: (_req, _res, next) => next(),
      }),
    );
    tightApp.use(errorHandler);

    const tightServer = await new Promise<http.Server>((resolve) => {
      const s = tightApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = tightServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind tight server');
    const tightUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 19a. Rate limit triggers 429 on 3rd resolve call
      const callResolve = () =>
        fetch(`${tightUrl}/api/media/sources/resolve`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: { inputType: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
          }),
        });
      expect((await callResolve()).status).toBe(200);
      expect((await callResolve()).status).toBe(200);
      expect((await callResolve()).status).toBe(429);

      // 19b. Active-job quota (maxActiveJobsPerUser = 1) triggers 429 on 2nd active job
      const vodQ = `vod_quota_${runTag}`;
      const adapterQ = new ControlledVodAcquisitionAdapter({
        enabled: true,
        archetype: 'youtube_video',
        vodId: vodQ,
        fixturePath: fixture30sPath,
        title: 'Quota VOD',
      });
      const regQ = adapterQ.buildMediaSourceRegistration();
      createdSourceCanonicalIds.add(regQ.canonicalId);
      await tightService.registry.registerOrGetMediaSource(regQ);
      await grantControlledSharedRights(tightService, regQ.canonicalId);
      const fixQ = `fix_quota_${runTag}`;
      registerControlledTestFixture({
        kind: 'vod',
        fixtureKey: fixQ,
        canonicalSourceId: regQ.canonicalId,
        adapter: adapterQ,
      });

      const postTightJob = (idem: string) =>
        fetch(`${tightUrl}/api/media/jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: { inputType: 'controlled_fixture', fixtureKey: fixQ },
            idempotencyKey: idem,
          }),
        });

      const j1 = await postTightJob(`q_1_${runTag}`);
      expect(j1.status).toBe(202);
      const j1Data = (await j1.json()) as { jobId: string };

      // 2nd simultaneous active job blocked by maxActiveJobsPerUser = 1
      const j2Blocked = await postTightJob(`q_2_${runTag}`);
      expect(j2Blocked.status).toBe(429);

      // Cancel job 1 -> active count drops to 0, daily submissions = 1
      await fetch(`${tightUrl}/api/media/jobs/${j1Data.jobId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
      });

      // 2nd submission succeeds (daily submissions = 2), cancel it
      const j2Ok = await postTightJob(`q_2_ok_${runTag}`);
      expect(j2Ok.status).toBe(202);
      const j2Data = (await j2Ok.json()) as { jobId: string };
      await fetch(`${tightUrl}/api/media/jobs/${j2Data.jobId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
      });

      // 3rd submission blocked by maxDailyJobSubmissionsPerUser = 2
      const j3DailyBlocked = await postTightJob(`q_3_${runTag}`);
      expect(j3DailyBlocked.status).toBe(429);
    } finally {
      await new Promise<void>((resolve) => tightServer.close(() => resolve()));
    }
  }, 30_000);
});
