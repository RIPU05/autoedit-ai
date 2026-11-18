import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { CacheableSourceId, PrivateRenderQueuePayload } from '@autoedit/contracts';
import {
  ensureControlledLiveFixture,
  ControlledVodAcquisitionAdapter,
  probeAndValidateClipMp4,
  UniversalMediaApiService,
  PrivateRenderService,
  buildPrivateRenderBullJobId,
} from '../../src/media/index.js';
import { createMediaRouter } from '../../src/routes/media.routes.js';
import { createProjectRouter } from '../../src/routes/projects.routes.js';
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

function assertNoRawStorageLeak(payload: unknown): void {
  const raw = JSON.stringify(payload);
  expect(raw).not.toContain('"s3Key"');
  expect(raw).not.toContain('"objectKey"');
  expect(raw).not.toContain('"publishedObjectKey"');
  expect(raw).not.toContain('"outputObjectKey"');
  expect(raw).not.toContain('"bucket"');
  // Strip signed S3 URL fields before checking for leaked raw path substrings in metadata/errors
  const withoutSignedUrls = raw.replace(/"(downloadUrl|url)":"https?:\/\/[^"]+"/g, '"$1":"[signed]"');
  expect(withoutSignedUrls).not.toContain('private/users/');
  expect(withoutSignedUrls).not.toContain('autoedit-local/media-cache');
}

describe('Step 3C.1.1: Verified Source Previews, Background Private Rendering & Resource Controls', () => {
  const db = new PrismaClient({ datasources: { db: { url: LOCAL_DB_URL } } });
  const dbWorker = new PrismaClient({ datasources: { db: { url: LOCAL_DB_URL } } });
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

  const runTag = `3c11_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const queueName = `priv-render-3c11-${runTag}`;
  const keyPrefix = `autoedit:test:${runTag}:`;
  const fixture30sPath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
  const workRoot = path.resolve(process.cwd(), 'tmp', `step3c11-${runTag}`);

  const createdUserIds = new Set<string>();
  const createdSourceCanonicalIds = new Set<string>();
  const createdStorageKeys = new Set<string>();

  let privQueue: Queue<PrivateRenderQueuePayload>;
  let privWorkerHandle: ReturnType<typeof createPrivateRenderWorker>;
  let service: UniversalMediaApiService;
  let server: http.Server;
  let baseUrl = '';
  let privateEnqueueCount = 0;

  // Test-only dynamic hook for simulating slow renders or cancellation inside real BullMQ worker
  let activeBeforeRenderHook:
    | ((ctx: {
        renderJobId: string;
        generation: number;
        ownerToken: string;
        workerId: string;
        signal: AbortSignal;
      }) => Promise<void>)
    | null = null;

  async function createTestUser(suffix: string) {
    const user = await db.user.create({
      data: {
        email: `${runTag}_${suffix}@local.test`,
        name: `User ${suffix}`,
      },
    });
    createdUserIds.add(user.id);
    const token = signToken({ sub: user.id, email: user.email });
    return { user, token };
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

  async function seedPublishedSharedVod(vodSuffix: string, ownerUserId: string) {
    const adapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_completed_live_vod',
      vodId: `${runTag}_${vodSuffix}`,
      fixturePath: fixture30sPath,
      title: `Controlled VOD ${vodSuffix}`,
    });
    const regInput = adapter.buildMediaSourceRegistration();
    const canonicalId = regInput.canonicalId as CacheableSourceId;
    createdSourceCanonicalIds.add(canonicalId);

    const ms = await service.registry.registerOrGetMediaSource(regInput);
    await service.registry.grantSourceRights({
      canonicalSourceId: canonicalId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      rightsStatus: 'PERMITTED_PUBLIC',
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3c11',
    });

    const src = await service.vodService.acquireOrReuseVodSource({
      adapter,
      requesterUserId: ownerUserId,
      workerId: `seed_${runTag}`,
      rightsScope: 'SHARED_PERMITTED',
    });
    createdStorageKeys.add(src.objectKey);

    const ana = await service.vodService.analyzeOrReuseVodHighlights({
      canonicalSourceId: canonicalId,
      sourceDescriptor: src.descriptor,
      requesterUserId: ownerUserId,
      workerId: `seed_${runTag}`,
      rightsScope: 'SHARED_PERMITTED',
      enableLocalWhisper: false,
    });

    const clip = await service.vodService.generateOrReuseVodBaseClip({
      canonicalSourceId: canonicalId,
      sourceDescriptor: src.descriptor,
      candidate: ana.candidates[0],
      requesterUserId: ownerUserId,
      workerId: `seed_${runTag}`,
      rightsScope: 'SHARED_PERMITTED',
    });
    createdStorageKeys.add(clip.objectKey);

    const session = await service.vodService.createPrivateEditingSessionFromVod({
      requesterUserId: ownerUserId,
      canonicalSourceId: canonicalId,
      title: `Private Session ${vodSuffix}`,
      candidates: ana.candidates,
    });

    return { ms, canonicalId, src, clip, session };
  }

  async function waitForPrivateRenderTerminal(
    token: string,
    projectId: string,
    renderJobId: string,
    timeoutMs = 60_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await apiRequest(
        'GET',
        `/api/media/projects/${projectId}/renders/${renderJobId}`,
        { token },
      );
      expect(res.status).toBe(200);
      assertNoRawStorageLeak(res.data);
      if (['READY', 'FAILED', 'CANCELLED'].includes(res.data.status)) {
        return res.data;
      }
      await sleep(200);
    }
    throw new Error(`Timed out waiting for private render ${renderJobId}`);
  }

  beforeAll(async () => {
    expect(await redis.ping()).toBe('PONG');
    expect((await storage.checkHealth()).ok).toBe(true);
    await db.$queryRaw`SELECT 1`;
    await fs.mkdir(workRoot, { recursive: true });

    await ensureControlledLiveFixture(fixture30sPath, {
      durationSec: 30,
      spikeStartSec: 16,
      spikeEndSec: 19,
    });

    privQueue = new Queue<PrivateRenderQueuePayload>(queueName, {
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
      workRootDir: path.join(workRoot, 'api'),
      keyPrefix,
      privateRenderPolicy: {
        maxActiveRendersPerUser: 2,
        maxDailyRendersPerUser: 20,
        maxQueuedGlobalRenders: 50,
        maxOutputDurationSec: 180,
        downloadUrlTtlSec: 300,
        leaseMs: 15_000,
      },
      enqueuePrivateRenderJob: async (payload, opts) => {
        privateEnqueueCount++;
        const job = await privQueue.add('private-render', payload, {
          jobId: opts?.jobId ?? buildPrivateRenderBullJobId(payload.renderJobId, payload.generation),
          attempts: 3,
          backoff: { type: 'fixed', delay: 300 },
        });
        return { id: job.id };
      },
    });

    privWorkerHandle = createPrivateRenderWorker({
      queueName,
      db: dbWorker,
      storage,
      redis: redis as any,
      bullConnection,
      workRootDir: path.join(workRoot, 'worker'),
      keyPrefix: `${keyPrefix}priv_render:`,
      concurrency: 2,
      leaseMs: 15_000,
      reconcileIntervalMs: 0,
      enqueueRecoveryJob: async (payload, opts) => {
        privateEnqueueCount++;
        const job = await privQueue.add('private-render', payload, {
          jobId: opts?.jobId ?? buildPrivateRenderBullJobId(payload.renderJobId, payload.generation),
          attempts: 3,
          backoff: { type: 'fixed', delay: 300 },
        });
        return { id: job.id };
      },
      onBeforeRender: async (ctx) => {
        if (activeBeforeRenderHook) {
          await activeBeforeRenderHook(ctx);
        }
      },
    });
    await privWorkerHandle.worker.waitUntilReady();

    const noopLimiter: express.RequestHandler = (_req, _res, next) => next();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/projects', createProjectRouter({ db, storage }));
    app.use(
      '/api/media',
      requireAuth,
      createMediaRouter({ service, resolveLimiter: noopLimiter, jobLimiter: noopLimiter }),
    );
    app.use(errorHandler);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind server');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 90_000);

  afterAll(async () => {
    activeBeforeRenderHook = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (privWorkerHandle) await privWorkerHandle.worker.close().catch(() => {});
    if (privQueue) {
      await privQueue.obliterate({ force: true }).catch(() => {});
      await privQueue.close().catch(() => {});
    }

    if (createdUserIds.size > 0) {
      const privRenders = await db.privateRenderJob.findMany({
        where: { userId: { in: [...createdUserIds] } },
      });
      for (const r of privRenders) {
        if (r.outputObjectKey) createdStorageKeys.add(r.outputObjectKey);
      }
      await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } }).catch(() => {});
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
      await db.mediaSource
        .deleteMany({ where: { canonicalId: { in: [...createdSourceCanonicalIds] } } })
        .catch(() => {});
    }
    for (const key of createdStorageKeys) {
      await storage.deleteObject({ key }).catch(() => {});
    }
    const rKeys = await redis.keys(`${keyPrefix}*`);
    if (rKeys.length > 0) await redis.del(...rKeys).catch(() => {});
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
    await db.$disconnect();
    await dbWorker.$disconnect();
  }, 90_000);

  it('Scenarios 1–7: enforces verified SOURCE_MEDIA preview (never substituting BASE_CLIP), rejects revoked/missing/corrupt/expired/stale artifacts, preserves private upload preview, and blocks cross-user access', async () => {
    const owner = await createTestUser('preview_owner');
    const other = await createTestUser('preview_other');

    const { ms, canonicalId, src, session } = await seedPublishedSharedVod('preview_vod', owner.user.id);

    // Scenario 1: Correct SOURCE_MEDIA selection returns short-lived signed URL for FULL source (~30s)
    const okPreview = await apiRequest(
      'GET',
      `/api/projects/${session.projectId}/source-url?key=forged/evil/key.mp4`,
      { token: owner.token },
    );
    expect(okPreview.status).toBe(200);
    expect(okPreview.data.sourceKind).toBe('SOURCE_MEDIA');
    expect(okPreview.data.expiresInSec).toBe(300);
    expect(okPreview.data.sourceRevision).toBe(ms.sourceRevision);
    expect(okPreview.data.publishedGeneration).toBeGreaterThanOrEqual(1);
    expect(okPreview.data.url).toBeTruthy();
    assertNoRawStorageLeak(okPreview.data);

    // Download & probe preview URL -> confirms full 30s SOURCE_MEDIA (not 10s BASE_CLIP!)
    const srcResp = await fetch(okPreview.data.url);
    expect(srcResp.status).toBe(200);
    const srcBuf = Buffer.from(await srcResp.arrayBuffer());
    const probeFile = path.join(workRoot, 'verified-source-preview.mp4');
    await fs.writeFile(probeFile, srcBuf);
    const probed = await probeAndValidateClipMp4(probeFile);
    expect(probed.durationSec).toBeGreaterThanOrEqual(25);

    // Scenario 7: Cross-user project denial (User B gets 404 on project detail & source-url)
    const crossDetail = await apiRequest('GET', `/api/projects/${session.projectId}`, {
      token: other.token,
    });
    expect(crossDetail.status).toBe(404);
    const crossPreview = await apiRequest('GET', `/api/projects/${session.projectId}/source-url`, {
      token: other.token,
    });
    expect(crossPreview.status).toBe(404);

    // Also verify GET /api/projects/:id never leaks raw sourceAsset.s3Key!
    const ownDetail = await apiRequest('GET', `/api/projects/${session.projectId}`, {
      token: owner.token,
    });
    expect(ownDetail.status).toBe(200);
    assertNoRawStorageLeak(ownDetail.data);

    // Scenario 5a: Expired SOURCE_MEDIA artifact rejected with 404 (NEVER falls back to BASE_CLIP!)
    const sourceArt = await db.sharedCacheArtifact.findUniqueOrThrow({
      where: { cacheKey: src.cacheKey },
    });
    await db.sharedCacheArtifact.update({
      where: { id: sourceArt.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expiredRes = await apiRequest('GET', `/api/projects/${session.projectId}/source-url`, {
      token: owner.token,
    });
    expect(expiredRes.status).toBe(404);
    expect(expiredRes.data.code).toBe('SOURCE_UNAVAILABLE');
    assertNoRawStorageLeak(expiredRes.data);

    // Restore expiry, then test Scenario 5b: stale sourceRevision mismatch rejected (NEVER serves v1 when source is v2!)
    await db.sharedCacheArtifact.update({
      where: { id: sourceArt.id },
      data: { expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await db.mediaSource.update({
      where: { id: ms.id },
      data: { sourceRevision: 'v2' },
    });
    const staleRevRes = await apiRequest('GET', `/api/projects/${session.projectId}/source-url`, {
      token: owner.token,
    });
    expect(staleRevRes.status).toBe(404);
    await db.mediaSource.update({
      where: { id: ms.id },
      data: { sourceRevision: 'v1' },
    });

    // Scenario 4a: Corrupt SOURCE_MEDIA object in MinIO (overwritten with truncated/garbage bytes) -> 502 ARTIFACT_CORRUPT!
    const origBytes = await fs.readFile(fixture30sPath);
    await storage.putObject({
      key: src.objectKey,
      body: Buffer.from('corrupt-truncated-bytes'),
      contentType: 'video/mp4',
    });
    const corruptRes = await apiRequest('GET', `/api/projects/${session.projectId}/source-url`, {
      token: owner.token,
    });
    expect(corruptRes.status).toBe(502);
    expect(corruptRes.data.code).toBe('ARTIFACT_CORRUPT');
    assertNoRawStorageLeak(corruptRes.data);

    // Scenario 4b: Missing SOURCE_MEDIA object in MinIO -> 404 SOURCE_UNAVAILABLE (NEVER leaks publishedObjectKey!)
    await storage.deleteObject({ key: src.objectKey });
    const missingRes = await apiRequest('GET', `/api/projects/${session.projectId}/source-url`, {
      token: owner.token,
    });
    expect(missingRes.status).toBe(404);
    expect(missingRes.data.code).toBe('SOURCE_UNAVAILABLE');
    expect(JSON.stringify(missingRes.data)).not.toContain(src.objectKey);

    // Restore valid MinIO object for next checks
    await storage.putObject({
      key: src.objectKey,
      body: origBytes,
      contentType: 'video/mp4',
    });

    // Scenario 2: When ONLY BASE_CLIP exists (SOURCE_MEDIA removed/not retained), /source-url MUST return 404 (NEVER substitute BASE_CLIP!)
    await db.sharedCacheArtifact.update({
      where: { id: sourceArt.id },
      data: { state: 'EXPIRED' },
    });
    const noFullSourceRes = await apiRequest('GET', `/api/projects/${session.projectId}/source-url`, {
      token: owner.token,
    });
    expect(noFullSourceRes.status).toBe(404);
    expect(noFullSourceRes.data.code).toBe('SOURCE_UNAVAILABLE');
    // Meanwhile highlight clips ARE still independently served via /api/media/projects/:id/highlights!
    const hlStillOk = await apiRequest('GET', `/api/media/projects/${session.projectId}/highlights`, {
      token: owner.token,
    });
    expect(hlStillOk.status).toBe(200);
    expect(hlStillOk.data.highlights.length).toBeGreaterThanOrEqual(1);

    // Restore PUBLISHED state, then test Scenario 3: Revoked source rights -> 403!
    await db.sharedCacheArtifact.update({
      where: { id: sourceArt.id },
      data: { state: 'PUBLISHED' },
    });
    await service.registry.revokeSourceRights({
      canonicalSourceId: canonicalId,
      revokedReason: 'Creator revoked VOD rights',
    });
    const revokedRes = await apiRequest('GET', `/api/projects/${session.projectId}/source-url`, {
      token: owner.token,
    });
    expect(revokedRes.status).toBe(403);
    assertNoRawStorageLeak(revokedRes.data);

    // Scenario 6: Private upload project (`sourceAsset`) verified access + cross-user denial + missing object rejection
    const upKey = `uploads/${runTag}/${owner.user.id}/private-upload.mp4`;
    await storage.putObject({ key: upKey, body: origBytes, contentType: 'video/mp4' });
    createdStorageKeys.add(upKey);
    const asset = await db.asset.create({
      data: {
        kind: 'SOURCE_VIDEO',
        s3Key: upKey,
        bucket: MINIO_BUCKET,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(origBytes.length),
        durationSec: 30,
        width: 1280,
        height: 720,
      },
    });
    const uploadProj = await db.project.create({
      data: {
        userId: owner.user.id,
        title: 'Private Upload Project',
        status: 'UPLOADED',
        sourceAssetId: asset.id,
      },
    });

    const uploadPreview = await apiRequest('GET', `/api/projects/${uploadProj.id}/source-url`, {
      token: owner.token,
    });
    expect(uploadPreview.status).toBe(200);
    expect(uploadPreview.data.sourceKind).toBe('PRIVATE_UPLOAD');
    expect(uploadPreview.data.expiresInSec).toBe(300);
    assertNoRawStorageLeak(uploadPreview.data);

    const uploadDetail = await apiRequest('GET', `/api/projects/${uploadProj.id}`, {
      token: owner.token,
    });
    expect(uploadDetail.status).toBe(200);
    assertNoRawStorageLeak(uploadDetail.data);

    const otherUploadPreview = await apiRequest('GET', `/api/projects/${uploadProj.id}/source-url`, {
      token: other.token,
    });
    expect(otherUploadPreview.status).toBe(404);

    // Corrupt upload size in MinIO -> 502 ARTIFACT_CORRUPT
    await storage.putObject({ key: upKey, body: Buffer.from('short'), contentType: 'video/mp4' });
    const corruptUpload = await apiRequest('GET', `/api/projects/${uploadProj.id}/source-url`, {
      token: owner.token,
    });
    expect(corruptUpload.status).toBe(502);
    expect(corruptUpload.data.code).toBe('ARTIFACT_CORRUPT');
  }, 90_000);

  it('Scenarios 8, 9, 13, 14, 15, 16: enqueues async private render immediately (non-blocking under slow FFmpeg), deduplicates idempotent retries, validates output via ffprobe, isolates private outputs, refreshes signed URL, and blocks revoked downloads', async () => {
    const userA = await createTestUser('render_userA');
    const userB = await createTestUser('render_userB');

    const { canonicalId, session } = await seedPublishedSharedVod('async_render_vod', userA.user.id);

    // Simulate slow FFmpeg processing (2.5s delay in worker) -> HTTP POST MUST return 202 in < 1.5s!
    activeBeforeRenderHook = async () => {
      await sleep(2_500);
    };

    const enqBefore = privateEnqueueCount;
    const idemKey = `idem_async_${runTag}`;
    const t0 = Date.now();
    const [req1, req2] = await Promise.all([
      apiRequest('POST', `/api/media/projects/${session.projectId}/edits`, {
        token: userA.token,
        body: {
          mode: 'prompt',
          versionName: 'Async Slow Hype Cut',
          userPrompt: 'Tighten highlight with punchy zoom',
          windowStartSec: 12,
          windowEndSec: 20,
          effects: { subtitles: false, zooms: true, transitions: 'fade', music: false },
          renderOutput: true,
          idempotencyKey: idemKey,
        },
      }),
      apiRequest('POST', `/api/media/projects/${session.projectId}/edits`, {
        token: userA.token,
        body: {
          mode: 'prompt',
          versionName: 'Async Slow Hype Cut',
          userPrompt: 'Tighten highlight with punchy zoom',
          windowStartSec: 12,
          windowEndSec: 20,
          effects: { subtitles: false, zooms: true, transitions: 'fade', music: false },
          renderOutput: true,
          idempotencyKey: idemKey,
        },
      }),
    ]);
    const httpElapsedMs = Date.now() - t0;

    // Scenario 15: Non-blocking HTTP submission (fast 202/200 while 2.5s worker delay runs in background!)
    expect(httpElapsedMs).toBeLessThan(2_000);
    expect([200, 202]).toContain(req1.status);
    expect([200, 202]).toContain(req2.status);
    assertNoRawStorageLeak(req1.data);

    // Scenario 9: Exactly ONE EditVersion, ONE PrivateRenderJob, and ONE BullMQ enqueue!
    expect(req1.data.versionId).toBe(req2.data.versionId);
    expect(req1.data.renderJob.renderJobId).toBe(req2.data.renderJob.renderJobId);
    expect(privateEnqueueCount - enqBefore).toBe(1);

    const versionCount = await db.editVersion.count({ where: { projectId: session.projectId } });
    // 1 root version + 1 new edit version = 2 total (NOT 3!)
    expect(versionCount).toBe(2);
    const renderJobCount = await db.privateRenderJob.count({ where: { projectId: session.projectId } });
    expect(renderJobCount).toBe(1);

    const renderJobId = req1.data.renderJob.renderJobId as string;

    // Wait for background worker to finish & validate via real ffprobe (Scenario 13)
    const ready = await waitForPrivateRenderTerminal(userA.token, session.projectId, renderJobId, 60_000);
    activeBeforeRenderHook = null;
    expect(ready.status).toBe('READY');
    expect(ready.progressPercent).toBe(100);
    expect(ready.downloadUrl).toBeTruthy();
    expect(ready.downloadUrlExpiresInSec).toBe(300);

    const dlResp = await fetch(ready.downloadUrl);
    expect(dlResp.status).toBe(200);
    const dlBuf = Buffer.from(await dlResp.arrayBuffer());
    const outFile = path.join(workRoot, 'async-private-output.mp4');
    await fs.writeFile(outFile, dlBuf);
    const meta = await probeAndValidateClipMp4(outFile);
    expect(meta.durationSec).toBeGreaterThan(2);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);

    // Scenario 14: Private output isolation (stored under private/users/<userA>/..., User B gets 404!)
    const dbRow = await db.privateRenderJob.findUniqueOrThrow({ where: { id: renderJobId } });
    expect(dbRow.outputObjectKey?.startsWith(`private/users/${userA.user.id}/`)).toBe(true);

    const sneakStatus = await apiRequest(
      'GET',
      `/api/media/projects/${session.projectId}/renders/${renderJobId}`,
      { token: userB.token },
    );
    expect(sneakStatus.status).toBe(404);
    const sneakList = await apiRequest(
      'GET',
      `/api/media/projects/${session.projectId}/renders`,
      { token: userB.token },
    );
    expect(sneakList.status).toBe(404);
    const sneakCancel = await apiRequest(
      'POST',
      `/api/media/projects/${session.projectId}/renders/${renderJobId}/cancel`,
      { token: userB.token },
    );
    expect(sneakCancel.status).toBe(404);

    // Scenario 16: Signed URL refresh mints a fresh short-lived download URL without re-rendering!
    await sleep(1100);
    const refreshed = await apiRequest(
      'GET',
      `/api/media/projects/${session.projectId}/renders/${renderJobId}`,
      { token: userA.token },
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.data.downloadUrl).toBeTruthy();
    expect(refreshed.data.downloadUrl).not.toBe(ready.downloadUrl);
    expect((await fetch(refreshed.data.downloadUrl)).status).toBe(200);

    // Revoking source rights immediately blocks downloading previously rendered private clip too!
    await service.registry.revokeSourceRights({
      canonicalSourceId: canonicalId,
      revokedReason: 'Post-render revocation test',
    });
    const afterRevoke = await apiRequest(
      'GET',
      `/api/media/projects/${session.projectId}/renders/${renderJobId}`,
      { token: userA.token },
    );
    expect(afterRevoke.status).toBe(403);
  }, 90_000);

  it('Scenarios 11 & 12: cancels running private render cleanly and recovers crashed worker via bounded lease reconciliation', async () => {
    const user = await createTestUser('cancel_recover_user');
    const { session } = await seedPublishedSharedVod('cancel_recover_vod', user.user.id);

    // Scenario 11: Cancel a RUNNING private render while worker is mid-flight -> aborts cleanly & stays CANCELLED!
    let sawRunning: (() => void) | null = null;
    const runningPromise = new Promise<void>((r) => {
      sawRunning = r;
    });
    let workerSawAbort = false;

    activeBeforeRenderHook = async ({ signal }) => {
      sawRunning?.();
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 15_000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            workerSawAbort = true;
            reject(signal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    };

    const subCancel = await apiRequest('POST', `/api/media/projects/${session.projectId}/edits`, {
      token: user.token,
      body: {
        mode: 'manual',
        versionName: 'To Be Cancelled Cut',
        windowStartSec: 13,
        windowEndSec: 19,
        renderOutput: true,
        idempotencyKey: `idem_cancel_${runTag}`,
      },
    });
    expect(subCancel.status).toBe(202);
    const cancelRenderId = subCancel.data.renderJob.renderJobId as string;

    await runningPromise;
    const cancelRes = await apiRequest(
      'POST',
      `/api/media/projects/${session.projectId}/renders/${cancelRenderId}/cancel`,
      { token: user.token },
    );
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.data.status).toBe('CANCELLED');

    await sleep(400);
    activeBeforeRenderHook = null;
    expect(workerSawAbort).toBe(true);

    const afterCancel = await apiRequest(
      'GET',
      `/api/media/projects/${session.projectId}/renders/${cancelRenderId}`,
      { token: user.token },
    );
    expect(afterCancel.status).toBe(200);
    expect(afterCancel.data.status).toBe('CANCELLED');
    expect(afterCancel.data.downloadUrl).toBeUndefined();

    // Scenario 12: Worker crash (expired RUNNING lease on generation 1) -> bounded reconciler bumps generation 2 -> completes READY!
    const crashedRow = await db.privateRenderJob.create({
      data: {
        userId: user.user.id,
        projectId: session.projectId,
        editVersionId: session.rootVersionId,
        mediaSourceId: session.mediaSourceId,
        idempotencyKey: `idem_crash_recover_${runTag}`,
        customEditHash: `crash_${runTag}`,
        mode: 'auto',
        windowStartSec: 14,
        windowEndSec: 20,
        effects: { subtitles: false, zooms: false, transitions: 'none', music: false },
        renderSettings: { format: 'reel', width: 1280, height: 720, fps: 30 },
        status: 'RUNNING',
        stage: 'rendering_clip',
        progressPercent: 40,
        generation: 1,
        ownerWorkerId: 'dead_worker_pid_999',
        ownerToken: 'dead_owner_token_1',
        leaseExpiresAt: new Date(Date.now() - 5_000), // Expired lease!
        attempts: 1,
        maxAttempts: 3,
      },
    });

    const reconciled = await service.privateRenders.reconcileStrandedRenders(10);
    expect(reconciled.recoveredExpiredLeases).toBeGreaterThanOrEqual(1);

    // Wait for healthy worker to claim generation 2 and finish!
    const recovered = await waitForPrivateRenderTerminal(user.token, session.projectId, crashedRow.id, 60_000);
    expect(recovered.status).toBe('READY');
    expect(recovered.downloadUrl).toBeTruthy();

    // Verify stale dead worker generation 1 CANNOT overwrite committed READY row!
    const staleCommit = await service.privateRenders.commitRenderFailedFenced({
      renderJobId: crashedRow.id,
      generation: 1,
      ownerToken: 'dead_owner_token_1',
      errorCode: 'STALE_FAIL',
      errorMessage: 'Should be fenced out',
    });
    expect(staleCommit).toBe(false);

    const stillReady = await db.privateRenderJob.findUniqueOrThrow({ where: { id: crashedRow.id } });
    expect(stillReady.status).toBe('READY');
    expect(stillReady.generation).toBe(2);
  }, 90_000);

  it('Resource controls (Section 7): enforces free-beta max clip duration, per-user active render cap, and global backpressure', async () => {
    const user = await createTestUser('quota_user');
    const { session } = await seedPublishedSharedVod('quota_vod', user.user.id);

    // 1. Clip duration > 180s rejected with 400
    const tooLong = await apiRequest('POST', `/api/media/projects/${session.projectId}/edits`, {
      token: user.token,
      body: {
        mode: 'manual',
        versionName: 'Too Long Cut',
        windowStartSec: 0,
        windowEndSec: 240,
        renderOutput: true,
        idempotencyKey: `idem_long_${runTag}`,
      },
    });
    expect(tooLong.status).toBe(400);

    // 2. Per-user active cap (2 concurrent QUEUED/RUNNING) -> 3rd returns 429!
    const localService = new PrivateRenderService({
      db,
      storage,
      redis: redis as any,
      keyPrefix: `${keyPrefix}cap:`,
      skipImmediateEnqueue: true,
      policy: { maxActiveRendersPerUser: 2, maxDailyRendersPerUser: 10, maxQueuedGlobalRenders: 50 },
    });

    await localService.applyPrivateEditAndMaybeEnqueueRender(user.user.id, session.projectId, {
      mode: 'auto',
      versionName: 'Cap 1',
      windowStartSec: 10,
      windowEndSec: 15,
      renderOutput: true,
      idempotencyKey: `cap_1_${runTag}`,
    });
    await localService.applyPrivateEditAndMaybeEnqueueRender(user.user.id, session.projectId, {
      mode: 'auto',
      versionName: 'Cap 2',
      windowStartSec: 11,
      windowEndSec: 16,
      renderOutput: true,
      idempotencyKey: `cap_2_${runTag}`,
    });
    await expect(
      localService.applyPrivateEditAndMaybeEnqueueRender(user.user.id, session.projectId, {
        mode: 'auto',
        versionName: 'Cap 3 Over Limit',
        windowStartSec: 12,
        windowEndSec: 17,
        renderOutput: true,
        idempotencyKey: `cap_3_${runTag}`,
      }),
    ).rejects.toMatchObject({ statusCode: 429 });

    // 3. Global queue backpressure -> returns 503 retryable!
    const bpService = new PrivateRenderService({
      db,
      storage,
      redis: redis as any,
      keyPrefix: `${keyPrefix}bp:`,
      skipImmediateEnqueue: true,
      policy: { maxActiveRendersPerUser: 10, maxDailyRendersPerUser: 50, maxQueuedGlobalRenders: 1 },
    });
    await expect(
      bpService.applyPrivateEditAndMaybeEnqueueRender(user.user.id, session.projectId, {
        mode: 'auto',
        versionName: 'Backpressure Cut',
        windowStartSec: 10,
        windowEndSec: 14,
        renderOutput: true,
        idempotencyKey: `bp_1_${runTag}`,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  }, 60_000);
});
