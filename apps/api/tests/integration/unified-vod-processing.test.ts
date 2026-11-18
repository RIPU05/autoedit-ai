import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  ensureControlledLiveFixture,
  ensureControlledMultiEventLiveFixture,
  SharedIngestionCoordinator,
  RedisCoordinationStore,
  ControlledVodAcquisitionAdapter,
  UnifiedVodProcessingService,
  VodResourceGuard,
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

describe('Step 3B.8: Unified VOD Ingestion, Shared Highlights, Whisper & Private Editing Integration', () => {
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
  const fixture30sPath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
  const fixture60sPath = path.resolve(process.cwd(), 'tmp', 'step3b6-3event-60s-fixture.mp4');
  const workRootA = path.resolve(process.cwd(), 'tmp', `step3b8-instA-${runTag}`);
  const workRootB = path.resolve(process.cwd(), 'tmp', `step3b8-instB-${runTag}`);
  const workRootProbe = path.resolve(process.cwd(), 'tmp', `step3b8-probe-${runTag}`);
  const redisKeyPrefix = `autoedit:test:step3b8:${runTag}:`;
  const quotaPrefix = `autoedit:test:step3b8:quota:${runTag}:`;

  const createdSourceCanonicalIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdStorageKeys = new Set<string>();

  function createService(
    workRoot: string,
    policy?: Partial<ConstructorParameters<typeof VodResourceGuard>[0]>,
  ) {
    const store = new RedisCoordinationStore(redis as any, {
      keyPrefix: redisKeyPrefix,
      recordTtlMs: 120_000,
    });
    const coordinator = new SharedIngestionCoordinator(store);
    const service = new UnifiedVodProcessingService(db, coordinator, storage, workRoot, {
      resourcePolicy: policy,
      quotaRedis: redis as any,
      quotaPrefix,
    });
    return { coordinator, service };
  }

  async function createTestUser(suffix: string) {
    const user = await db.user.create({
      data: {
        email: `step3b8_${runTag}_${suffix}@local.test`,
        name: `VOD User ${suffix}`,
      },
    });
    createdUserIds.add(user.id);
    return user;
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
  }, 90_000);

  afterAll(async () => {
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
      await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
    }
    const rKeys = await redis.keys(`${redisKeyPrefix}*`);
    const qKeys = await redis.keys(`${quotaPrefix}*`);
    const allKeys = [...rKeys, ...qKeys];
    if (allKeys.length > 0) await redis.del(...allKeys).catch(() => {});
    for (const key of createdStorageKeys) {
      await storage.deleteObject({ key }).catch(() => {});
    }
    await fs.rm(workRootA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootB, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workRootProbe, { recursive: true, force: true }).catch(() => {});
    await db.$disconnect();
  });

  it('1. supports all 6 VOD archetypes, acquires & probes real 60s VOD once, runs shared Whisper + 3-event analysis once, and generates verified base clip & render variants', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);
    const userA = await createTestUser('vodA');
    const userB = await createTestUser('vodB');

    // Graceful rejection when adapter is disabled / unsupported
    expect(
      () =>
        new ControlledVodAcquisitionAdapter({
          enabled: false,
          archetype: 'youtube_video',
          vodId: `disabled_${runTag}`,
          fixturePath: fixture30sPath,
        }),
    ).toThrow(MediaSourceError);

    // Register all 6 universal VOD/upload archetypes and verify canonical IDs
    const liveParentId = `youtube:broadcast:liveparent_${runTag}`;
    createdSourceCanonicalIds.add(liveParentId);
    const liveParent = await instA.service.registry.registerOrGetMediaSource({
      canonicalId: liveParentId,
      provider: 'youtube',
      sourceType: 'live',
      identityScope: 'IMMUTABLE_BROADCAST',
      externalId: `liveparent_${runTag}`,
      broadcastId: `liveparent_${runTag}`,
    });

    const archetypes = [
      new ControlledVodAcquisitionAdapter({
        enabled: true,
        archetype: 'youtube_video',
        vodId: `ytvid_${runTag}`,
        fixturePath: fixture30sPath,
      }),
      new ControlledVodAcquisitionAdapter({
        enabled: true,
        archetype: 'youtube_completed_live_vod',
        vodId: `ytlivevod_${runTag}`,
        associatedLiveSourceId: liveParent.id,
        fixturePath: fixture30sPath,
      }),
      new ControlledVodAcquisitionAdapter({
        enabled: true,
        archetype: 'twitch_vod',
        vodId: `twvod_${runTag}`,
        channelName: 'shroud',
        fixturePath: fixture60sPath,
      }),
      new ControlledVodAcquisitionAdapter({
        enabled: true,
        archetype: 'kick_vod',
        vodId: `kkvod_${runTag}`,
        channelName: 'xqc',
        fixturePath: fixture30sPath,
      }),
      new ControlledVodAcquisitionAdapter({
        enabled: true,
        archetype: 'direct_media_recording',
        vodId: `dirrec_${runTag}`,
        fixturePath: fixture30sPath,
      }),
      new ControlledVodAcquisitionAdapter({
        enabled: true,
        archetype: 'private_user_upload',
        vodId: `upvod_${runTag}`,
        ownerUserId: userA.id,
        fixturePath: fixture30sPath,
      }),
    ];

    for (const ad of archetypes) {
      const reg = ad.buildMediaSourceRegistration();
      createdSourceCanonicalIds.add(reg.canonicalId);
      const ms = await instA.service.registry.registerOrGetMediaSource(reg);
      expect(ms.canonicalId).toBe(reg.canonicalId);
      if (ad.config.archetype === 'youtube_completed_live_vod') {
        expect(ms.associatedLiveSourceId).toBe(liveParent.id);
      }
    }

    // End-to-end real 60s 3-event Twitch VOD test
    const twitchAdapter = archetypes[2];
    const twitchCanonicalId = twitchAdapter.buildMediaSourceRegistration().canonicalId as any;

    // Untrusted user-request provenance / grantedBy is REJECTED server-side (Section 8!)
    await expect(
      instA.service.registry.grantSourceRights({
        canonicalSourceId: twitchCanonicalId,
        grantScope: 'SHARED_REUSE',
        allowAcquisition: true,
        allowSharedReuse: true,
        provenance: 'USER_CLAIMED_PUBLIC_URL',
        grantedBy: `user:${userA.id}`,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // Server-authoritative test grant
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: twitchCanonicalId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b8',
    });

    // Layer A: Two users request same VOD -> strictly 1 import, 2nd user reuses MinIO source!
    const srcA = await instA.service.acquireOrReuseVodSource({
      adapter: twitchAdapter,
      requesterUserId: userA.id,
      workerId: 'instA_src_1',
    });
    const srcB = await instB.service.acquireOrReuseVodSource({
      adapter: twitchAdapter,
      requesterUserId: userB.id,
      workerId: 'instB_src_2',
    });

    expect(srcA.reusedFromCache).toBe(false);
    expect(srcA.probed.videoCodec).toBe('h264');
    expect(srcA.probed.audioCodec).toBe('aac');
    expect(srcA.probed.durationSec).toBeGreaterThanOrEqual(59);
    expect(srcA.mediaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(srcB.reusedFromCache).toBe(true);
    expect(srcB.objectKey).toBe(srcA.objectKey);
    expect(instA.service.metrics.sourceImportCount + instB.service.metrics.sourceImportCount).toBe(1);

    // Layer B: Shared VOD highlight analysis WITH local Whisper transcription enabled!
    const anaA = await instA.service.analyzeOrReuseVodHighlights({
      canonicalSourceId: twitchCanonicalId,
      sourceDescriptor: srcA.descriptor,
      requesterUserId: userA.id,
      workerId: 'instA_ana_1',
      preRollSec: 4,
      postRollSec: 4,
      segmentDurationSec: 4,
      cooldownSec: 12,
      scoreThreshold: 65,
      aggregationWindowSec: 3,
      enableLocalWhisper: true,
      whisperBaseUrl: 'http://127.0.0.1:9000',
    });
    const anaB = await instB.service.analyzeOrReuseVodHighlights({
      canonicalSourceId: twitchCanonicalId,
      sourceDescriptor: srcB.descriptor,
      requesterUserId: userB.id,
      workerId: 'instB_ana_2',
      preRollSec: 4,
      postRollSec: 4,
      segmentDurationSec: 4,
      cooldownSec: 12,
      scoreThreshold: 65,
      aggregationWindowSec: 3,
      enableLocalWhisper: true,
      whisperBaseUrl: 'http://127.0.0.1:9000',
    });

    expect(anaA.candidates).toHaveLength(3);
    expect(anaA.transcription).not.toBeNull();
    expect(anaB.reusedFromCache).toBe(true);
    expect(anaB.candidates).toHaveLength(3);
    // Whisper AND FFmpeg analysis ran STRICTLY ONCE across both users!
    expect(
      instA.service.metrics.whisperTranscriptionCount + instB.service.metrics.whisperTranscriptionCount,
    ).toBe(1);
    expect(instA.service.metrics.analysisPassCount + instB.service.metrics.analysisPassCount).toBe(1);

    // Layer C: Identical base clip reused across users; different candidate & render settings stay distinct!
    const clipA = await instA.service.generateOrReuseVodBaseClip({
      canonicalSourceId: twitchCanonicalId,
      sourceDescriptor: srcA.descriptor,
      candidate: anaA.candidates[0],
      requesterUserId: userA.id,
      workerId: 'instA_clip_1',
    });
    const clipB = await instB.service.generateOrReuseVodBaseClip({
      canonicalSourceId: twitchCanonicalId,
      sourceDescriptor: srcB.descriptor,
      candidate: anaB.candidates[0],
      requesterUserId: userB.id,
      workerId: 'instB_clip_2',
    });
    expect(clipA.reusedFromCache).toBe(false);
    expect(clipB.reusedFromCache).toBe(true);
    expect(clipB.cacheKey).toBe(clipA.cacheKey);
    expect(clipB.objectKey).toBe(clipA.objectKey);
    expect(instA.service.metrics.baseClipRenderCount + instB.service.metrics.baseClipRenderCount).toBe(1);

    // Probe real downloaded MP4 from MinIO
    const dlRes = await fetch(clipB.downloadUrl);
    expect(dlRes.ok).toBe(true);
    const bytes = Buffer.from(await dlRes.arrayBuffer());
    await fs.mkdir(workRootProbe, { recursive: true });
    const tmpMp4 = path.join(workRootProbe, 'vod-base-clip.mp4');
    await fs.writeFile(tmpMp4, bytes);
    const probed = await probeAndValidateClipMp4(tmpMp4, { requireAudio: true });
    expect(probed.sha256).toBe(clipA.contentSha256);
    expect(probed.videoCodec).toBe('h264');
    expect(probed.audioCodec).toBe('aac');
    expect(probed.width).toBe(1280);
    expect(probed.height).toBe(720);

    // Different candidate (Candidate #2) + different render settings (640x360) produce distinct cache keys!
    const clipCand2 = await instB.service.generateOrReuseVodBaseClip({
      canonicalSourceId: twitchCanonicalId,
      sourceDescriptor: srcB.descriptor,
      candidate: anaB.candidates[1],
      requesterUserId: userB.id,
      workerId: 'instB_clip_cand2',
    });
    expect(clipCand2.cacheKey).not.toBe(clipA.cacheKey);

    const clipVariant360 = await instB.service.generateOrReuseVodBaseClip({
      canonicalSourceId: twitchCanonicalId,
      sourceDescriptor: srcB.descriptor,
      candidate: anaB.candidates[0],
      requesterUserId: userB.id,
      workerId: 'instB_clip_360',
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
    expect(clipVariant360.cacheKey).not.toBe(clipA.cacheKey);
    expect(clipVariant360.clipMeta.width).toBe(640);
    expect(clipVariant360.clipMeta.height).toBe(360);

    // Different sourceRevision ('v2') stays completely isolated from 'v1'
    const srcV2 = await instB.service.acquireOrReuseVodSource({
      adapter: twitchAdapter,
      requesterUserId: userB.id,
      workerId: 'instB_src_v2',
      sourceRevision: 'v2',
    });
    expect(srcV2.cacheKey).not.toBe(srcA.cacheKey);
  }, 150_000);

  it('2. integrates private per-user Projects, EditTimelines & EditVersions over a shared VOD while isolating private edits and private uploads', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);
    const userA = await createTestUser('editA');
    const userB = await createTestUser('editB');

    const vodAdapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'youtube_video',
      vodId: `ytedit_${runTag}`,
      fixturePath: fixture30sPath,
    });
    const vodReg = vodAdapter.buildMediaSourceRegistration();
    const vodId = vodReg.canonicalId as any;
    createdSourceCanonicalIds.add(vodId);

    await instA.service.registry.registerOrGetMediaSource(vodReg);
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: vodId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b8',
    });

    const src = await instA.service.acquireOrReuseVodSource({
      adapter: vodAdapter,
      requesterUserId: userA.id,
      workerId: 'instA_edit_src',
    });
    const ana = await instA.service.analyzeOrReuseVodHighlights({
      canonicalSourceId: vodId,
      sourceDescriptor: src.descriptor,
      requesterUserId: userA.id,
      workerId: 'instA_edit_ana',
      preRollSec: 6,
      postRollSec: 4,
    });

    // Both independent users create their OWN private Project + EditTimeline + EditVersion referencing the SAME shared MediaSource!
    const sessA = await instA.service.createPrivateEditingSessionFromVod({
      requesterUserId: userA.id,
      canonicalSourceId: vodId,
      title: 'User A Viral Cut',
      candidates: ana.candidates,
    });
    const sessB = await instB.service.createPrivateEditingSessionFromVod({
      requesterUserId: userB.id,
      canonicalSourceId: vodId,
      title: 'User B Reaction Cut',
      candidates: ana.candidates,
    });

    expect(sessA.projectId).not.toBe(sessB.projectId);
    expect(sessA.timelineId).not.toBe(sessB.timelineId);
    expect(sessA.mediaSourceId).toBe(sessB.mediaSourceId);

    // User A applies a private PROMPT mode edit + renders owner-scoped private MP4!
    const editA = await instA.service.applyPrivateTimelineEdit({
      projectId: sessA.projectId,
      requesterUserId: userA.id,
      mode: 'prompt',
      versionName: 'Tighter punchy cut',
      userPrompt: 'Make it punchier around the spike with zooms',
      windowStartSec: 13,
      windowEndSec: 20,
      effects: { zooms: true },
      renderOutput: true,
      canonicalSourceId: vodId,
      sourceDescriptor: src.descriptor,
    });
    expect(editA.parentVersionId).toBe(sessA.rootVersionId);
    expect(editA.privateRender).toBeDefined();
    expect(editA.privateRender!.objectKey).toContain(`cache/private/${userA.id}/`);

    // User B applies a private MANUAL mode edit -> independent version tree
    const editB = await instB.service.applyPrivateTimelineEdit({
      projectId: sessB.projectId,
      requesterUserId: userB.id,
      mode: 'manual',
      versionName: 'Manual 15-21s trim',
      windowStartSec: 15,
      windowEndSec: 21,
      renderOutput: false,
    });
    expect(editB.parentVersionId).toBe(sessB.rootVersionId);

    // Cross-user project edit DENIED!
    await expect(
      instB.service.applyPrivateTimelineEdit({
        projectId: sessA.projectId,
        requesterUserId: userB.id,
        mode: 'manual',
        versionName: 'Unauthorized tamper',
        windowStartSec: 1,
        windowEndSec: 5,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // Cross-user access to User A's private render is isolated (resolves only User B's namespace -> SOURCE_UNAVAILABLE,
    // and direct object-key access to User A's private key is strictly DENIED with ACCESS_DENIED!)
    await expect(
      instB.service.publisher.getAuthorizedPublishedArtifact({
        requesterUserId: userB.id,
        canonicalSourceId: vodId,
        descriptor: editA.privateRender!.descriptor,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });

    const authB = await instB.service.registry.resolveServerTrustedAuth({
      requesterUserId: userB.id,
      canonicalSourceId: vodId,
    });
    await expect(
      instB.service.publisher.cache.createAuthorizedDownloadUrlForObject(
        authB.auth,
        editA.privateRender!.descriptor,
        editA.privateRender!.objectKey,
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // Private user upload remains strictly isolated to owner
    const uploadAdapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'private_user_upload',
      vodId: `privup_${runTag}`,
      ownerUserId: userA.id,
      fixturePath: fixture30sPath,
    });
    const upReg = uploadAdapter.buildMediaSourceRegistration();
    createdSourceCanonicalIds.add(upReg.canonicalId);
    await instA.service.registry.registerOrGetMediaSource(upReg);

    const upSrcA = await instA.service.acquireOrReuseVodSource({
      adapter: uploadAdapter,
      requesterUserId: userA.id,
      workerId: 'instA_privup',
    });
    expect(upSrcA.objectKey).toContain(`cache/private/${userA.id}/`);

    await expect(
      instB.service.acquireOrReuseVodSource({
        adapter: uploadAdapter,
        requesterUserId: userB.id,
        workerId: 'instB_privup_intrude',
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  }, 120_000);

  it('3. handles rights revocation racing publication, crashes during import/transcription, Redis loss, stale workers, corrupt/missing repair, and cache expiration', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);
    const userA = await createTestUser('failA');
    const userB = await createTestUser('failB');

    const vodAdapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'kick_vod',
      vodId: `kkfail_${runTag}`,
      channelName: 'fail_demo',
      fixturePath: fixture30sPath,
    });
    const reg = vodAdapter.buildMediaSourceRegistration();
    const vodId = reg.canonicalId as any;
    createdSourceCanonicalIds.add(vodId);

    await instA.service.registry.registerOrGetMediaSource(reg);
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: vodId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b8',
    });

    // 3a. Worker crash during VOD import -> aborts cleanly -> instB recovers & imports!
    await expect(
      instA.service.acquireOrReuseVodSource({
        adapter: vodAdapter,
        requesterUserId: userA.id,
        workerId: 'instA_crash_import',
        onDuringImport: async () => {
          throw new Error('Simulated crash during VOD import');
        },
      }),
    ).rejects.toThrow(/Simulated crash during VOD import/);

    const srcRecovered = await instB.service.acquireOrReuseVodSource({
      adapter: vodAdapter,
      requesterUserId: userB.id,
      workerId: 'instB_recover_import',
    });
    expect(srcRecovered.publishedGeneration).toBe(2);

    // 3b. Worker crash during Whisper transcription -> aborts cleanly -> instB recovers!
    await expect(
      instA.service.analyzeOrReuseVodHighlights({
        canonicalSourceId: vodId,
        sourceDescriptor: srcRecovered.descriptor,
        requesterUserId: userA.id,
        workerId: 'instA_crash_tx',
        enableLocalWhisper: true,
        onDuringTranscription: async () => {
          throw new Error('Simulated crash during transcription');
        },
      }),
    ).rejects.toThrow(/Simulated crash during transcription/);

    const anaRecovered = await instB.service.analyzeOrReuseVodHighlights({
      canonicalSourceId: vodId,
      sourceDescriptor: srcRecovered.descriptor,
      requesterUserId: userB.id,
      workerId: 'instB_recover_tx',
      enableLocalWhisper: true,
      customTranscribeFn: async () => ({
        language: 'en',
        durationSec: 30,
        segments: [{ start: 16, end: 19, text: 'Insane clutch highlight!' }],
        words: [{ start: 16.1, end: 16.5, word: 'Insane' }],
        avgConfidence: 0.95,
        model: 'base',
      }),
    });
    expect(anaRecovered.candidates.length).toBeGreaterThanOrEqual(1);
    expect(anaRecovered.transcription?.segments[0].text).toContain('Insane');

    // 3c. Missing/corrupt SOURCE_MEDIA object in MinIO -> detected & repaired cleanly!
    await storage.putObject({
      key: srcRecovered.objectKey,
      body: Buffer.alloc(srcRecovered.probed.sizeBytes, 0x33),
      contentType: 'video/mp4',
    });
    const srcRepaired = await instA.service.acquireOrReuseVodSource({
      adapter: vodAdapter,
      requesterUserId: userA.id,
      workerId: 'instA_repair_src',
    });
    expect(srcRepaired.publishedGeneration).toBe(3);
    expect(srcRepaired.objectKey).not.toBe(srcRecovered.objectKey);

    // 3d. Generate base clip, wipe Redis keys, verify reuse + corrupt clip repair + cache expiration!
    const clip1 = await instA.service.generateOrReuseVodBaseClip({
      canonicalSourceId: vodId,
      sourceDescriptor: srcRepaired.descriptor,
      candidate: anaRecovered.candidates[0],
      requesterUserId: userA.id,
      workerId: 'instA_clip1',
    });

    // Wipe Redis keys completely -> fresh reuse with 0 renders!
    const wipeKeys = await redis.keys(`${redisKeyPrefix}*`);
    if (wipeKeys.length > 0) await redis.del(...wipeKeys);

    const afterRedisWipe = await instB.service.generateOrReuseVodBaseClip({
      canonicalSourceId: vodId,
      sourceDescriptor: srcRepaired.descriptor,
      candidate: anaRecovered.candidates[0],
      requesterUserId: userB.id,
      workerId: 'instB_after_wipe',
    });
    expect(afterRedisWipe.reusedFromCache).toBe(true);
    expect(afterRedisWipe.objectKey).toBe(clip1.objectKey);

    // Corrupt cached MP4 -> repaired to gen=2!
    await storage.putObject({
      key: clip1.objectKey,
      body: Buffer.alloc(clip1.sizeBytes, 0x44),
      contentType: 'video/mp4',
    });
    const clipRepaired = await instB.service.generateOrReuseVodBaseClip({
      canonicalSourceId: vodId,
      sourceDescriptor: srcRepaired.descriptor,
      candidate: anaRecovered.candidates[0],
      requesterUserId: userB.id,
      workerId: 'instB_repair_clip',
    });
    expect(clipRepaired.publishedGeneration).toBe(2);

    // Cache expiration check: mark artifact expired -> getAuthorizedPublishedArtifact rejects!
    await db.sharedCacheArtifact.update({
      where: { cacheKey: clipRepaired.cacheKey },
      data: { expiresAt: new Date(Date.now() - 5_000) },
    });
    await expect(
      instA.service.publisher.getAuthorizedPublishedArtifact({
        requesterUserId: userA.id,
        canonicalSourceId: vodId,
        descriptor: clipRepaired.descriptor,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });

    // 3e. Rights revocation RACING WITH PUBLICATION (Section 8!) -> MUST FAIL CLOSED INSIDE TX!
    const raceVodAdapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'direct_media_recording',
      vodId: `revrace_${runTag}`,
      fixturePath: fixture30sPath,
    });
    const raceReg = raceVodAdapter.buildMediaSourceRegistration();
    const raceId = raceReg.canonicalId as any;
    createdSourceCanonicalIds.add(raceId);

    await instA.service.registry.registerOrGetMediaSource(raceReg);
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: raceId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b8',
    });
    const raceSrc = await instA.service.acquireOrReuseVodSource({
      adapter: raceVodAdapter,
      requesterUserId: userA.id,
      workerId: 'instA_revrace_src',
    });
    const raceAna = await instA.service.analyzeOrReuseVodHighlights({
      canonicalSourceId: raceId,
      sourceDescriptor: raceSrc.descriptor,
      requesterUserId: userA.id,
      workerId: 'instA_revrace_ana',
    });

    // Revoke rights INSIDE commitPublishedArtifact right before DB promotion!
    await expect(
      instA.service.generateOrReuseVodBaseClip({
        canonicalSourceId: raceId,
        sourceDescriptor: raceSrc.descriptor,
        candidate: raceAna.candidates[0],
        requesterUserId: userA.id,
        workerId: 'instA_revrace_clip',
        onInsideCommitTx: async () => {
          // Concurrent revocation commits on separate DB connection while clip worker holds row lock
          await instB.service.registry.revokeSourceRights({
            canonicalSourceId: raceId,
            revokedReason: 'Revoked mid-publication race test',
          });
        },
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // Verify clip was NEVER published!
    const uncommittedRow = await db.sharedCacheArtifact.findFirst({
      where: {
        mediaSource: { canonicalId: raceId },
        artifactKind: 'BASE_CLIP',
      },
    });
    expect(uncommittedRow?.state).not.toBe('PUBLISHED');
    expect(uncommittedRow?.publishedGeneration).toBe(0);
  }, 150_000);

  it('4. deduplicates 1,000 authorized VOD users across 2 instances (1 import, 1 analysis, 1 clip render) and enforces free-beta resource/cost controls', async () => {
    const instA = createService(workRootA);
    const instB = createService(workRootB);

    const vodAdapter = new ControlledVodAcquisitionAdapter({
      enabled: true,
      archetype: 'twitch_vod',
      vodId: `scale1000_${runTag}`,
      channelName: 'popular_vod',
      fixturePath: fixture30sPath,
    });
    const reg = vodAdapter.buildMediaSourceRegistration();
    const vodId = reg.canonicalId as any;
    createdSourceCanonicalIds.add(vodId);

    await instA.service.registry.registerOrGetMediaSource(reg);
    await instA.service.registry.grantSourceRights({
      canonicalSourceId: vodId,
      grantScope: 'SHARED_REUSE',
      allowAcquisition: true,
      allowSharedReuse: true,
      provenance: 'TEST_CONTROLLED_GRANT',
      grantedBy: 'test:step3b8',
    });

    const t0 = Date.now();
    // 1,000 concurrent authorized clippers across 2 independent instances requesting the SAME VOD!
    const results = await Promise.all(
      Array.from({ length: 1000 }, async (_, i) => {
        const svc = i % 2 === 0 ? instA.service : instB.service;
        const uid = `vod_clipper_${i}`;
        const wid = `vod_inst${i % 2 === 0 ? 'A' : 'B'}_w_${i}`;
        const src = await svc.acquireOrReuseVodSource({
          adapter: vodAdapter,
          requesterUserId: uid,
          workerId: wid,
        });
        const ana = await svc.analyzeOrReuseVodHighlights({
          canonicalSourceId: vodId,
          sourceDescriptor: src.descriptor,
          requesterUserId: uid,
          workerId: wid,
          preRollSec: 6,
          postRollSec: 4,
        });
        const clip = await svc.generateOrReuseVodBaseClip({
          canonicalSourceId: vodId,
          sourceDescriptor: src.descriptor,
          candidate: ana.candidates[0],
          requesterUserId: uid,
          workerId: wid,
        });
        return { src, ana, clip };
      }),
    );
    const totalMs = Date.now() - t0;

    // Strictly ONE source import, ONE analysis pass, ONE FFmpeg clip render across 1,000 clippers!
    expect(instA.service.metrics.sourceImportCount + instB.service.metrics.sourceImportCount).toBe(1);
    expect(instA.service.metrics.analysisPassCount + instB.service.metrics.analysisPassCount).toBe(1);
    expect(instA.service.metrics.baseClipRenderCount + instB.service.metrics.baseClipRenderCount).toBe(1);
    expect(new Set(results.map((r) => r.clip.cacheKey)).size).toBe(1);
    expect(new Set(results.map((r) => r.clip.objectKey)).size).toBe(1);

    // Free-beta cost & resource controls (Section 10):
    const strictGuard = new VodResourceGuard(
      {
        maxVodDurationSec: 10,
        maxSourceFileBytes: 100 * 1024 * 1024,
        maxConcurrentCpuJobs: 1,
        perUserMaxConcurrentJobs: 1,
        maxClipsPerUserPerDay: 2,
      },
      redis as any,
      `${quotaPrefix}strict:`,
    );

    // 1. Duration limit enforced (30s fixture > 10s maxVodDurationSec)
    await expect(vodAdapter.acquireAndValidate(strictGuard)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ACQUISITION',
    });

    // 2. File size limit enforced
    const tinySizeGuard = new VodResourceGuard({ maxSourceFileBytes: 1024 });
    await expect(vodAdapter.acquireAndValidate(tinySizeGuard)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ACQUISITION',
    });

    // 3. Per-user daily free-tier clip quota enforced (2 allowed, 3rd rejected)
    const quotaUser = `quota_u_${runTag}`;
    await strictGuard.consumeDailyClipQuota(quotaUser);
    await strictGuard.consumeDailyClipQuota(quotaUser);
    await expect(strictGuard.consumeDailyClipQuota(quotaUser)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });

    // 4. CPU concurrency semaphore bounds active parallel CPU jobs strictly <= maxConcurrentCpuJobs (1)
    let peakActive = 0;
    await Promise.all(
      Array.from({ length: 4 }, (_, idx) =>
        strictGuard.withCpuSlot(`cpu_u_${idx}`, async () => {
          peakActive = Math.max(peakActive, strictGuard.getActiveCpuJobs());
          await new Promise((r) => setTimeout(r, 25));
        }),
      ),
    );
    expect(peakActive).toBe(1);

    console.log(
      `[Step 3B.8 Measured] 1,000 VOD clippers across 2 instances=${totalMs}ms | imports=1 | analysis=1 | clipRenders=1 | cacheKey=${results[0].clip.cacheKey.slice(0, 12)}`,
    );
  }, 120_000);
});
