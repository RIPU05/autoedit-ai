import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  resolveMediaSourceFromUrl,
  resolveDirectUploadSource,
  assertAcquisitionPermitted,
  parseAndValidateSafeUrl,
  assertSafeRedirectTarget,
  assertSafeResolvedIp,
  SharedIngestionCoordinator,
  InMemoryCoordinationStore,
  RedisCoordinationStore,
  buildSharedCacheIdentity,
  assertCacheAccessAllowed,
  SharedArtifactCacheService,
  RollingMediaBufferTracker,
  CpuFirstHeuristicDetector,
  MediaSourceError,
} from '../../src/media/index.js';
import type { MediaStorageProvider } from '../../src/storage/storage.types.js';
import { connection as redis } from '../../src/lib/redis.js';

describe('Step 3B.4: Universal Media Source, Canonical Identity & Shared Ingestion Foundation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // 1. YouTube live and recorded URLs
  it('1. recognizes YouTube live and recorded VOD URLs distinctly', () => {
    const vod = resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(vod.provider).toBe('youtube');
    expect(vod.sourceType).toBe('vod');
    expect(vod.externalId).toBe('dQw4w9WgXcQ');
    expect(vod.canonicalId).toBe('youtube:vod:dQw4w9WgXcQ');
    expect(vod.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const live = resolveMediaSourceFromUrl('https://www.youtube.com/live/dQw4w9WgXcQ?si=track123');
    expect(live.provider).toBe('youtube');
    expect(live.sourceType).toBe('live');
    expect(live.canonicalId).toBe('youtube:live:dQw4w9WgXcQ');
    expect(live.metadata?.isLive).toBe(true);

    // Livestream and VOD do not automatically merge even if they share a video ID
    expect(live.canonicalId).not.toBe(vod.canonicalId);
  });

  // 2. Twitch live and VOD URLs
  it('2. recognizes Twitch live channels, VODs, and clips distinctly', () => {
    const live = resolveMediaSourceFromUrl('https://www.twitch.tv/Shroud?referrer=raid');
    expect(live.provider).toBe('twitch');
    expect(live.sourceType).toBe('live');
    expect(live.externalId).toBe('shroud');
    expect(live.canonicalId).toBe('twitch:live:shroud');

    const vod1 = resolveMediaSourceFromUrl('https://www.twitch.tv/videos/2284910293?t=01h12m05s');
    const vod2 = resolveMediaSourceFromUrl('https://m.twitch.tv/shroud/video/2284910293?utm_medium=social');
    expect(vod1.canonicalId).toBe('twitch:vod:2284910293');
    expect(vod2.canonicalId).toBe('twitch:vod:2284910293');
    expect(vod1.canonicalId).not.toBe(live.canonicalId);

    const clip1 = resolveMediaSourceFromUrl('https://clips.twitch.tv/AmazingClutchPlay123?tt_content=url');
    const clip2 = resolveMediaSourceFromUrl('https://www.twitch.tv/shroud/clip/AmazingClutchPlay123');
    expect(clip1.canonicalId).toBe('twitch:vod:clip_AmazingClutchPlay123');
    expect(clip2.canonicalId).toBe(clip1.canonicalId);
  });

  // 3. Kick live and VOD URLs
  it('3. recognizes Kick live channels, VODs, and clips distinctly', () => {
    const live = resolveMediaSourceFromUrl('https://kick.com/xQc?ref=home');
    expect(live.provider).toBe('kick');
    expect(live.sourceType).toBe('live');
    expect(live.canonicalId).toBe('kick:live:xqc');

    const vod1 = resolveMediaSourceFromUrl('https://kick.com/video/9f8a7b6c-1234-5678?utm_source=share');
    const vod2 = resolveMediaSourceFromUrl('https://www.kick.com/xqc/videos/9f8a7b6c-1234-5678');
    expect(vod1.canonicalId).toBe('kick:vod:9f8a7b6c-1234-5678');
    expect(vod2.canonicalId).toBe(vod1.canonicalId);
    expect(vod1.canonicalId).not.toBe(live.canonicalId);

    const clip = resolveMediaSourceFromUrl('https://kick.com/xqc/clips/clip_01JABC999');
    expect(clip.canonicalId).toBe('kick:vod:clip_clip_01JABC999');
  });

  // 4. Direct uploads
  it('4. maps direct uploads to distinct USER_OWNED canonical sources', () => {
    const uploadA = resolveDirectUploadSource({ assetId: 'asset_userA_001', durationSec: 42.5 });
    const uploadB = resolveDirectUploadSource({ assetId: 'asset_userB_002', durationSec: 42.5 });

    expect(uploadA.canonicalId).toBe('upload:uploaded:asset_userA_001');
    expect(uploadA.acquisitionCapability).toBe('DIRECT_UPLOAD');
    expect(uploadA.rightsStatus).toBe('USER_OWNED');
    expect(uploadA.ingestionStatus).toBe('READY');
    expect(uploadA.canonicalId).not.toBe(uploadB.canonicalId);

    expect(() => assertAcquisitionPermitted(uploadA)).not.toThrow();
  });

  // 5. Equivalent URLs mapping to one canonical identity
  it('5. maps equivalent URL variants with tracking params to one canonical source identity', () => {
    const variants = [
      'https://www.youtube.com/watch?v=GTA6Stream1&t=125s&si=abc123&utm_source=twitter',
      'https://youtu.be/GTA6Stream1?si=xyz999&feature=shared',
      'https://m.youtube.com/watch?v=GTA6Stream1&pp=ygUGZ3RhIDY%3D',
      'https://youtube.com/embed/GTA6Stream1?autoplay=1',
      'https://music.youtube.com/watch?v=GTA6Stream1&list=RD123',
      'https://www.youtube.com/shorts/GTA6Stream1?feature=share',
    ];

    const resolved = variants.map((u) => resolveMediaSourceFromUrl(u).canonicalId);
    expect(new Set(resolved).size).toBe(1);
    expect(resolved[0]).toBe('youtube:vod:GTA6Stream1');
  });

  // 6. Distinct broadcasts remaining distinct
  it('6. keeps distinct broadcasts, channels, and providers strictly separate', () => {
    const ids = [
      resolveMediaSourceFromUrl('https://www.youtube.com/live/StreamOne11').canonicalId,
      resolveMediaSourceFromUrl('https://www.youtube.com/live/StreamTwo22').canonicalId,
      resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=StreamOne11').canonicalId,
      resolveMediaSourceFromUrl('https://www.twitch.tv/gamer_one').canonicalId,
      resolveMediaSourceFromUrl('https://kick.com/gamer_one').canonicalId,
      resolveMediaSourceFromUrl('https://www.twitch.tv/videos/11111111').canonicalId,
      resolveMediaSourceFromUrl('https://www.twitch.tv/videos/22222222').canonicalId,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 7. Malformed and unsupported URLs
  it('7. rejects malformed URLs, invalid IDs, reserved paths, and control characters', () => {
    const badInputs = [
      '',
      '   ',
      'not a url',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch',
      'https://www.twitch.tv/directory',
      'https://www.twitch.tv/videos/notanumber',
      'https://kick.com/categories',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ\r\nX-Injected: true',
      `https://www.youtube.com/watch?v=dQw4w9WgXcQ&pad=${'a'.repeat(2100)}`,
    ];

    for (const bad of badInputs) {
      expect(() => resolveMediaSourceFromUrl(bad)).toThrow(MediaSourceError);
    }
  });

  // 8. SSRF and private-network protections
  it('8. blocks unsafe schemes, SSRF targets, private networks, metadata endpoints, and unsafe redirects', () => {
    const ssrfUrls = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ', // non-HTTPS blocked by default
      'https://user:secret@www.youtube.com/watch?v=dQw4w9WgXcQ', // embedded creds
      'https://localhost:4000/api/health',
      'https://api.localhost/video.mp4',
      'https://internal.service.local/stream.m3u8',
      'https://127.0.0.1/admin',
      'https://10.0.0.5/internal',
      'https://172.16.0.10/internal',
      'https://192.168.1.1/router',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://[::1]/secret',
      'https://[::ffff:127.0.0.1]/secret',
      'https://[fd00:ec2::254]/latest/meta-data/',
      'https://2130706433/loopback',
      'https://0x7f000001/loopback',
      'https://0177.0.0.1/loopback',
    ];

    for (const url of ssrfUrls) {
      expect(() => parseAndValidateSafeUrl(url)).toThrow(MediaSourceError);
    }

    // DNS resolved IP checks
    expect(() => assertSafeResolvedIp('127.0.0.1')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('169.254.169.254')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('10.20.30.40')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('::1')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('fe80::1')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('8.8.8.8')).not.toThrow();

    // Redirect safety check
    const allowed = new Set(['cdn.approved-media.example']);
    expect(() => assertSafeRedirectTarget('https://169.254.169.254/meta', allowed)).toThrow(MediaSourceError);
    expect(() => assertSafeRedirectTarget('https://evil.example/file.mp4', allowed)).toThrow(MediaSourceError);
    expect(() => assertSafeRedirectTarget('https://cdn.approved-media.example/clip.mp4', allowed)).not.toThrow();
  });

  // 9. Unknown providers failing closed
  it('9. fails closed on unknown or unapproved external hosts', () => {
    try {
      resolveMediaSourceFromUrl('https://vimeo.com/123456789');
      expect.unreachable('Should fail closed on unknown provider');
    } catch (err) {
      expect(err).toBeInstanceOf(MediaSourceError);
      expect((err as MediaSourceError).code).toBe('UNSUPPORTED_PROVIDER');
    }

    // Controlled direct media only succeeds when explicitly allowlisted
    const approved = resolveMediaSourceFromUrl('https://media.test-partner.example/samples/demo.mp4', {
      approvedDirectMediaHosts: new Set(['media.test-partner.example']),
    });
    expect(approved.provider).toBe('direct_media');
    expect(approved.acquisitionCapability).toBe('PERMITTED_DIRECT_URL');
    expect(() => assertAcquisitionPermitted(approved)).not.toThrow();
  });

  // 10 & 18. Unsupported acquisition capabilities & no unapproved external downloads
  it('10 & 18. represents unsupported acquisition clearly and prevents unapproved external downloads', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const yt = resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(yt.acquisitionCapability).toBe('UNSUPPORTED');
    expect(yt.rightsStatus).toBe('UNKNOWN');

    try {
      assertAcquisitionPermitted(yt);
      expect.unreachable('Should reject unsupported acquisition');
    } catch (err) {
      expect(err).toBeInstanceOf(MediaSourceError);
      expect((err as MediaSourceError).code).toBe('UNSUPPORTED_ACQUISITION');
    }

    // DRM-restricted source is explicitly blocked even if capability were present
    const drmSource = { ...yt, acquisitionCapability: 'APPROVED_API' as const, rightsStatus: 'RESTRICTED_DRM' as const };
    expect(() => assertAcquisitionPermitted(drmSource)).toThrow(/DRM-protected/);

    // No network downloads were ever attempted
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 11. Duplicate ingestion requests
  it('11. deduplicates duplicate ingestion requests for the same canonical source', async () => {
    const store = new InMemoryCoordinationStore();
    const coordinator = new SharedIngestionCoordinator(store);
    const sourceId = 'youtube:live:GTA6Launch1' as const;

    const first = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_1',
      workerId: 'worker_A',
      leaseMs: 30_000,
      nowMs: 1000,
    });
    expect(first.action).toBe('ACQUIRED_NEW');
    expect(first.deduplicated).toBe(false);
    expect(first.fencingToken).toBe(1);

    const second = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_2',
      workerId: 'worker_B',
      leaseMs: 30_000,
      nowMs: 2000,
    });
    expect(second.action).toBe('ATTACH_EXISTING');
    expect(second.deduplicated).toBe(true);
    expect(second.record.ownerWorkerId).toBe('worker_A');
    expect(second.record.requesters).toEqual(['clipper_1', 'clipper_2']);

    await coordinator.markReady({
      canonicalSourceId: sourceId,
      workerId: 'worker_A',
      fencingToken: 1,
      artifactRef: 'cache/shared/source_media/abc',
      nowMs: 5000,
    });

    const third = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_3',
      workerId: 'worker_C',
      nowMs: 6000,
    });
    expect(third.action).toBe('REUSE_READY');
    expect(third.deduplicated).toBe(true);
    expect(third.record.artifactRef).toBe('cache/shared/source_media/abc');
  });

  // 12. Lease expiration, fencing tokens, bounded retries, and worker recovery
  it('12. recovers safely after lease expiration, fences stale workers, and bounds retries', async () => {
    const store = new InMemoryCoordinationStore();
    const coordinator = new SharedIngestionCoordinator(store);
    const sourceId = 'twitch:live:gta6_streamer' as const;

    const initial = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_1',
      workerId: 'worker_crashed',
      leaseMs: 10_000,
      maxRetries: 2,
      nowMs: 1_000,
    });
    expect(initial.fencingToken).toBe(1);

    // Lease renewal works while active
    const renewed = await coordinator.renewLease({
      canonicalSourceId: sourceId,
      workerId: 'worker_crashed',
      fencingToken: 1,
      leaseMs: 10_000,
      nowMs: 5_000,
    });
    expect(renewed.leaseExpiresAtMs).toBe(15_000);

    // Simulate worker_crashed dying; at t=20_000 lease has expired -> worker_recovery takes over
    const recovered = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_2',
      workerId: 'worker_recovery',
      leaseMs: 10_000,
      maxRetries: 2,
      nowMs: 20_000,
    });
    expect(recovered.action).toBe('ACQUIRED_RECOVERY');
    expect(recovered.fencingToken).toBe(2);
    expect(recovered.record.ownerWorkerId).toBe('worker_recovery');
    expect(recovered.record.attempts).toBe(2);

    // Stale crashed worker cannot corrupt state with old fencingToken 1
    await expect(
      coordinator.markReady({
        canonicalSourceId: sourceId,
        workerId: 'worker_crashed',
        fencingToken: 1,
        artifactRef: 'corrupt/ref',
        nowMs: 21_000,
      }),
    ).rejects.toThrow(MediaSourceError);

    // If recovery worker also crashes (past t=30_000), maxRetries=2 is exhausted -> FAILED_MAX_RETRIES
    const exhausted = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_3',
      workerId: 'worker_3',
      leaseMs: 10_000,
      maxRetries: 2,
      nowMs: 35_000,
    });
    expect(exhausted.action).toBe('FAILED_MAX_RETRIES');
    expect(exhausted.record.state).toBe('FAILED');
  });

  // 13, 14, 15. Shared cache identity, identical base clip reuse, and parameter sensitivity
  it('13-15. produces deterministic shared cache identities and isolates differing edit/render params', async () => {
    const baseClipA = buildSharedCacheIdentity({
      artifactKind: 'BASE_CLIP',
      canonicalSourceId: 'youtube:vod:GTA6Stream1',
      sourceRevision: 'rev1',
      timeRangeSec: { start: 120.5, end: 180.5 },
      algorithmVersion: 'ffmpeg-v1',
      renderSettings: {
        format: 'reel',
        width: 1080,
        height: 1920,
        fps: 30,
        subtitles: false,
        zooms: false,
        transitions: 'none',
        music: false,
      },
      rightsScope: 'SHARED_PERMITTED',
    });

    // Identical clip requested by a different clipper resolves to the exact same cacheKey & storageKey
    const baseClipB = buildSharedCacheIdentity({
      artifactKind: 'BASE_CLIP',
      canonicalSourceId: 'youtube:vod:GTA6Stream1',
      sourceRevision: 'rev1',
      timeRangeSec: { start: 120.5, end: 180.5 },
      algorithmVersion: 'ffmpeg-v1',
      renderSettings: {
        format: 'reel',
        width: 1080,
        height: 1920,
        fps: 30,
        subtitles: false,
        zooms: false,
        transitions: 'none',
        music: false,
      },
      rightsScope: 'SHARED_PERMITTED',
    });
    expect(baseClipA.cacheKey).toBe(baseClipB.cacheKey);
    expect(baseClipA.storageKey).toBe(baseClipB.storageKey);
    expect(baseClipA.storageKey.startsWith('cache/shared/base_clip/')).toBe(true);

    // Different time range -> different key
    const diffRange = buildSharedCacheIdentity({
      artifactKind: 'BASE_CLIP',
      canonicalSourceId: 'youtube:vod:GTA6Stream1',
      sourceRevision: 'rev1',
      timeRangeSec: { start: 121.0, end: 180.5 },
      algorithmVersion: 'ffmpeg-v1',
      renderSettings: {
        format: 'reel',
        width: 1080,
        height: 1920,
        fps: 30,
        subtitles: false,
        zooms: false,
        transitions: 'none',
        music: false,
      },
      rightsScope: 'SHARED_PERMITTED',
    });
    expect(diffRange.cacheKey).not.toBe(baseClipA.cacheKey);

    // Different render setting (subtitles enabled) -> different key
    const diffSubtitles = buildSharedCacheIdentity({
      artifactKind: 'BASE_CLIP',
      canonicalSourceId: 'youtube:vod:GTA6Stream1',
      sourceRevision: 'rev1',
      timeRangeSec: { start: 120.5, end: 180.5 },
      algorithmVersion: 'ffmpeg-v1',
      renderSettings: {
        format: 'reel',
        width: 1080,
        height: 1920,
        fps: 30,
        subtitles: true,
        zooms: false,
        transitions: 'none',
        music: false,
      },
      rightsScope: 'SHARED_PERMITTED',
    });
    expect(diffSubtitles.cacheKey).not.toBe(baseClipA.cacheKey);

    // Verify storage provider reuse via SharedArtifactCacheService
    const objects = new Map<string, Buffer>();
    const mockStorage = {
      putObject: vi.fn(async ({ key, body }: { key: string; body: Buffer }) => {
        objects.set(key, Buffer.from(body));
        return { key, bucket: 'autoedit-local' };
      }),
      getObjectMetadata: vi.fn(async ({ key }: { key: string }) => {
        const buf = objects.get(key);
        if (!buf) throw new Error('NotFound');
        return { key, bucket: 'autoedit-local', contentLength: buf.length };
      }),
      createDownloadUrl: vi.fn(async ({ key }: { key: string }) => `http://127.0.0.1:9002/signed/${key}`),
    } as unknown as MediaStorageProvider;

    const cache = new SharedArtifactCacheService(mockStorage);
    await cache.putCachedArtifact(
      { identity: baseClipA, requesterUserId: 'clipper_1', sourceRightsStatus: 'PERMITTED_PUBLIC' },
      Buffer.from('fake-mp4-bytes'),
      'video/mp4',
    );

    // Clipper 2 gets a cache HIT on the exact same base clip without re-rendering
    const hit = await cache.checkCachedArtifact({
      identity: baseClipB,
      requesterUserId: 'clipper_2',
      sourceRightsStatus: 'PERMITTED_PUBLIC',
    });
    expect(hit.hit).toBe(true);
    expect(hit.sizeBytes).toBe(14);
  });

  // 16 & 17. Private timeline isolation & cross-user access denial
  it('16 & 17. enforces private timeline isolation and denies cross-user or unpermitted cache access', () => {
    // Direct uploads cannot be placed in SHARED_PERMITTED scope
    expect(() =>
      buildSharedCacheIdentity({
        artifactKind: 'SOURCE_MEDIA',
        canonicalSourceId: 'upload:uploaded:asset_private_1',
        sourceRevision: 'v1',
        algorithmVersion: 'v1',
        rightsScope: 'SHARED_PERMITTED',
      }),
    ).toThrow(MediaSourceError);

    // Personalized edits (customEditHash) cannot be placed in SHARED_PERMITTED scope
    expect(() =>
      buildSharedCacheIdentity({
        artifactKind: 'BASE_CLIP',
        canonicalSourceId: 'youtube:vod:GTA6Stream1',
        sourceRevision: 'v1',
        algorithmVersion: 'v1',
        renderSettings: {
          format: 'reel',
          width: 1080,
          height: 1920,
          fps: 30,
          subtitles: true,
          zooms: true,
          transitions: 'fade',
          music: true,
          customEditHash: 'userA_custom_prompt_edit_999',
        },
        rightsScope: 'SHARED_PERMITTED',
      }),
    ).toThrow(MediaSourceError);

    // Private cache artifacts are isolated per ownerUserId
    const userA = buildSharedCacheIdentity({
      artifactKind: 'BASE_CLIP',
      canonicalSourceId: 'youtube:vod:GTA6Stream1',
      sourceRevision: 'v1',
      algorithmVersion: 'v1',
      renderSettings: {
        format: 'reel',
        width: 1080,
        height: 1920,
        fps: 30,
        subtitles: true,
        zooms: false,
        transitions: 'none',
        music: false,
        customEditHash: 'edit_hash_1',
      },
      rightsScope: 'PRIVATE_USER',
      ownerUserId: 'user_A',
    });
    expect(userA.storageKey.startsWith('cache/private/user_A/')).toBe(true);

    // User A succeeds
    expect(() =>
      assertCacheAccessAllowed({
        identity: userA,
        requesterUserId: 'user_A',
        sourceRightsStatus: 'PERMITTED_PUBLIC',
      }),
    ).not.toThrow();

    // User B is strictly denied cross-user access
    expect(() =>
      assertCacheAccessAllowed({
        identity: userA,
        requesterUserId: 'user_B',
        sourceRightsStatus: 'PERMITTED_PUBLIC',
      }),
    ).toThrow(/Cross-user access/);

    // Unverified/DRM rights denied even on SHARED_PERMITTED artifacts
    const sharedClip = buildSharedCacheIdentity({
      artifactKind: 'TRANSCRIPTION',
      canonicalSourceId: 'twitch:vod:2284910293',
      sourceRevision: 'v1',
      algorithmVersion: 'whisper:base',
      rightsScope: 'SHARED_PERMITTED',
    });
    expect(() =>
      assertCacheAccessAllowed({
        identity: sharedClip,
        requesterUserId: 'user_A',
        sourceRightsStatus: 'UNKNOWN',
      }),
    ).toThrow(/RIGHTS_UNVERIFIED|not PERMITTED_PUBLIC/);
    expect(() =>
      assertCacheAccessAllowed({
        identity: sharedClip,
        requesterUserId: 'user_A',
        sourceRightsStatus: 'RESTRICTED_DRM',
      }),
    ).toThrow(/DRM-restricted/);
  });

  // 19. Deterministic local concurrency test: 1,000 clippers -> 1 source identity -> 1 coordinated work item
  it('19. coordinates 1,000 concurrent clipper requests into 1 canonical identity and 1 active work item', async () => {
    const store = new InMemoryCoordinationStore();
    const coordinator = new SharedIngestionCoordinator(store);

    const urlTemplates = [
      (i: number) => `https://www.youtube.com/live/GTA6Live999?si=track_${i}&utm_campaign=c${i}`,
      (i: number) => `https://m.youtube.com/live/GTA6Live999?feature=share_${i}`,
      (i: number) => `https://youtube.com/live/GTA6Live999?ref=clipper_${i}`,
    ];

    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => {
        const url = urlTemplates[i % urlTemplates.length](i);
        const source = resolveMediaSourceFromUrl(url);
        return coordinator.requestIngestion({
          canonicalSourceId: source.canonicalId,
          requesterId: `clipper_${i}`,
          workerId: `worker_${i % 10}`,
          leaseMs: 60_000,
          nowMs: 10_000,
        });
      }),
    );

    const canonicalIds = new Set(results.map((r) => r.record.canonicalSourceId));
    expect(canonicalIds.size).toBe(1);
    expect([...canonicalIds][0]).toBe('youtube:live:GTA6Live999');

    const acquiredNew = results.filter((r) => r.action === 'ACQUIRED_NEW');
    const attachedExisting = results.filter((r) => r.action === 'ATTACH_EXISTING');
    expect(acquiredNew).toHaveLength(1);
    expect(attachedExisting).toHaveLength(999);
  });

  // 20. Real local Redis coordination primitive smoke check (Lua atomic script)
  it('20. executes atomic Redis Lua coordination on local Redis for deduplication and crash recovery', async () => {
    const testKeyPrefix = `autoedit:test:coord:${Date.now()}:`;
    const redisStore = new RedisCoordinationStore(redis as any, {
      keyPrefix: testKeyPrefix,
      recordTtlMs: 30_000,
    });
    const coordinator = new SharedIngestionCoordinator(redisStore);
    const sourceId = 'kick:live:gta6_test_stream' as const;

    const r1 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'redis_clipper_1',
      workerId: 'redis_worker_1',
      leaseMs: 5_000,
      nowMs: 1_000,
    });
    expect(r1.action).toBe('ACQUIRED_NEW');
    expect(r1.fencingToken).toBe(1);

    const r2 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'redis_clipper_2',
      workerId: 'redis_worker_2',
      leaseMs: 5_000,
      nowMs: 2_000,
    });
    expect(r2.action).toBe('ATTACH_EXISTING');
    expect(r2.deduplicated).toBe(true);

    // Crash recovery after lease expiry
    const r3 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'redis_clipper_3',
      workerId: 'redis_worker_3',
      leaseMs: 5_000,
      nowMs: 10_000,
    });
    expect(r3.action).toBe('ACQUIRED_RECOVERY');
    expect(r3.fencingToken).toBe(2);

    // Clean up test key in Redis
    await redis.del(`${testKeyPrefix}${sourceId}`);
  });

  // 21. CPU-first live highlight detector + configurable rolling buffer
  it('21. detects highlights on CPU with configurable rolling windows and optional chat signals', () => {
    // Configurable rolling buffer (non-hardcoded)
    const customBuffer = new RollingMediaBufferTracker({
      preEventSec: 30,
      postEventSec: 10,
      segmentDurationSec: 6,
    });
    const win = customBuffer.computeCandidateWindow(100);
    expect(win.windowStartSec).toBe(70);
    expect(win.windowEndSec).toBe(110);
    expect(win.pinnedSegmentIndices).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);

    // Default 45s pre + 15s post detector works even WITHOUT live chat signals
    const detector = new CpuFirstHeuristicDetector({
      canonicalSourceId: 'youtube:live:GTA6Live999',
      scoreThreshold: 70,
    });
    expect(detector.getRollingBufferConfig().preEventSec).toBe(45);
    expect(detector.getRollingBufferConfig().postEventSec).toBe(15);

    detector.ingestSignal({
      timestampSec: 120,
      signalKind: 'AUDIO_ENERGY',
      normalizedIntensity: 0.92,
      keywords: [],
    });
    detector.ingestSignal({
      timestampSec: 121,
      signalKind: 'SPEECH_ACTIVITY',
      normalizedIntensity: 0.85,
      keywords: [],
    });

    const candidates = detector.evaluate(130);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].windowStartSec).toBe(75); // 120 - 45
    expect(candidates[0].windowEndSec).toBe(135); // 120 + 15
    expect(candidates[0].compositeScore).toBeGreaterThanOrEqual(70);
    expect(candidates[0].contributingSignals).toContain('AUDIO_ENERGY');
    expect(candidates[0].contributingSignals).toContain('SPEECH_ACTIVITY');
  });
});
