import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  resolveMediaSourceFromUrl,
  resolveDirectUploadSource,
  bindVerifiedBroadcastSession,
  assertAcquisitionPermitted,
  parseAndValidateSafeUrl,
  assertSafeRedirectTarget,
  assertSafeResolvedIp,
  SharedIngestionCoordinator,
  InMemoryCoordinationStore,
  RedisCoordinationStore,
  buildSharedCacheIdentity,
  createTrustedCacheAuthContext,
  resolveAuthorizedCacheIdentity,
  assertVerifiedCacheIdentity,
  SharedArtifactCacheService,
  RollingMediaBufferTracker,
  CpuFirstHeuristicDetector,
  MediaSourceError,
} from '../../src/media/index.js';
import type { MediaStorageProvider } from '../../src/storage/storage.types.js';
import { connection as redis } from '../../src/lib/redis.js';

describe('Step 3B.4 & 3B.4.1: Universal Media Source, Channel/Broadcast Identity, Coordination & Cache Authorization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // 1. YouTube live broadcast vs recorded VOD URLs
  it('1. resolves YouTube live broadcasts and recorded VODs distinctly without merging', () => {
    const vod = resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(vod.provider).toBe('youtube');
    expect(vod.sourceType).toBe('vod');
    expect(vod.identityScope).toBe('IMMUTABLE_VOD');
    expect(vod.canonicalId).toBe('youtube:vod:dQw4w9WgXcQ');
    expect(vod.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const broadcast = resolveMediaSourceFromUrl('https://www.youtube.com/live/dQw4w9WgXcQ?si=track123');
    expect(broadcast.provider).toBe('youtube');
    expect(broadcast.sourceType).toBe('live');
    expect(broadcast.identityScope).toBe('IMMUTABLE_BROADCAST');
    expect(broadcast.broadcastId).toBe('dQw4w9WgXcQ');
    expect(broadcast.canonicalId).toBe('youtube:broadcast:dQw4w9WgXcQ');

    // Livestream and later VOD remain distinct even with the same YouTube video ID
    expect(broadcast.canonicalId).not.toBe(vod.canonicalId);
  });

  // 2. Same channel, different broadcast identities + Channel-only URL blocks immutable cache/ingestion
  it('2. separates ChannelIdentity from BroadcastIdentity and keeps consecutive broadcasts distinct', async () => {
    const twitchChannel = resolveMediaSourceFromUrl('https://www.twitch.tv/Shroud?referrer=raid');
    expect(twitchChannel.canonicalId).toBe('twitch:channel:shroud');
    expect(twitchChannel.identityScope).toBe('CHANNEL_DISCOVERY');
    expect(twitchChannel.channelId).toBe('twitch:channel:shroud');
    expect(twitchChannel.broadcastId).toBeUndefined();

    const kickChannel = resolveMediaSourceFromUrl('https://kick.com/xQc?ref=home');
    expect(kickChannel.canonicalId).toBe('kick:channel:xqc');
    expect(kickChannel.identityScope).toBe('CHANNEL_DISCOVERY');

    // Channel-only URL cannot start acquisition, coordinate ingestion, or authorize immutable cache reuse
    expect(() => assertAcquisitionPermitted(twitchChannel)).toThrow(MediaSourceError);
    try {
      assertAcquisitionPermitted(twitchChannel);
    } catch (err) {
      expect((err as MediaSourceError).code).toBe('BROADCAST_UNRESOLVED');
    }

    const coordinator = new SharedIngestionCoordinator(new InMemoryCoordinationStore());
    await expect(
      coordinator.requestIngestion({
        canonicalSourceId: twitchChannel.canonicalId,
        requesterId: 'clipper_1',
        workerId: 'worker_1',
      }),
    ).rejects.toThrow(/channel-only IDs are rejected/);

    expect(() =>
      createTrustedCacheAuthContext({
        source: twitchChannel,
        requesterUserId: 'clipper_1',
        allowSharedCacheReuse: true,
      }),
    ).toThrow(/verified broadcast session ID is required/);

    expect(() =>
      buildSharedCacheIdentity({
        artifactKind: 'SOURCE_MEDIA',
        canonicalSourceId: twitchChannel.canonicalId as any,
        sourceRevision: 'v1',
        algorithmVersion: 'v1',
        rightsScope: 'SHARED_PERMITTED',
      }),
    ).toThrow(/Channel-only identity/);

    // Streamer starts Monday broadcast (session 41928374650), ends it, then starts Tuesday broadcast (41928399999)
    const mondayBroadcast = bindVerifiedBroadcastSession(
      { ...twitchChannel, rightsStatus: 'PERMITTED_PUBLIC', acquisitionCapability: 'PERMITTED_STREAM' },
      { broadcastId: '41928374650' },
    );
    const tuesdayBroadcast = bindVerifiedBroadcastSession(
      { ...twitchChannel, rightsStatus: 'PERMITTED_PUBLIC', acquisitionCapability: 'PERMITTED_STREAM' },
      { broadcastId: '41928399999' },
    );

    expect(mondayBroadcast.identityScope).toBe('IMMUTABLE_BROADCAST');
    expect(mondayBroadcast.canonicalId).toBe('twitch:broadcast:shroud:41928374650');
    expect(tuesdayBroadcast.canonicalId).toBe('twitch:broadcast:shroud:41928399999');
    expect(mondayBroadcast.canonicalId).not.toBe(tuesdayBroadcast.canonicalId);

    // Distinct broadcasts do not share cache keys or ingestion records
    const mondayAuth = createTrustedCacheAuthContext({
      source: mondayBroadcast,
      requesterUserId: 'clipper_1',
      allowSharedCacheReuse: true,
    });
    const tuesdayAuth = createTrustedCacheAuthContext({
      source: tuesdayBroadcast,
      requesterUserId: 'clipper_1',
      allowSharedCacheReuse: true,
    });
    const monKey = resolveAuthorizedCacheIdentity(mondayAuth, {
      artifactKind: 'SOURCE_MEDIA',
      rightsScope: 'SHARED_PERMITTED',
    });
    const tueKey = resolveAuthorizedCacheIdentity(tuesdayAuth, {
      artifactKind: 'SOURCE_MEDIA',
      rightsScope: 'SHARED_PERMITTED',
    });
    expect(monKey.cacheKey).not.toBe(tueKey.cacheKey);

    // Later VOD from same channel remains distinct from both live broadcasts
    const vod = resolveMediaSourceFromUrl('https://www.twitch.tv/videos/2284910293');
    expect(vod.canonicalId).toBe('twitch:vod:2284910293');
    expect(vod.canonicalId).not.toBe(mondayBroadcast.canonicalId);
  });

  // 3. Canonical VOD normalization across YouTube, Twitch, and Kick
  it('3. preserves canonical VOD and clip URL normalization across YouTube, Twitch, and Kick', () => {
    const ytVariants = [
      'https://www.youtube.com/watch?v=GTA6Stream1&t=125s&si=abc123&utm_source=twitter',
      'https://youtu.be/GTA6Stream1?si=xyz999&feature=shared',
      'https://m.youtube.com/watch?v=GTA6Stream1&pp=ygUGZ3RhIDY%3D',
      'https://youtube.com/embed/GTA6Stream1?autoplay=1',
      'https://www.youtube.com/shorts/GTA6Stream1?feature=share',
    ];
    expect(new Set(ytVariants.map((u) => resolveMediaSourceFromUrl(u).canonicalId))).toEqual(
      new Set(['youtube:vod:GTA6Stream1']),
    );

    const twitchVod1 = resolveMediaSourceFromUrl('https://www.twitch.tv/videos/2284910293?t=01h12m05s');
    const twitchVod2 = resolveMediaSourceFromUrl('https://m.twitch.tv/shroud/video/2284910293?utm_medium=social');
    expect(twitchVod1.canonicalId).toBe('twitch:vod:2284910293');
    expect(twitchVod2.canonicalId).toBe(twitchVod1.canonicalId);

    const kickVod1 = resolveMediaSourceFromUrl('https://kick.com/video/9f8a7b6c-1234-5678?utm_source=share');
    const kickVod2 = resolveMediaSourceFromUrl('https://www.kick.com/xqc/videos/9f8a7b6c-1234-5678');
    expect(kickVod1.canonicalId).toBe('kick:vod:9f8a7b6c-1234-5678');
    expect(kickVod2.canonicalId).toBe(kickVod1.canonicalId);
  });

  // 4. Direct uploads remain USER_OWNED and isolated
  it('4. maps direct uploads to distinct IMMUTABLE_UPLOAD USER_OWNED sources', () => {
    const uploadA = resolveDirectUploadSource({ assetId: 'asset_userA_001', durationSec: 42.5 });
    const uploadB = resolveDirectUploadSource({ assetId: 'asset_userB_002', durationSec: 42.5 });

    expect(uploadA.canonicalId).toBe('upload:uploaded:asset_userA_001');
    expect(uploadA.identityScope).toBe('IMMUTABLE_UPLOAD');
    expect(uploadA.acquisitionCapability).toBe('DIRECT_UPLOAD');
    expect(uploadA.rightsStatus).toBe('USER_OWNED');
    expect(uploadA.canonicalId).not.toBe(uploadB.canonicalId);
    expect(() => assertAcquisitionPermitted(uploadA)).not.toThrow();
  });

  // 5. Approved direct-media host defaults strictly to UNKNOWN rights & UNSUPPORTED acquisition
  it('5. defaults approved direct-media hosts to UNKNOWN rights and requires explicit authorization', () => {
    const approvedHosts = new Set(['media.test-partner.example']);
    const url = 'https://media.test-partner.example/samples/demo.mp4';

    // Host allowlist alone -> safe network destination ONLY, NOT copying/sharing permission!
    const unverified = resolveMediaSourceFromUrl(url, { approvedDirectMediaHosts: approvedHosts });
    expect(unverified.provider).toBe('direct_media');
    expect(unverified.rightsStatus).toBe('UNKNOWN');
    expect(unverified.acquisitionCapability).toBe('UNSUPPORTED');
    expect(() => assertAcquisitionPermitted(unverified)).toThrow(MediaSourceError);

    // Explicitly DENIED direct media
    const denied = resolveMediaSourceFromUrl(url, {
      approvedDirectMediaHosts: approvedHosts,
      directMediaAuthorization: {
        rightsStatus: 'DENIED',
        acquisitionCapability: 'PERMITTED_DIRECT_URL',
      },
    });
    expect(() => assertAcquisitionPermitted(denied)).toThrow(/requires explicit rights authorization/);

    // Explicitly USER_OWNED direct media (import allowed, but cross-user shared cache DENIED)
    const userOwned = resolveMediaSourceFromUrl(url, {
      approvedDirectMediaHosts: approvedHosts,
      directMediaAuthorization: {
        rightsStatus: 'USER_OWNED',
        acquisitionCapability: 'PERMITTED_DIRECT_URL',
      },
    });
    expect(() => assertAcquisitionPermitted(userOwned)).not.toThrow();
    const userOwnedAuth = createTrustedCacheAuthContext({
      source: userOwned,
      requesterUserId: 'user_A',
      ownerUserId: 'user_A',
      allowSharedCacheReuse: true, // even if true, USER_OWNED cannot enter SHARED_PERMITTED!
    });
    expect(userOwnedAuth.allowSharedCacheReuse).toBe(false);
    expect(() =>
      resolveAuthorizedCacheIdentity(userOwnedAuth, {
        artifactKind: 'BASE_CLIP',
        rightsScope: 'SHARED_PERMITTED',
      }),
    ).toThrow(/Shared cache reuse denied/);
    // Private cache for user_A succeeds
    const privId = resolveAuthorizedCacheIdentity(userOwnedAuth, {
      artifactKind: 'BASE_CLIP',
      rightsScope: 'PRIVATE_USER',
    });
    expect(privId.storageKey.startsWith('cache/private/user_A/')).toBe(true);

    // Explicitly PERMITTED_PUBLIC direct media (import allowed AND shared cache allowed when policy grants it)
    const sharedPermitted = resolveMediaSourceFromUrl(url, {
      approvedDirectMediaHosts: approvedHosts,
      directMediaAuthorization: {
        rightsStatus: 'PERMITTED_PUBLIC',
        acquisitionCapability: 'PERMITTED_DIRECT_URL',
      },
    });
    expect(() => assertAcquisitionPermitted(sharedPermitted)).not.toThrow();
    const sharedAuth = createTrustedCacheAuthContext({
      source: sharedPermitted,
      requesterUserId: 'clipper_1',
      allowSharedCacheReuse: true,
    });
    const sharedId = resolveAuthorizedCacheIdentity(sharedAuth, {
      artifactKind: 'BASE_CLIP',
      rightsScope: 'SHARED_PERMITTED',
    });
    expect(sharedId.storageKey.startsWith('cache/shared/base_clip/')).toBe(true);
  });

  // 6. Malformed URLs, unknown hosts, SSRF, private networks, metadata endpoints & redirects
  it('6. blocks malformed URLs, unknown providers, SSRF, private networks, and unsafe redirects', () => {
    const ssrfAndBad = [
      '',
      'not a url',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://localhost:4000/api/health',
      'https://127.0.0.1/admin',
      'https://10.0.0.5/internal',
      'https://172.16.0.10/internal',
      'https://192.168.1.1/router',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://[::1]/secret',
      'https://[::ffff:127.0.0.1]/secret',
      'https://2130706433/loopback',
      'https://0x7f000001/loopback',
      'https://vimeo.com/123456789',
    ];
    for (const bad of ssrfAndBad) {
      expect(() => resolveMediaSourceFromUrl(bad)).toThrow(MediaSourceError);
    }

    expect(() => parseAndValidateSafeUrl('https://169.254.169.254/')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('127.0.0.1')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('169.254.169.254')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('8.8.8.8')).not.toThrow();

    const allowed = new Set(['cdn.approved-media.example']);
    expect(() => assertSafeRedirectTarget('https://169.254.169.254/meta', allowed)).toThrow(MediaSourceError);
    expect(() => assertSafeRedirectTarget('https://cdn.approved-media.example/clip.mp4', allowed)).not.toThrow();
  });

  // 7. Server-trusted cache authorization: rejects forged rights claims & forged private storage keys
  it('7. rejects forged rights claims and forged private storage identities before touching storage', async () => {
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

    // 7a. Forged plain-object auth context claiming PERMITTED_PUBLIC is rejected!
    const forgedAuth = {
      source: resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=GTA6Stream1'),
      requesterUserId: 'attacker',
      verifiedRightsStatus: 'PERMITTED_PUBLIC',
      allowSharedCacheReuse: true,
    } as any;

    await expect(
      cache.checkCachedArtifact(forgedAuth, { artifactKind: 'BASE_CLIP', rightsScope: 'SHARED_PERMITTED' }),
    ).rejects.toThrow(/Untrusted or forged cache authorization context/);
    await expect(
      cache.createAuthorizedDownloadUrl(forgedAuth, { artifactKind: 'BASE_CLIP', rightsScope: 'SHARED_PERMITTED' }),
    ).rejects.toThrow(/Untrusted or forged cache authorization context/);
    expect(mockStorage.getObjectMetadata).not.toHaveBeenCalled();
    expect(mockStorage.createDownloadUrl).not.toHaveBeenCalled();

    // 7b. Forged private storage key substitution rejected by assertVerifiedCacheIdentity
    const uploadA = resolveDirectUploadSource({ assetId: 'asset_userA_secret' });
    const authUserA = createTrustedCacheAuthContext({
      source: uploadA,
      requesterUserId: 'user_A',
      ownerUserId: 'user_A',
    });
    const idA = resolveAuthorizedCacheIdentity(authUserA, {
      artifactKind: 'BASE_CLIP',
      rightsScope: 'PRIVATE_USER',
    });

    const uploadB = resolveDirectUploadSource({ assetId: 'asset_userB_own' });
    const authUserB = createTrustedCacheAuthContext({
      source: uploadB,
      requesterUserId: 'user_B',
      ownerUserId: 'user_B',
    });

    // User B tries to substitute User A's storageKey
    expect(() =>
      assertVerifiedCacheIdentity(
        authUserB,
        { artifactKind: 'BASE_CLIP', rightsScope: 'PRIVATE_USER' },
        { ...idA, ownerUserId: 'user_B' },
      ),
    ).toThrow(/Forged or substituted cache identity/);

    // User B trying to access User A's upload directly is rejected before touching storage
    const crossUserAuth = createTrustedCacheAuthContext({
      source: uploadA,
      requesterUserId: 'user_B',
      ownerUserId: 'user_A',
    });
    await expect(
      cache.createAuthorizedDownloadUrl(crossUserAuth, {
        artifactKind: 'BASE_CLIP',
        rightsScope: 'PRIVATE_USER',
      }),
    ).rejects.toThrow(/Cross-user access/);
    expect(mockStorage.createDownloadUrl).not.toHaveBeenCalled();
  });

  // 8. Shared cache reuse with verified permissions & parameter isolation
  it('8. reuses identical permitted base clips across clippers and isolates different revisions/edits', async () => {
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
    const verifiedSource = resolveMediaSourceFromUrl('https://media.test-partner.example/gta6.mp4', {
      approvedDirectMediaHosts: new Set(['media.test-partner.example']),
      directMediaAuthorization: {
        rightsStatus: 'PERMITTED_PUBLIC',
        acquisitionCapability: 'PERMITTED_DIRECT_URL',
      },
    });

    const authClipper1 = createTrustedCacheAuthContext({
      source: verifiedSource,
      requesterUserId: 'clipper_1',
      allowSharedCacheReuse: true,
    });
    const authClipper2 = createTrustedCacheAuthContext({
      source: verifiedSource,
      requesterUserId: 'clipper_2',
      allowSharedCacheReuse: true,
    });

    const clipDescriptor = {
      artifactKind: 'BASE_CLIP' as const,
      sourceRevision: 'rev1',
      timeRangeSec: { start: 10, end: 70 },
      algorithmVersion: 'ffmpeg-v1',
      renderSettings: {
        format: 'reel' as const,
        width: 1080,
        height: 1920,
        fps: 30,
        subtitles: false,
        zooms: false,
        transitions: 'none' as const,
        music: false,
      },
      rightsScope: 'SHARED_PERMITTED' as const,
    };

    const stored = await cache.putCachedArtifact(authClipper1, clipDescriptor, Buffer.from('mp4-data'), 'video/mp4');
    const hit = await cache.checkCachedArtifact(authClipper2, clipDescriptor);
    expect(hit.hit).toBe(true);
    expect(hit.cacheKey).toBe(stored.cacheKey);
    expect(hit.sizeBytes).toBe(8);

    const signedUrl = await cache.createAuthorizedDownloadUrl(authClipper2, clipDescriptor);
    expect(signedUrl).toContain('cache/shared/base_clip/');

    // Changing sourceRevision, renderSettings, or adding customEditHash produces distinct identities
    const rev2 = resolveAuthorizedCacheIdentity(authClipper2, { ...clipDescriptor, sourceRevision: 'rev2' });
    expect(rev2.cacheKey).not.toBe(stored.cacheKey);

    const withSubtitles = resolveAuthorizedCacheIdentity(authClipper2, {
      ...clipDescriptor,
      renderSettings: { ...clipDescriptor.renderSettings, subtitles: true },
    });
    expect(withSubtitles.cacheKey).not.toBe(stored.cacheKey);

    // Custom edit hash is rejected from SHARED_PERMITTED and isolated in PRIVATE_USER
    expect(() =>
      resolveAuthorizedCacheIdentity(authClipper2, {
        ...clipDescriptor,
        renderSettings: { ...clipDescriptor.renderSettings, customEditHash: 'custom_1' },
      }),
    ).toThrow(/Personalized user edits/);
  });

  // 9. Coordination: state transition validation, READY immutability, stale worker fencing, and crash recovery
  it('9. validates state transitions, protects READY records, fences stale workers, and recovers after expiry', async () => {
    const store = new InMemoryCoordinationStore();
    const coordinator = new SharedIngestionCoordinator(store);
    const sourceId = 'twitch:broadcast:shroud:41928374650' as const;

    const first = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_1',
      workerId: 'worker_A',
      leaseMs: 10_000,
      maxRetries: 2,
      nowMs: 1_000,
    });
    expect(first.action).toBe('ACQUIRED_NEW');
    expect(first.fencingToken).toBe(1);

    // Cannot mark READY with empty artifactRef
    await expect(
      coordinator.markReady({
        canonicalSourceId: sourceId,
        workerId: 'worker_A',
        fencingToken: 1,
        artifactRef: '',
        nowMs: 2_000,
      }),
    ).rejects.toThrow(/non-empty artifactRef/);

    // Valid transition ACQUIRING -> INGESTING
    const ingesting = await coordinator.markIngesting({
      canonicalSourceId: sourceId,
      workerId: 'worker_A',
      fencingToken: 1,
      nowMs: 3_000,
    });
    expect(ingesting.state).toBe('INGESTING');

    // Lease expires -> worker_B recovers with fencingToken=2
    const recovered = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_2',
      workerId: 'worker_B',
      leaseMs: 10_000,
      maxRetries: 2,
      nowMs: 20_000,
    });
    expect(recovered.action).toBe('ACQUIRED_RECOVERY');
    expect(recovered.fencingToken).toBe(2);

    // Stale worker_A cannot transition or renew
    await expect(
      coordinator.markReady({
        canonicalSourceId: sourceId,
        workerId: 'worker_A',
        fencingToken: 1,
        artifactRef: 'cache/shared/stale',
        nowMs: 21_000,
      }),
    ).rejects.toThrow(/no longer owns/);

    // worker_B marks READY with valid artifactRef
    const ready = await coordinator.markReady({
      canonicalSourceId: sourceId,
      workerId: 'worker_B',
      fencingToken: 2,
      artifactRef: 'cache/shared/source_media/valid_ref',
      nowMs: 22_000,
    });
    expect(ready.state).toBe('READY');
    expect(ready.artifactRef).toBe('cache/shared/source_media/valid_ref');

    // READY is terminal: neither worker_B nor stale worker_A can mutate or release it
    await expect(
      coordinator.markFailed({
        canonicalSourceId: sourceId,
        workerId: 'worker_B',
        fencingToken: 2,
        error: 'late error',
        nowMs: 23_000,
      }),
    ).rejects.toThrow(/Cannot modify READY/);
    expect(
      await coordinator.releaseLease({
        canonicalSourceId: sourceId,
        workerId: 'worker_B',
        fencingToken: 2,
        nowMs: 23_000,
      }),
    ).toBe(false);

    // Subsequent clipper reuses READY artifact immediately
    const reused = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'clipper_3',
      workerId: 'worker_C',
      nowMs: 25_000,
    });
    expect(reused.action).toBe('REUSE_READY');
    expect(reused.record.artifactRef).toBe('cache/shared/source_media/valid_ref');
  });

  // 10. FAILED / EXPIRED records are never reused as successful READY
  it('10. never reuses FAILED or EXPIRED records as READY and enforces bounded retries', async () => {
    const coordinator = new SharedIngestionCoordinator(new InMemoryCoordinationStore());
    const sourceId = 'kick:broadcast:xqc:session_555' as const;

    const r1 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c1',
      workerId: 'w1',
      leaseMs: 5_000,
      maxRetries: 2,
      nowMs: 1_000,
    });
    await coordinator.markFailed({
      canonicalSourceId: sourceId,
      workerId: 'w1',
      fencingToken: r1.fencingToken,
      error: 'transient failure',
      nowMs: 2_000,
    });

    // Next requester triggers bounded recovery (attempt 2), NOT REUSE_READY
    const r2 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c2',
      workerId: 'w2',
      leaseMs: 5_000,
      maxRetries: 2,
      nowMs: 3_000,
    });
    expect(r2.action).toBe('ACQUIRED_RECOVERY');
    expect(r2.record.attempts).toBe(2);

    await coordinator.markFailed({
      canonicalSourceId: sourceId,
      workerId: 'w2',
      fencingToken: r2.fencingToken,
      error: 'permanent failure',
      nowMs: 4_000,
    });

    // Attempt 3 exceeds maxRetries=2 -> FAILED_MAX_RETRIES
    const r3 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c3',
      workerId: 'w3',
      leaseMs: 5_000,
      maxRetries: 2,
      nowMs: 5_000,
    });
    expect(r3.action).toBe('FAILED_MAX_RETRIES');
    expect(r3.record.state).toBe('FAILED');
  });

  // 11. 1,000 duplicate requesters -> 1 immutable broadcast identity -> 1 owner (constant-size record)
  it('11. coordinates 1,000 concurrent clippers into 1 work item with constant-size ownership record', async () => {
    const coordinator = new SharedIngestionCoordinator(new InMemoryCoordinationStore());
    const urlTemplates = [
      (i: number) => `https://www.youtube.com/live/GTA6Live999?si=track_${i}&utm_campaign=c${i}`,
      (i: number) => `https://m.youtube.com/live/GTA6Live999?feature=share_${i}`,
      (i: number) => `https://youtube.com/live/GTA6Live999?ref=clipper_${i}`,
    ];

    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => {
        const source = resolveMediaSourceFromUrl(urlTemplates[i % urlTemplates.length](i));
        return coordinator.requestIngestion({
          canonicalSourceId: source.canonicalId,
          requesterId: `clipper_${i}`,
          workerId: `worker_${i % 10}`,
          leaseMs: 60_000,
          nowMs: 10_000,
        });
      }),
    );

    expect(new Set(results.map((r) => r.record.canonicalSourceId))).toEqual(
      new Set(['youtube:broadcast:GTA6Live999']),
    );
    expect(results.filter((r) => r.action === 'ACQUIRED_NEW')).toHaveLength(1);
    expect(results.filter((r) => r.action === 'ATTACH_EXISTING')).toHaveLength(999);

    const finalRecord = await coordinator.getState('youtube:broadcast:GTA6Live999');
    expect(finalRecord?.attachedCount).toBe(1000);
    // Record remains compact O(1) without storing 1,000 requester strings inside the Redis lock
    expect(JSON.stringify(finalRecord).length).toBeLessThan(350);
  });

  // 12. Real local Redis Lua coordination: state transitions, READY protection, recovery & record TTL expiry
  it('12. enforces Redis Lua transitions, READY immutability, crash recovery, and clean TTL expiry behavior', async () => {
    const prefix = `autoedit:test:coord3b41:${Date.now()}:`;
    const redisStore = new RedisCoordinationStore(redis as any, {
      keyPrefix: prefix,
      recordTtlMs: 250, // Short TTL to verify expiry behavior deterministically
    });
    const coordinator = new SharedIngestionCoordinator(redisStore);
    const sourceId = 'kick:broadcast:xqc:session_redis_1' as const;

    const r1 = await coordinator.requestIngestion({
      canonicalSourceId: sourceId,
      requesterId: 'c1',
      workerId: 'w1',
      leaseMs: 5_000,
      nowMs: 1_000,
    });
    expect(r1.action).toBe('ACQUIRED_NEW');
    expect(r1.fencingToken).toBe(1);

    // Invalid READY with empty artifactRef rejected by Lua script
    await expect(
      coordinator.markReady({
        canonicalSourceId: sourceId,
        workerId: 'w1',
        fencingToken: 1,
        artifactRef: '',
        nowMs: 1_500,
      }),
    ).rejects.toThrow(/Invalid state transition/);

    // Valid READY transition
    const ready = await coordinator.markReady({
      canonicalSourceId: sourceId,
      workerId: 'w1',
      fencingToken: 1,
      artifactRef: 'cache/shared/source_media/redis_ok',
      nowMs: 2_000,
    });
    expect(ready.state).toBe('READY');

    // Mutation on READY rejected by Lua script
    await expect(
      coordinator.markFailed({
        canonicalSourceId: sourceId,
        workerId: 'w1',
        fencingToken: 1,
        error: 'should fail',
        nowMs: 2_500,
      }),
    ).rejects.toThrow(/Invalid state transition/);

    // Wait for Redis key TTL expiry (350ms > 250ms) and verify documented reset behavior
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

    await redis.del(`${prefix}${sourceId}`);
  });

  // 13. Zero unauthorized external downloads & CPU-first highlight detector on immutable broadcast
  it('13. performs zero unauthorized network downloads and runs CPU-first highlight detection on immutable broadcasts', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const yt = resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(() => assertAcquisitionPermitted(yt)).toThrow(/Acquisition unsupported/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const buffer = new RollingMediaBufferTracker({ preEventSec: 30, postEventSec: 10, segmentDurationSec: 6 });
    const win = buffer.computeCandidateWindow(100);
    expect(win.windowStartSec).toBe(70);
    expect(win.windowEndSec).toBe(110);

    const detector = new CpuFirstHeuristicDetector({
      canonicalSourceId: 'youtube:broadcast:GTA6Live999',
      scoreThreshold: 70,
    });
    detector.ingestSignal({ timestampSec: 120, signalKind: 'AUDIO_ENERGY', normalizedIntensity: 0.92, keywords: [] });
    detector.ingestSignal({ timestampSec: 121, signalKind: 'SPEECH_ACTIVITY', normalizedIntensity: 0.85, keywords: [] });

    const candidates = detector.evaluate(130);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].windowStartSec).toBe(75);
    expect(candidates[0].windowEndSec).toBe(135);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 14. Twitch & Kick clips canonicalization (restored explicit coverage from Step 3B.4)
  it('14. canonicalizes Twitch and Kick clip URLs distinctly from channels and full VODs', () => {
    const twitchClip1 = resolveMediaSourceFromUrl('https://clips.twitch.tv/AmazingClutchPlay123?tt_content=url');
    const twitchClip2 = resolveMediaSourceFromUrl('https://www.twitch.tv/shroud/clip/AmazingClutchPlay123');
    expect(twitchClip1.canonicalId).toBe('twitch:vod:clip_AmazingClutchPlay123');
    expect(twitchClip1.identityScope).toBe('IMMUTABLE_VOD');
    expect(twitchClip2.canonicalId).toBe(twitchClip1.canonicalId);

    const kickClip = resolveMediaSourceFromUrl('https://kick.com/xqc/clips/clip_01JABC999');
    expect(kickClip.canonicalId).toBe('kick:vod:clip_clip_01JABC999');
    expect(kickClip.identityScope).toBe('IMMUTABLE_VOD');
  });

  // 15. Malformed URLs, reserved paths, control characters & oversized inputs (restored explicit coverage)
  it('15. rejects malformed IDs, reserved platform routes, CRLF control characters, and oversized URLs', () => {
    const malformed = [
      '   ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch',
      'https://www.twitch.tv/directory',
      'https://www.twitch.tv/videos/notanumber',
      'https://kick.com/categories',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ\r\nX-Injected: true',
      `https://www.youtube.com/watch?v=dQw4w9WgXcQ&pad=${'a'.repeat(2100)}`,
    ];
    for (const url of malformed) {
      expect(() => resolveMediaSourceFromUrl(url)).toThrow(MediaSourceError);
    }
  });

  // 16. Extended SSRF, IPv6 metadata, octal/subdomain bypasses & resolved IPv6 checks (restored coverage)
  it('16. blocks data/ftp schemes, local subdomains, IPv6 IMDSv2, octal IPs, and private resolved IPv6', () => {
    const extendedSsrf = [
      'data:text/html,<h1>x</h1>',
      'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://api.localhost/video.mp4',
      'https://internal.service.local/stream.m3u8',
      'https://[fd00:ec2::254]/latest/meta-data/',
      'https://0177.0.0.1/loopback',
    ];
    for (const url of extendedSsrf) {
      expect(() => parseAndValidateSafeUrl(url)).toThrow(MediaSourceError);
    }

    expect(() => assertSafeResolvedIp('::1')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('fe80::1')).toThrow(MediaSourceError);
    expect(() => assertSafeResolvedIp('10.20.30.40')).toThrow(MediaSourceError);
  });

  // 17. DRM acquisition/cache denial, upload SHARED_PERMITTED rejection & explicit allowSharedCacheReuse gate
  it('17. blocks DRM acquisition/caching, upload shared caching, and PERMITTED_PUBLIC without explicit reuse policy', () => {
    const yt = resolveMediaSourceFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const drmSource = {
      ...yt,
      acquisitionCapability: 'APPROVED_API' as const,
      rightsStatus: 'RESTRICTED_DRM' as const,
    };
    expect(() => assertAcquisitionPermitted(drmSource)).toThrow(/DRM-protected/);

    const drmAuth = createTrustedCacheAuthContext({
      source: drmSource,
      requesterUserId: 'user_A',
      allowSharedCacheReuse: true,
    });
    expect(() =>
      resolveAuthorizedCacheIdentity(drmAuth, { artifactKind: 'BASE_CLIP', rightsScope: 'SHARED_PERMITTED' }),
    ).toThrow(/DRM-restricted/);

    // Direct upload cannot enter SHARED_PERMITTED cache scope
    expect(() =>
      buildSharedCacheIdentity({
        artifactKind: 'SOURCE_MEDIA',
        canonicalSourceId: 'upload:uploaded:asset_private_only',
        sourceRevision: 'v1',
        algorithmVersion: 'v1',
        rightsScope: 'SHARED_PERMITTED',
      }),
    ).toThrow(/Private user uploads cannot be stored in SHARED_PERMITTED/);

    // Even if a source carries PERMITTED_PUBLIC, shared cache reuse is DENIED unless allowSharedCacheReuse: true
    const publicSource = {
      ...yt,
      acquisitionCapability: 'APPROVED_API' as const,
      rightsStatus: 'PERMITTED_PUBLIC' as const,
    };
    const authWithoutSharedGrant = createTrustedCacheAuthContext({
      source: publicSource,
      requesterUserId: 'clipper_1',
      // allowSharedCacheReuse omitted -> defaults false!
    });
    expect(authWithoutSharedGrant.allowSharedCacheReuse).toBe(false);
    expect(() =>
      resolveAuthorizedCacheIdentity(authWithoutSharedGrant, {
        artifactKind: 'BASE_CLIP',
        rightsScope: 'SHARED_PERMITTED',
      }),
    ).toThrow(/Shared cache reuse denied/);
  });
});
