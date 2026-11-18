import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { MediaProcessJobPayload, PrivateRenderQueuePayload } from '@autoedit/contracts';
import {
  ensureControlledLiveFixture,
  probeAndValidateClipMp4,
  resolveMediaSourceFromUrl,
  PlatformSourceResolverService,
  safeFetch,
  UniversalMediaApiService,
  buildGenerationBullJobId,
  buildPrivateRenderBullJobId,
  FfmpegRollingSegmentBuffer,
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('Step 3C.2: Platform Source Resolvers, SSRF/DNS/Redirect Hardening & Authorized Direct Media Live/VOD Pipeline', () => {
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

  const runTag = `3c2_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const mediaQueueName = `media-3c2-${runTag}`;
  const privRenderQueueName = `priv-3c2-${runTag}`;
  const keyPrefix = `autoedit:test:${runTag}:`;
  const fixture30sPath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
  const workRoot = path.resolve(process.cwd(), 'tmp', `step3c2-${runTag}`);

  const createdUserIds = new Set<string>();
  const createdSourceCanonicalIds = new Set<string>();
  const createdStorageKeys = new Set<string>();

  let mediaQueue: Queue<MediaProcessJobPayload>;
  let privRenderQueue: Queue<PrivateRenderQueuePayload>;
  let mediaWorkerHandle: ReturnType<typeof createMediaWorker>;
  let privRenderWorkerHandle: ReturnType<typeof createPrivateRenderWorker>;
  let mediaOriginServer: http.Server;
  let mediaOriginPort = 0;
  let apiServerA: http.Server;
  let apiServerB: http.Server;
  let apiUrlA = '';
  let apiUrlB = '';
  let serviceA: UniversalMediaApiService;
  let serviceB: UniversalMediaApiService;

  let vodGetCount = 0;
  let totalMediaEnqueues = 0;

  // Dynamic live HLS state served by our real local HTTP origin
  let hlsSegmentFiles: string[] = [];
  let hlsPublishedCount = 0;
  let hlsEnded = false;

  async function createTestUser(suffix: string) {
    const user = await db.user.create({
      data: {
        email: `${runTag}_${suffix}@local.test`,
        name: `User ${suffix}`,
      },
    });
    createdUserIds.add(user.id);
    return { user, token: signToken({ sub: user.id, email: user.email }) };
  }

  async function apiReq<T = any>(
    base: string,
    method: 'GET' | 'POST',
    routePath: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${routePath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const txt = await res.text();
    let data: any = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = txt;
    }
    return { status: res.status, data };
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

    // Pre-slice our 30s fixture into real 4-second playable MP4 segments for the live HLS origin server!
    const hlsPrepDir = path.join(workRoot, 'hls-origin-segs');
    const prepBuf = new FfmpegRollingSegmentBuffer({
      workDir: hlsPrepDir,
      bufferConfig: { segmentDurationSec: 4, preEventSec: 6, postEventSec: 4, maxRetentionSec: 120 },
    });
    await prepBuf.ingestFromSourceFile(fixture30sPath, { markEndOfStream: true });
    hlsSegmentFiles = prepBuf.getValidSegments().map((s) => s.filePath);
    expect(hlsSegmentFiles.length).toBeGreaterThanOrEqual(6);

    const vodBytes = await fs.readFile(fixture30sPath);

    // Real local HTTP origin serving authorized VOD MP4, failing/corrupt endpoints, and live HLS .m3u8!
    mediaOriginServer = http.createServer(async (req, res) => {
      const reqPath = (req.url || '').split('?')[0];
      if (reqPath === '/media/authorized-vod.mp4') {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(vodBytes.length));
        if (req.method === 'HEAD') {
          res.statusCode = 200;
          res.end();
          return;
        }
        vodGetCount++;
        res.statusCode = 200;
        res.end(vodBytes);
        return;
      }
      if (reqPath === '/media/corrupt.mp4') {
        const bad = Buffer.from('not-a-valid-mp4-stream');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(bad.length));
        res.statusCode = 200;
        res.end(req.method === 'HEAD' ? undefined : bad);
        return;
      }
      if (reqPath === '/media/live-stream.m3u8') {
        const count = Math.max(1, Math.min(hlsSegmentFiles.length, hlsPublishedCount));
        const lines = [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:4',
          '#EXT-X-MEDIA-SEQUENCE:0',
        ];
        for (let i = 0; i < count; i++) {
          lines.push('#EXTINF:4.000,');
          lines.push(`/media/hls-seg-${i}.mp4`);
        }
        if (hlsEnded) lines.push('#EXT-X-ENDLIST');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end(`${lines.join('\n')}\n`);
        return;
      }
      const segMatch = reqPath.match(/^\/media\/hls-seg-(\d+)\.mp4$/);
      if (segMatch) {
        const idx = Number(segMatch[1]);
        const filePath = hlsSegmentFiles[idx];
        if (!filePath) {
          res.statusCode = 404;
          res.end('missing segment');
          return;
        }
        const buf = await fs.readFile(filePath);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(buf.length));
        res.end(buf);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise<void>((resolve) => {
      mediaOriginServer.listen(0, '127.0.0.1', () => resolve());
    });
    const origAddr = mediaOriginServer.address();
    if (!origAddr || typeof origAddr === 'string') throw new Error('Origin bind failed');
    mediaOriginPort = origAddr.port;

    mediaQueue = new Queue<MediaProcessJobPayload>(mediaQueueName, {
      connection: bullConnection,
      defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 250 }, removeOnComplete: 200 },
    });
    privRenderQueue = new Queue<PrivateRenderQueuePayload>(privRenderQueueName, {
      connection: bullConnection,
      defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 250 }, removeOnComplete: 200 },
    });

    const platformConfig = {
      enableYoutubeOembedFallback: false,
      directMediaAllowedHosts: new Set(['127.0.0.1']),
      directMediaPermittedPublicHosts: new Set(['127.0.0.1']),
      http: { allowLocalhostForTest: true, timeoutMs: 10_000 },
    };

    const makeService = (label: string) =>
      new UniversalMediaApiService({
        db,
        storage,
        redis: redis as any,
        workRootDir: path.join(workRoot, `api-${label}`),
        keyPrefix,
        platformConfig,
        enqueueJob: async (payload, opts) => {
          totalMediaEnqueues++;
          const job = await mediaQueue.add('process-media', payload, {
            jobId: opts?.jobId ?? buildGenerationBullJobId(payload.sharedWorkKey, payload.generation ?? 1),
            attempts: 2,
            backoff: { type: 'fixed', delay: 250 },
          });
          return { id: job.id };
        },
        enqueuePrivateRenderJob: async (payload, opts) => {
          const job = await privRenderQueue.add('private-render', payload, {
            jobId: opts?.jobId ?? buildPrivateRenderBullJobId(payload.renderJobId, payload.generation),
            attempts: 2,
            backoff: { type: 'fixed', delay: 250 },
          });
          return { id: job.id };
        },
      });

    serviceA = makeService('A');
    serviceB = makeService('B');

    mediaWorkerHandle = createMediaWorker({
      queueName: mediaQueueName,
      db: dbWorker,
      storage,
      redis: redis as any,
      bullConnection,
      workRootDir: path.join(workRoot, 'worker-media'),
      keyPrefix,
      concurrency: 2,
      reconcileIntervalMs: 0,
      platformConfig,
      enqueueRecoveryJob: async (payload, opts) => {
        totalMediaEnqueues++;
        const job = await mediaQueue.add('process-media', payload, {
          jobId: opts?.jobId ?? buildGenerationBullJobId(payload.sharedWorkKey, payload.generation ?? 1),
        });
        return { id: job.id };
      },
    });
    await mediaWorkerHandle.worker.waitUntilReady();

    privRenderWorkerHandle = createPrivateRenderWorker({
      queueName: privRenderQueueName,
      db: dbWorker,
      storage,
      redis: redis as any,
      bullConnection,
      workRootDir: path.join(workRoot, 'worker-priv'),
      keyPrefix: `${keyPrefix}priv_render:`,
      concurrency: 2,
      reconcileIntervalMs: 0,
    });
    await privRenderWorkerHandle.worker.waitUntilReady();

    const noopLimiter: express.RequestHandler = (_req, _res, next) => next();
    const mountApp = (svc: UniversalMediaApiService) => {
      const app = express();
      app.use(express.json({ limit: '2mb' }));
      app.use('/api/media', requireAuth, createMediaRouter({ service: svc, resolveLimiter: noopLimiter, jobLimiter: noopLimiter }));
      app.use(errorHandler);
      return app;
    };

    await new Promise<void>((resolve) => {
      apiServerA = mountApp(serviceA).listen(0, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => {
      apiServerB = mountApp(serviceB).listen(0, '127.0.0.1', () => resolve());
    });
    apiUrlA = `http://127.0.0.1:${(apiServerA.address() as any).port}`;
    apiUrlB = `http://127.0.0.1:${(apiServerB.address() as any).port}`;
  }, 90_000);

  afterAll(async () => {
    if (apiServerA) await new Promise<void>((r) => apiServerA.close(() => r()));
    if (apiServerB) await new Promise<void>((r) => apiServerB.close(() => r()));
    if (mediaOriginServer) await new Promise<void>((r) => mediaOriginServer.close(() => r()));
    if (mediaWorkerHandle) await mediaWorkerHandle.worker.close().catch(() => {});
    if (privRenderWorkerHandle) await privRenderWorkerHandle.worker.close().catch(() => {});
    if (mediaQueue) {
      await mediaQueue.obliterate({ force: true }).catch(() => {});
      await mediaQueue.close().catch(() => {});
    }
    if (privRenderQueue) {
      await privRenderQueue.obliterate({ force: true }).catch(() => {});
      await privRenderQueue.close().catch(() => {});
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

  it('Scenarios 1–3: canonicalizes YouTube (VOD/live/@handle/channel/clip), Twitch (channel/VOD/clip), and Kick (channel/VOD/clip) URLs accurately', () => {
    // 1. YouTube
    expect(resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').canonicalId).toBe(
      'youtube:vod:dQw4w9WgXcQ',
    );
    expect(resolveMediaSourceFromUrl('https://youtu.be/dQw4w9WgXcQ').canonicalId).toBe(
      'youtube:vod:dQw4w9WgXcQ',
    );
    expect(resolveMediaSourceFromUrl('https://www.youtube.com/live/dQw4w9WgXcQ').canonicalId).toBe(
      'youtube:broadcast:dQw4w9WgXcQ',
    );
    const ytHandle = resolveMediaSourceFromUrl('https://www.youtube.com/@mkbhd/live');
    expect(ytHandle.canonicalId).toBe('youtube:channel:mkbhd');
    expect(ytHandle.identityScope).toBe('CHANNEL_DISCOVERY');
    const ytChan = resolveMediaSourceFromUrl('https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ/live');
    expect(ytChan.canonicalId).toBe('youtube:channel:UCBJycsmduvYEL83R_U4JriQ');
    const ytClip = resolveMediaSourceFromUrl('https://www.youtube.com/clip/UgkxAbCdEfGhIjKlMnOpQr');
    expect(ytClip.metadata?.isClip).toBe(true);

    // 2. Twitch
    expect(resolveMediaSourceFromUrl('https://www.twitch.tv/shroud').canonicalId).toBe(
      'twitch:channel:shroud',
    );
    expect(resolveMediaSourceFromUrl('https://www.twitch.tv/videos/1234567890').canonicalId).toBe(
      'twitch:vod:1234567890',
    );
    const twClip = resolveMediaSourceFromUrl('https://clips.twitch.tv/IncredulousFunnyClipSlug');
    expect(twClip.canonicalId).toBe('twitch:vod:clip_IncredulousFunnyClipSlug');
    expect(twClip.metadata?.isClip).toBe(true);

    // 3. Kick
    expect(resolveMediaSourceFromUrl('https://kick.com/xqc').canonicalId).toBe('kick:channel:xqc');
    expect(resolveMediaSourceFromUrl('https://kick.com/video/11111111-2222-3333-4444-555555555555').canonicalId).toBe(
      'kick:vod:11111111-2222-3333-4444-555555555555',
    );
    const kickClip1 = resolveMediaSourceFromUrl('https://kick.com/xqc/clips/clip_01HXY12345');
    expect(kickClip1.metadata?.isClip).toBe(true);
    const kickClip2 = resolveMediaSourceFromUrl('https://kick.com/xqc?clip=clip_01HXY12345');
    expect(kickClip2.canonicalId).toBe(kickClip1.canonicalId);
  });

  it('Scenarios 4–10: resolves YouTube, Twitch & Kick metadata using recorded official API fixtures (live, VOD, clips, ended, offline, rate limits, and provider outage)', async () => {
    const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
    let mode: 'ok' | 'rate_limit' | 'unavailable' = 'ok';

    const recordedFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (mode === 'rate_limit') {
        return jsonResponse({ error: 'rate limit' }, 429, { 'Retry-After': '45' });
      }
      if (mode === 'unavailable') {
        return jsonResponse({ error: 'service unavailable' }, 503);
      }

      // YouTube Data API v3 recorded fixtures
      if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        if (url.includes('id=ENDEDLIVE11')) {
          return jsonResponse({
            items: [
              {
                id: 'ENDEDLIVE11',
                snippet: {
                  title: 'Championship Finals Replay',
                  channelTitle: 'ProLeague',
                  liveBroadcastContent: 'none',
                  thumbnails: { high: { url: 'https://i.ytimg.com/vi/ENDEDLIVE11/hqdefault.jpg' } },
                },
                contentDetails: { duration: 'PT1H15M30S' },
                liveStreamingDetails: {
                  actualStartTime: '2026-11-18T10:00:00Z',
                  actualEndTime: '2026-11-18T11:15:30Z',
                },
              },
            ],
          });
        }
        return jsonResponse({
          items: [
            {
              id: 'dQw4w9WgXcQ',
              snippet: {
                title: 'Official Recorded YouTube Video',
                channelTitle: 'DemoCreator',
                liveBroadcastContent: 'none',
                thumbnails: { high: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' } },
              },
              contentDetails: { duration: 'PT3M33S' },
            },
          ],
        });
      }
      if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
        return jsonResponse({
          items: [{ id: 'UC_LIVE_TEST_1234567890', snippet: { title: 'LiveStreamerYT' } }],
        });
      }
      if (url.startsWith('https://www.googleapis.com/youtube/v3/search')) {
        return jsonResponse({
          items: [
            {
              id: { videoId: 'YTLIVEID123' },
              snippet: {
                title: 'Live Ranked Grind',
                channelTitle: 'LiveStreamerYT',
                thumbnails: { high: { url: 'https://i.ytimg.com/vi/YTLIVEID123/hqdefault.jpg' } },
              },
            },
          ],
        });
      }

      // Twitch Helix recorded fixtures
      if (url === 'https://id.twitch.tv/oauth2/token') {
        return jsonResponse({ access_token: 'twitch_app_tok_fixture', expires_in: 3600 });
      }
      if (url.startsWith('https://api.twitch.tv/helix/streams?user_login=shroud')) {
        return jsonResponse({
          data: [
            {
              id: '41928374650',
              user_login: 'shroud',
              user_name: 'shroud',
              title: 'Live FPS Tournament',
              started_at: '2026-11-18T12:00:00Z',
              thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_shroud-{width}x{height}.jpg',
              type: 'live',
            },
          ],
        });
      }
      if (url.startsWith('https://api.twitch.tv/helix/streams?user_login=offlineuser')) {
        return jsonResponse({ data: [] });
      }
      if (url.startsWith('https://api.twitch.tv/helix/users?login=offlineuser')) {
        return jsonResponse({
          data: [{ id: '999', login: 'offlineuser', display_name: 'OfflineUser' }],
        });
      }
      if (url.startsWith('https://api.twitch.tv/helix/videos?id=1234567890')) {
        return jsonResponse({
          data: [
            {
              id: '1234567890',
              stream_id: '41928374650',
              user_name: 'shroud',
              title: 'Full 2h Stream VOD',
              duration: '2h5m10s',
              thumbnail_url: 'https://static-cdn.jtvnw.net/cf_vods/vod-%{width}x%{height}.jpg',
              created_at: '2026-11-17T12:00:00Z',
            },
          ],
        });
      }
      if (url.startsWith('https://api.twitch.tv/helix/clips?id=IncredulousFunnyClipSlug')) {
        return jsonResponse({
          data: [
            {
              id: 'IncredulousFunnyClipSlug',
              title: 'Insane 1v4 Clutch',
              broadcaster_name: 'shroud',
              duration: 28,
              thumbnail_url: 'https://clips-media-assets2.twitch.tv/clip-preview.jpg',
              created_at: '2026-11-17T13:00:00Z',
              video_id: '1234567890',
            },
          ],
        });
      }

      // Kick Public API v1 recorded fixtures
      if (url === 'https://id.kick.com/oauth/token') {
        return jsonResponse({ access_token: 'kick_app_tok_fixture', expires_in: 3600 });
      }
      if (url.startsWith('https://api.kick.com/public/v1/channels?slug=xqc')) {
        return jsonResponse({
          data: [
            {
              broadcaster_user_id: 777001,
              slug: 'xqc',
              stream_title: 'Kick Live Variety Stream',
              stream: { is_live: true, start_time: '2026-11-18T14:00:00Z' },
            },
          ],
        });
      }
      if (url.startsWith('https://api.kick.com/public/v1/livestreams?broadcaster_user_id=777001')) {
        return jsonResponse({ data: [{ id: 888999, broadcaster_user_id: 777001, is_live: true }] });
      }
      if (url.startsWith('https://api.kick.com/public/v1/channels?slug=offlinekick')) {
        return jsonResponse({
          data: [{ broadcaster_user_id: 777002, slug: 'offlinekick', stream: { is_live: false } }],
        });
      }

      return jsonResponse({}, 404);
    };

    const resolver = new PlatformSourceResolverService({
      youtubeApiKey: 'test_yt_key',
      twitchClientId: 'test_tw_id',
      twitchClientSecret: 'test_tw_sec',
      kickClientId: 'test_kick_id',
      kickClientSecret: 'test_kick_sec',
      http: { fetchImpl: recordedFetch, dnsLookup: publicDns },
    });

    // 4 & 5: YouTube VOD + YouTube Live Channel + Ended Broadcast (9)
    const ytVod = await resolver.resolveUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(ytVod.metadata.title).toBe('Official Recorded YouTube Video');
    expect(ytVod.metadata.durationSec).toBe(213);
    expect(ytVod.capabilityStatus).toBe('UNSUPPORTED_ACQUISITION');
    expect(ytVod.canSubmitJob).toBe(false);

    const ytChanLive = await resolver.resolveUrl('https://www.youtube.com/@livestreameryt/live');
    expect(ytChanLive.availability).toBe('LIVE_NOW');
    expect(ytChanLive.source.canonicalId).toBe('youtube:broadcast:livestreameryt:YTLIVEID123');
    expect(ytChanLive.capabilityStatus).toBe('UNSUPPORTED_ACQUISITION');

    const ytEnded = await resolver.resolveUrl('https://www.youtube.com/live/ENDEDLIVE11');
    expect(ytEnded.availability).toBe('AVAILABLE');
    expect(ytEnded.source.sourceType).toBe('vod');
    expect(ytEnded.metadata.durationSec).toBe(4530);
    expect(ytEnded.reason).toContain('ended');

    // 4, 5, 6, 10: Twitch Live, Offline/Unresolved, VOD, Clip
    const twLive = await resolver.resolveUrl('https://www.twitch.tv/shroud');
    expect(twLive.availability).toBe('LIVE_NOW');
    expect(twLive.source.canonicalId).toBe('twitch:broadcast:shroud:41928374650');
    expect(twLive.metadata.broadcastId).toBe('41928374650');
    expect(twLive.canSubmitJob).toBe(false);

    const twOffline = await resolver.resolveUrl('https://www.twitch.tv/offlineuser');
    expect(twOffline.availability).toBe('OFFLINE');
    expect(twOffline.capabilityStatus).toBe('BROADCAST_UNRESOLVED');

    const twVod = await resolver.resolveUrl('https://www.twitch.tv/videos/1234567890');
    expect(twVod.metadata.title).toBe('Full 2h Stream VOD');
    expect(twVod.metadata.durationSec).toBe(7510);
    expect(twVod.capabilityStatus).toBe('UNSUPPORTED_ACQUISITION');

    const twClip = await resolver.resolveUrl('https://clips.twitch.tv/IncredulousFunnyClipSlug');
    expect(twClip.metadata.title).toBe('Insane 1v4 Clutch');
    expect(twClip.metadata.durationSec).toBe(28);
    expect(twClip.metadata.platformClipSupported).toBe(true);
    expect(twClip.capabilityStatus).toBe('REQUIRES_PERMISSION');
    expect(twClip.canSubmitJob).toBe(false);

    // 4 & 10: Kick Live & Offline
    const kickLive = await resolver.resolveUrl('https://kick.com/xqc');
    expect(kickLive.availability).toBe('LIVE_NOW');
    expect(kickLive.source.canonicalId).toBe('kick:broadcast:xqc:888999');
    expect(kickLive.capabilityStatus).toBe('UNSUPPORTED_ACQUISITION');

    const kickOffline = await resolver.resolveUrl('https://kick.com/offlinekick');
    expect(kickOffline.availability).toBe('OFFLINE');
    expect(kickOffline.capabilityStatus).toBe('BROADCAST_UNRESOLVED');

    // 7. Provider API rate limit (429 + Retry-After)
    mode = 'rate_limit';
    const rlRes = await resolver.resolveUrl('https://www.twitch.tv/shroud');
    expect(rlRes.providerNotice?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(rlRes.providerNotice?.retryAfterSec).toBe(45);
    expect(rlRes.canSubmitJob).toBe(false);

    // 8. Provider unavailable (503)
    mode = 'unavailable';
    const unavailRes = await resolver.resolveUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(unavailRes.providerNotice?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(unavailRes.canSubmitJob).toBe(false);
  });

  it('Scenarios 11 & 12: blocks SSRF, private IPs, DNS rebinding, and malicious redirect hops in safeFetch', async () => {
    // 11. Direct SSRF targets blocked before network
    for (const bad of [
      'http://127.0.0.1/video.mp4',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/internal.mp4',
      'file:///etc/passwd',
      'https://user:pass@example.com/video.mp4',
    ]) {
      await expect(safeFetch(bad)).rejects.toMatchObject({
        code: expect.stringMatching(/SSRF_BLOCKED|PRIVATE_NETWORK_BLOCKED|UNSUPPORTED_SCHEME/),
      });
    }

    // 12a. DNS rebinding attack (public hostname resolves to 127.0.0.1 or 169.254.169.254) -> BLOCKED!
    await expect(
      safeFetch('https://rebind.attacker.example/clip.mp4', {
        dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
        fetchImpl: async () => {
          throw new Error('fetch MUST NOT be called when DNS resolves to private IP!');
        },
      }),
    ).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED' });

    await expect(
      safeFetch('https://imds.attacker.example/clip.mp4', {
        dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
        fetchImpl: async () => {
          throw new Error('fetch MUST NOT be called when DNS resolves to metadata IP!');
        },
      }),
    ).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED' });

    // 12b. Malicious redirect hop to localhost or disallowed host -> BLOCKED!
    await expect(
      safeFetch('https://allowed.cdn.example/video.mp4', {
        allowedHosts: new Set(['allowed.cdn.example']),
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/secret' } }),
      }),
    ).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED' });

    await expect(
      safeFetch('https://allowed.cdn.example/video.mp4', {
        allowedHosts: new Set(['allowed.cdn.example']),
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { Location: 'https://evil.other.example/video.mp4' } }),
      }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('Scenarios 13–17, 20–22: acquires real authorized VOD over HTTP across TWO API instances with ONE download/enqueue, verifies failure handling, crash recovery, private project isolation, and real ffprobe-validated MP4 download', async () => {
    const userA = await createTestUser('direct_vod_A');
    const userB = await createTestUser('direct_vod_B');

    const vodUrl = `http://127.0.0.1:${mediaOriginPort}/media/authorized-vod.mp4`;
    const resolvedCheck = await apiReq(apiUrlA, 'POST', '/api/media/sources/resolve', {
      token: userA.token,
      body: { input: { inputType: 'url', url: vodUrl } },
    });
    expect(resolvedCheck.status, `resolveCheck body: ${JSON.stringify(resolvedCheck.data)}`).toBe(200);
    expect(resolvedCheck.data.capabilityStatus).toBe('READY_TO_PROCESS');
    expect(resolvedCheck.data.canSubmitJob).toBe(true);
    expect(resolvedCheck.data.provider).toBe('direct_media');

    const msRow = await db.mediaSource.findUniqueOrThrow({ where: { id: resolvedCheck.data.mediaSourceId } });
    createdSourceCanonicalIds.add(msRow.canonicalId);

    // 15, 16, 17: TWO independent API instances submit identical authorized direct media URL concurrently ->
    // strictly ONE BullMQ enqueue & ONE HTTP VOD download!
    const enqBefore = totalMediaEnqueues;
    const vodGetsBefore = vodGetCount;
    const [subA, subB] = await Promise.all([
      apiReq(apiUrlA, 'POST', '/api/media/jobs', {
        token: userA.token,
        body: { input: { inputType: 'url', url: vodUrl }, idempotencyKey: `direct_a_${runTag}` },
      }),
      apiReq(apiUrlB, 'POST', '/api/media/jobs', {
        token: userB.token,
        body: { input: { inputType: 'url', url: vodUrl }, idempotencyKey: `direct_b_${runTag}` },
      }),
    ]);
    expect([200, 202]).toContain(subA.status);
    expect([200, 202]).toContain(subB.status);

    // Wait for BOTH users' jobs to reach READY
    const waitJob = async (base: string, token: string, jobId: string) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const st = await apiReq(base, 'GET', `/api/media/jobs/${jobId}`, { token });
        if (['READY', 'FAILED', 'CANCELLED'].includes(st.data.status)) return st.data;
        await sleep(250);
      }
      throw new Error(`Timeout waiting for job ${jobId}`);
    };

    const [doneA, doneB] = await Promise.all([
      waitJob(apiUrlA, userA.token, subA.data.jobId),
      waitJob(apiUrlB, userB.token, subB.data.jobId),
    ]);
    expect(doneA.status).toBe('READY');
    expect(doneB.status).toBe('READY');
    expect(doneA.highlightsCount).toBeGreaterThanOrEqual(1);
    expect(totalMediaEnqueues - enqBefore).toBe(1);
    expect(vodGetCount - vodGetsBefore).toBe(1);

    // 21 & 22: User A opens private project -> applies Prompt edit -> async private render -> real ffprobe MP4!
    const projA = await apiReq(apiUrlA, 'POST', '/api/media/projects/from-source', {
      token: userA.token,
      body: { jobId: subA.data.jobId, title: 'Direct Media Private Project A' },
    });
    expect(projA.status).toBe(201);

    // User B gets 404 on User A's private project
    const sneak = await apiReq(apiUrlB, 'GET', `/api/media/projects/${projA.data.projectId}/highlights`, {
      token: userB.token,
    });
    expect(sneak.status).toBe(404);

    const editA = await apiReq(apiUrlA, 'POST', `/api/media/projects/${projA.data.projectId}/edits`, {
      token: userA.token,
      body: {
        mode: 'prompt',
        versionName: 'Direct Media Prompt Cut',
        userPrompt: 'Keep the hype moment',
        windowStartSec: 12,
        windowEndSec: 20,
        renderOutput: true,
        idempotencyKey: `direct_edit_${runTag}`,
      },
    });
    expect(editA.status).toBe(202);
    const renderJobId = editA.data.renderJob.renderJobId as string;

    let renderDone: any = null;
    const renderDeadline = Date.now() + 60_000;
    while (Date.now() < renderDeadline) {
      const r = await apiReq(
        apiUrlA,
        'GET',
        `/api/media/projects/${projA.data.projectId}/renders/${renderJobId}`,
        { token: userA.token },
      );
      if (['READY', 'FAILED', 'CANCELLED'].includes(r.data.status)) {
        renderDone = r.data;
        break;
      }
      await sleep(250);
    }
    expect(renderDone?.status).toBe('READY');
    expect(renderDone?.downloadUrl).toBeTruthy();

    const dl = await fetch(renderDone.downloadUrl);
    expect(dl.status).toBe(200);
    const outFile = path.join(workRoot, 'direct-private-cut.mp4');
    await fs.writeFile(outFile, Buffer.from(await dl.arrayBuffer()));
    const probed = await probeAndValidateClipMp4(outFile);
    expect(probed.durationSec).toBeGreaterThan(2);
    expect(probed.width).toBeGreaterThan(0);

    // 14. Acquisition failure: corrupt remote MP4 fails cleanly with ARTIFACT_CORRUPT
    const corruptUrl = `http://127.0.0.1:${mediaOriginPort}/media/corrupt.mp4`;
    const subCorrupt = await apiReq(apiUrlA, 'POST', '/api/media/jobs', {
      token: userA.token,
      body: { input: { inputType: 'url', url: corruptUrl }, idempotencyKey: `corrupt_${runTag}` },
    });
    expect(subCorrupt.status).toBe(202);
    const corruptMs = await db.mediaSource.findUnique({ where: { id: subCorrupt.data.mediaSourceId } });
    if (corruptMs) createdSourceCanonicalIds.add(corruptMs.canonicalId);
    const corruptDone = await waitJob(apiUrlA, userA.token, subCorrupt.data.jobId);
    expect(corruptDone.status).toBe('FAILED');
    expect(corruptDone.errorCode).toBe('ARTIFACT_CORRUPT');

    // 20. Worker crash recovery: stranded expired RUNNING SharedMediaWork recovers via reconciler -> READY
    const crashWorkKey = `mwk_3c2_crash_${runTag}`;
    await db.sharedMediaWork.create({
      data: {
        sharedWorkKey: crashWorkKey,
        mediaSourceId: msRow.id,
        canonicalSourceId: msRow.canonicalId,
        sourceType: 'VOD',
        status: 'RUNNING',
        generation: 1,
        ownerWorkerId: 'dead_worker_3c2',
        ownerToken: 'dead_tok_3c2',
        leaseExpiresAt: new Date(Date.now() - 5_000),
        enqueuePayload: {
          sharedWorkKey: crashWorkKey,
          mediaSourceId: msRow.id,
          canonicalSourceId: msRow.canonicalId,
          sourceType: 'vod',
          initiatedByUserId: userA.user.id,
          userJobId: 'placeholder',
          directMediaUrl: vodUrl,
        },
      },
    });
    const crashedUserJob = await db.mediaProcessingJob.create({
      data: {
        userId: userA.user.id,
        mediaSourceId: msRow.id,
        idempotencyKey: `crash_3c2_${runTag}`,
        sharedWorkKey: crashWorkKey,
        attachedGeneration: 1,
        sourceType: 'VOD',
        status: 'RUNNING',
        stage: 'acquiring_source',
        progressPercent: 15,
      },
    });
    const rec = await serviceA.reconcileStrandedWork(10);
    expect(rec.recoveredExpiredLeaseCount).toBeGreaterThanOrEqual(1);
    const recoveredDone = await waitJob(apiUrlA, userA.token, crashedUserJob.id);
    expect(recoveredDone.status).toBe('READY');
  }, 120_000);

  it('Scenarios 18 & 19: ingests real live HLS (.m3u8) incrementally, emits live highlights BEFORE broadcast ends, and shares one live session with late-joining clippers', async () => {
    const clipperA = await createTestUser('hls_live_A');
    const clipperB = await createTestUser('hls_live_B');

    // Start live HLS playlist with first 6 segments (24s, covering spike at 16–19s + post-roll) WITHOUT #EXT-X-ENDLIST!
    hlsPublishedCount = Math.min(6, hlsSegmentFiles.length);
    hlsEnded = false;

    const liveUrl = `http://127.0.0.1:${mediaOriginPort}/media/live-stream.m3u8`;
    const resolvedLive = await apiReq(apiUrlA, 'POST', '/api/media/sources/resolve', {
      token: clipperA.token,
      body: { input: { inputType: 'url', url: liveUrl } },
    });
    expect(resolvedLive.status).toBe(200);
    expect(resolvedLive.data.capabilityStatus).toBe('READY_TO_PROCESS');
    expect(resolvedLive.data.sourceType).toBe('live');
    expect(resolvedLive.data.availability).toBe('LIVE_NOW');

    const liveMs = await db.mediaSource.findUniqueOrThrow({ where: { id: resolvedLive.data.mediaSourceId } });
    createdSourceCanonicalIds.add(liveMs.canonicalId);

    const enqBefore = totalMediaEnqueues;
    const subA = await apiReq(apiUrlA, 'POST', '/api/media/jobs', {
      token: clipperA.token,
      body: { input: { inputType: 'url', url: liveUrl }, idempotencyKey: `hls_a_${runTag}` },
    });
    expect(subA.status).toBe(202);

    // Wait until live highlight is emitted WHILE stream is still RUNNING (before #EXT-X-ENDLIST)!
    let sawLiveHighlightWhileRunning = false;
    const liveDeadline = Date.now() + 40_000;
    while (Date.now() < liveDeadline) {
      const st = await apiReq(apiUrlA, 'GET', `/api/media/jobs/${subA.data.jobId}`, {
        token: clipperA.token,
      });
      if (st.data.status === 'RUNNING' && st.data.highlightsCount >= 1) {
        sawLiveHighlightWhileRunning = true;
        break;
      }
      await sleep(250);
    }
    expect(sawLiveHighlightWhileRunning).toBe(true);

    // 18. Late-joining clipper B joins on API Instance B -> attaches to SAME live session (ZERO extra enqueue!)
    const subB = await apiReq(apiUrlB, 'POST', '/api/media/jobs', {
      token: clipperB.token,
      body: { input: { inputType: 'url', url: liveUrl }, idempotencyKey: `hls_b_${runTag}` },
    });
    expect([200, 202]).toContain(subB.status);
    expect(totalMediaEnqueues - enqBefore).toBe(1);

    // Late-joining clipper B can already fetch the live highlight while broadcast is active!
    const hlBWhileLive = await apiReq(
      apiUrlB,
      'GET',
      `/api/media/jobs/${subB.data.jobId}/highlights`,
      { token: clipperB.token },
    );
    expect(hlBWhileLive.status).toBe(200);
    expect(hlBWhileLive.data.streamActive).toBe(true);
    expect(hlBWhileLive.data.highlights.length).toBeGreaterThanOrEqual(1);

    // Now publish remaining segments + #EXT-X-ENDLIST -> broadcast ends & transitions cleanly to READY!
    hlsPublishedCount = hlsSegmentFiles.length;
    hlsEnded = true;

    const endDeadline = Date.now() + 40_000;
    let finalA: any = null;
    let finalB: any = null;
    while (Date.now() < endDeadline) {
      finalA = (await apiReq(apiUrlA, 'GET', `/api/media/jobs/${subA.data.jobId}`, { token: clipperA.token })).data;
      finalB = (await apiReq(apiUrlB, 'GET', `/api/media/jobs/${subB.data.jobId}`, { token: clipperB.token })).data;
      if (finalA.status === 'READY' && finalB.status === 'READY') break;
      await sleep(250);
    }
    expect(finalA?.status).toBe('READY');
    expect(finalB?.status).toBe('READY');
    expect(finalB?.highlightsCount).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
