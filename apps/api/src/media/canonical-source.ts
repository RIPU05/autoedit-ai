import crypto from 'node:crypto';
import {
  UniversalMediaSourceSchema,
  type AcquisitionCapability,
  type BroadcastIdentity,
  type CanonicalSourceId,
  type ChannelIdentity,
  type MediaSourceProvider,
  type RightsAccessStatus,
  type UniversalMediaSource,
} from '@autoedit/contracts';
import { MediaSourceError } from './errors.js';
import { parseAndValidateSafeUrl, type UrlSafetyOptions } from './url-safety.js';

export interface DirectMediaAuthorization {
  /** Explicitly verified copying/import rights granted by trusted server policy. */
  rightsStatus: RightsAccessStatus;
  /** Explicitly permitted acquisition capability. */
  acquisitionCapability: AcquisitionCapability;
}

export interface AcquisitionPolicyContext {
  /**
   * Optional registry of permitted acquisition adapters per provider.
   * Defaults to empty (fail-closed: external platforms report UNSUPPORTED acquisition & UNKNOWN rights).
   */
  permittedProviders?: Partial<
    Record<
      Exclude<MediaSourceProvider, 'upload' | 'direct_media'>,
      {
        capability: AcquisitionCapability;
        rightsStatus: RightsAccessStatus;
      }
    >
  >;
  /**
   * Explicit allowlist of approved network hosts for direct-media URLs.
   * Host allowlisting ONLY establishes an approved network destination (SSRF safety);
   * it NEVER implies copying or public redistribution rights (defaults to UNKNOWN / UNSUPPORTED).
   */
  approvedDirectMediaHosts?: ReadonlySet<string>;
  /**
   * Explicit server-verified authorization for a direct-media URL.
   * Must be supplied separately from host allowlisting.
   */
  directMediaAuthorization?: DirectMediaAuthorization;
  /** URL safety options (https-only by default). */
  urlSafety?: UrlSafetyOptions;
  /** Strictly non-production test escape hatch for local HTTP direct-media integration servers. */
  allowLocalhostDirectMediaForTest?: boolean;
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const TWITCH_HOSTS = new Set([
  'twitch.tv',
  'www.twitch.tv',
  'm.twitch.tv',
  'clips.twitch.tv',
]);

const KICK_HOSTS = new Set(['kick.com', 'www.kick.com', 'm.kick.com']);

const TWITCH_RESERVED_PATHS = new Set([
  'directory',
  'downloads',
  'jobs',
  'p',
  'settings',
  'subscriptions',
  'inventory',
  'drops',
  'wallet',
  'turbo',
  'login',
  'signup',
  'videos',
  'search',
  'team',
  'moderator',
  'popout',
  'u',
]);

const KICK_RESERVED_PATHS = new Set([
  'categories',
  'browse',
  'following',
  'settings',
  'terms',
  'privacy',
  'about',
  'login',
  'register',
  'video',
  'videos',
  'clips',
  'search',
  'dashboard',
  'transactions',
]);

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_HANDLE_RE = /^[a-zA-Z0-9._-]{2,60}$/;
const YOUTUBE_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{20,30}$/;
const YOUTUBE_CLIP_ID_RE = /^[a-zA-Z0-9_-]{10,80}$/;
const TWITCH_CHANNEL_RE = /^[a-z0-9_]{2,25}$/;
const TWITCH_VOD_ID_RE = /^\d{5,20}$/;
const TWITCH_CLIP_SLUG_RE = /^[a-zA-Z0-9_-]{6,120}$/;
const KICK_CHANNEL_RE = /^[a-z0-9_-]{2,32}$/;
const KICK_ASSET_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const SAFE_ASSET_ID_RE = /^[a-zA-Z0-9._:-]{2,128}$/;
const VERIFIED_BROADCAST_ID_RE = /^[a-zA-Z0-9._-]{3,64}$/;

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildPlatformCapability(
  provider: Exclude<MediaSourceProvider, 'upload' | 'direct_media'>,
  policy?: AcquisitionPolicyContext,
): { capability: AcquisitionCapability; rightsStatus: RightsAccessStatus } {
  const configured = policy?.permittedProviders?.[provider];
  if (configured) {
    return configured;
  }
  return {
    capability: 'UNSUPPORTED',
    rightsStatus: 'UNKNOWN',
  };
}

function resolveYouTube(url: URL, policy?: AcquisitionPolicyContext): UniversalMediaSource {
  const host = url.hostname.toLowerCase();
  const segments = pathSegments(url.pathname);
  const { capability, rightsStatus } = buildPlatformCapability('youtube', policy);

  // youtube.com/@<handle> or youtube.com/@<handle>/live -> Channel discovery identity
  if (host !== 'youtu.be' && segments[0]?.startsWith('@')) {
    const handle = segments[0].slice(1).toLowerCase();
    if (!YOUTUBE_HANDLE_RE.test(handle)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'YouTube handle URL does not contain a valid channel handle.',
      });
    }
    const wantsLive = segments[1]?.toLowerCase() === 'live';
    const channelId = `youtube:channel:${handle}` as ChannelIdentity;
    return UniversalMediaSourceSchema.parse({
      canonicalId: channelId,
      identityScope: 'CHANNEL_DISCOVERY',
      provider: 'youtube',
      sourceType: 'live',
      externalId: handle,
      channelId,
      normalizedUrl: wantsLive
        ? `https://www.youtube.com/@${handle}/live`
        : `https://www.youtube.com/@${handle}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: {
        hasAudio: true,
        isLive: true,
        channelName: `@${handle}`,
      },
    });
  }

  // youtube.com/channel/UC... or youtube.com/channel/UC.../live -> Channel discovery identity
  if (host !== 'youtu.be' && segments[0]?.toLowerCase() === 'channel') {
    const rawChanId = segments[1];
    if (!rawChanId || !YOUTUBE_CHANNEL_ID_RE.test(rawChanId)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'YouTube channel URL does not contain a valid UC... channel ID.',
      });
    }
    const wantsLive = segments[2]?.toLowerCase() === 'live';
    const channelId = `youtube:channel:${rawChanId}` as ChannelIdentity;
    return UniversalMediaSourceSchema.parse({
      canonicalId: channelId,
      identityScope: 'CHANNEL_DISCOVERY',
      provider: 'youtube',
      sourceType: 'live',
      externalId: rawChanId,
      channelId,
      normalizedUrl: wantsLive
        ? `https://www.youtube.com/channel/${rawChanId}/live`
        : `https://www.youtube.com/channel/${rawChanId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: {
        hasAudio: true,
        isLive: true,
      },
    });
  }

  // youtube.com/clip/<clipId>
  if (host !== 'youtu.be' && segments[0]?.toLowerCase() === 'clip') {
    const clipId = segments[1];
    if (!clipId || !YOUTUBE_CLIP_ID_RE.test(clipId)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'YouTube clip URL does not contain a valid clip ID.',
      });
    }
    const externalId = `clip_${clipId}`;
    return UniversalMediaSourceSchema.parse({
      canonicalId: `youtube:vod:${externalId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'youtube',
      sourceType: 'vod',
      externalId,
      normalizedUrl: `https://www.youtube.com/clip/${clipId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: {
        hasAudio: true,
        isLive: false,
        isClip: true,
      },
    });
  }

  let videoId: string | undefined;
  let sourceType: 'live' | 'vod' = 'vod';

  if (host === 'youtu.be') {
    videoId = segments[0];
    sourceType = 'vod';
  } else if (segments[0] === 'watch') {
    videoId = url.searchParams.get('v') ?? undefined;
    sourceType = 'vod';
  } else if (segments[0] === 'live') {
    videoId = segments[1];
    sourceType = 'live';
  } else if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'v') {
    videoId = segments[1];
    sourceType = 'vod';
  }

  if (!videoId || !YOUTUBE_ID_RE.test(videoId)) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'YouTube URL does not contain a valid 11-character video or broadcast ID.',
    });
  }

  // YouTube /live/<id> uniquely identifies a broadcast session; /watch?v=<id> identifies a VOD.
  // Keep livestream and VOD identities distinct so live-to-VOD transitions are handled explicitly.
  const canonicalId = (
    sourceType === 'live' ? `youtube:broadcast:${videoId}` : `youtube:vod:${videoId}`
  ) as CanonicalSourceId;
  const normalizedUrl =
    sourceType === 'live'
      ? `https://www.youtube.com/live/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;

  return UniversalMediaSourceSchema.parse({
    canonicalId,
    identityScope: sourceType === 'live' ? 'IMMUTABLE_BROADCAST' : 'IMMUTABLE_VOD',
    provider: 'youtube',
    sourceType,
    externalId: videoId,
    broadcastId: sourceType === 'live' ? videoId : undefined,
    normalizedUrl,
    availability: 'UNKNOWN',
    acquisitionCapability: capability,
    rightsStatus,
    ingestionStatus: 'PENDING',
    metadata: {
      hasAudio: true,
      isLive: sourceType === 'live',
    },
  });
}

function resolveTwitch(url: URL, policy?: AcquisitionPolicyContext): UniversalMediaSource {
  const host = url.hostname.toLowerCase();
  const segments = pathSegments(url.pathname);
  const { capability, rightsStatus } = buildPlatformCapability('twitch', policy);

  // clips.twitch.tv/<slug>
  if (host === 'clips.twitch.tv') {
    const slug = segments[0];
    if (!slug || !TWITCH_CLIP_SLUG_RE.test(slug)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Twitch clip URL is missing a valid clip slug.',
      });
    }
    const externalId = `clip_${slug}`;
    return UniversalMediaSourceSchema.parse({
      canonicalId: `twitch:vod:${externalId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'twitch',
      sourceType: 'vod',
      externalId,
      normalizedUrl: `https://clips.twitch.tv/${slug}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, isClip: true },
    });
  }

  // twitch.tv/videos/<id>
  if (segments[0]?.toLowerCase() === 'videos') {
    const vodId = segments[1];
    if (!vodId || !TWITCH_VOD_ID_RE.test(vodId)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Twitch VOD URL does not contain a valid numeric video ID.',
      });
    }
    return UniversalMediaSourceSchema.parse({
      canonicalId: `twitch:vod:${vodId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'twitch',
      sourceType: 'vod',
      externalId: vodId,
      normalizedUrl: `https://www.twitch.tv/videos/${vodId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false },
    });
  }

  // twitch.tv/<channel>/video/<id>
  if (segments.length >= 3 && segments[1]?.toLowerCase() === 'video') {
    const channel = segments[0].toLowerCase();
    const vodId = segments[2];
    if (!TWITCH_CHANNEL_RE.test(channel) || !TWITCH_VOD_ID_RE.test(vodId)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Twitch channel video URL has an invalid channel or VOD ID.',
      });
    }
    return UniversalMediaSourceSchema.parse({
      canonicalId: `twitch:vod:${vodId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'twitch',
      sourceType: 'vod',
      externalId: vodId,
      channelId: `twitch:channel:${channel}` as ChannelIdentity,
      normalizedUrl: `https://www.twitch.tv/videos/${vodId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, channelName: channel },
    });
  }

  // twitch.tv/<channel>/clip/<slug>
  if (segments.length >= 3 && segments[1]?.toLowerCase() === 'clip') {
    const channel = segments[0].toLowerCase();
    const slug = segments[2];
    if (!TWITCH_CHANNEL_RE.test(channel) || !TWITCH_CLIP_SLUG_RE.test(slug)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Twitch clip URL has an invalid channel or clip slug.',
      });
    }
    const externalId = `clip_${slug}`;
    return UniversalMediaSourceSchema.parse({
      canonicalId: `twitch:vod:${externalId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'twitch',
      sourceType: 'vod',
      externalId,
      channelId: `twitch:channel:${channel}` as ChannelIdentity,
      normalizedUrl: `https://clips.twitch.tv/${slug}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, isClip: true, channelName: channel },
    });
  }

  // twitch.tv/<channel> — Channel discovery identity ONLY (not an immutable broadcast session!)
  if (segments.length === 1) {
    const channel = segments[0].toLowerCase();
    if (TWITCH_RESERVED_PATHS.has(channel) || !TWITCH_CHANNEL_RE.test(channel)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Twitch URL does not point to a valid channel or VOD.',
      });
    }
    const channelId = `twitch:channel:${channel}` as ChannelIdentity;
    return UniversalMediaSourceSchema.parse({
      canonicalId: channelId,
      identityScope: 'CHANNEL_DISCOVERY',
      provider: 'twitch',
      sourceType: 'live',
      externalId: channel,
      channelId,
      normalizedUrl: `https://www.twitch.tv/${channel}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: true, channelName: channel },
    });
  }

  throw new MediaSourceError({
    code: 'MALFORMED_URL',
    message: 'Unrecognized Twitch URL format.',
  });
}

function resolveKick(url: URL, policy?: AcquisitionPolicyContext): UniversalMediaSource {
  const segments = pathSegments(url.pathname);
  const { capability, rightsStatus } = buildPlatformCapability('kick', policy);

  // kick.com/video/<id>
  if (segments[0]?.toLowerCase() === 'video') {
    const vodId = segments[1];
    if (!vodId || !KICK_ASSET_ID_RE.test(vodId)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Kick video URL is missing a valid VOD ID.',
      });
    }
    return UniversalMediaSourceSchema.parse({
      canonicalId: `kick:vod:${vodId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'kick',
      sourceType: 'vod',
      externalId: vodId,
      normalizedUrl: `https://kick.com/video/${vodId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false },
    });
  }

  // kick.com/<channel>/videos/<id>
  if (segments.length >= 3 && segments[1]?.toLowerCase() === 'videos') {
    const channel = segments[0].toLowerCase();
    const vodId = segments[2];
    if (!KICK_CHANNEL_RE.test(channel) || !KICK_ASSET_ID_RE.test(vodId)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Kick channel VOD URL has an invalid channel or video ID.',
      });
    }
    return UniversalMediaSourceSchema.parse({
      canonicalId: `kick:vod:${vodId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'kick',
      sourceType: 'vod',
      externalId: vodId,
      channelId: `kick:channel:${channel}` as ChannelIdentity,
      normalizedUrl: `https://kick.com/video/${vodId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, channelName: channel },
    });
  }

  // kick.com/<channel>/clips/<clipId>
  if (segments.length >= 3 && segments[1]?.toLowerCase() === 'clips') {
    const channel = segments[0].toLowerCase();
    const clipId = segments[2];
    if (!KICK_CHANNEL_RE.test(channel) || !KICK_ASSET_ID_RE.test(clipId)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Kick clip URL has an invalid channel or clip ID.',
      });
    }
    const externalId = `clip_${clipId}`;
    return UniversalMediaSourceSchema.parse({
      canonicalId: `kick:vod:${externalId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'kick',
      sourceType: 'vod',
      externalId,
      channelId: `kick:channel:${channel}` as ChannelIdentity,
      normalizedUrl: `https://kick.com/${channel}/clips/${clipId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, isClip: true, channelName: channel },
    });
  }

  // kick.com/<channel>?clip=<clipId> (Kick share clip query link)
  if (segments.length === 1 && url.searchParams.has('clip')) {
    const channel = segments[0].toLowerCase();
    const clipId = url.searchParams.get('clip')?.trim();
    if (
      KICK_RESERVED_PATHS.has(channel) ||
      !KICK_CHANNEL_RE.test(channel) ||
      !clipId ||
      !KICK_ASSET_ID_RE.test(clipId)
    ) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Kick clip URL has an invalid channel or clip ID.',
      });
    }
    const externalId = `clip_${clipId}`;
    return UniversalMediaSourceSchema.parse({
      canonicalId: `kick:vod:${externalId}`,
      identityScope: 'IMMUTABLE_VOD',
      provider: 'kick',
      sourceType: 'vod',
      externalId,
      channelId: `kick:channel:${channel}` as ChannelIdentity,
      normalizedUrl: `https://kick.com/${channel}/clips/${clipId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, isClip: true, channelName: channel },
    });
  }

  // kick.com/<channel> — Channel discovery identity ONLY (not an immutable broadcast session!)
  if (segments.length === 1) {
    const channel = segments[0].toLowerCase();
    if (KICK_RESERVED_PATHS.has(channel) || !KICK_CHANNEL_RE.test(channel)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Kick URL does not point to a valid channel or VOD.',
      });
    }
    const channelId = `kick:channel:${channel}` as ChannelIdentity;
    return UniversalMediaSourceSchema.parse({
      canonicalId: channelId,
      identityScope: 'CHANNEL_DISCOVERY',
      provider: 'kick',
      sourceType: 'live',
      externalId: channel,
      channelId,
      normalizedUrl: `https://kick.com/${channel}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: true, channelName: channel },
    });
  }

  throw new MediaSourceError({
    code: 'MALFORMED_URL',
    message: 'Unrecognized Kick URL format.',
  });
}

function resolveApprovedDirectMedia(url: URL, policy?: AcquisitionPolicyContext): UniversalMediaSource {
  const host = url.hostname.toLowerCase();
  const portSegment = url.port ? `:${url.port}` : '';
  const normalizedPathname = url.pathname.replace(/\/+$/, '');
  const cleanUrl = `${url.protocol}//${host}${portSegment}${normalizedPathname}`;
  const isMediaExt = /\.(mp4|mov|webm|mkv|m3u8)$/i.test(normalizedPathname);

  if (!isMediaExt) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'Direct media URL must reference a supported media file path (.mp4, .mov, .webm, .mkv, .m3u8).',
    });
  }

  const hash = crypto.createHash('sha256').update(cleanUrl).digest('hex').slice(0, 24);

  // CRITICAL: Host allowlisting ONLY confirms a safe network destination (SSRF boundary).
  // Rights default strictly to UNKNOWN and capability to UNSUPPORTED unless explicit
  // server-verified directMediaAuthorization is provided.
  const auth = policy?.directMediaAuthorization;

  return UniversalMediaSourceSchema.parse({
    canonicalId: `direct_media:vod:${hash}`,
    identityScope: 'IMMUTABLE_VOD',
    provider: 'direct_media',
    sourceType: 'vod',
    externalId: hash,
    normalizedUrl: cleanUrl,
    availability: 'UNKNOWN',
    acquisitionCapability: auth?.acquisitionCapability ?? 'UNSUPPORTED',
    rightsStatus: auth?.rightsStatus ?? 'UNKNOWN',
    ingestionStatus: 'PENDING',
    metadata: { hasAudio: true, isLive: false },
  });
}

/**
 * Resolves a pasted external URL into a canonical UniversalMediaSource.
 * Fails closed on malformed URLs, unsafe schemes, SSRF/private hosts, and unknown providers.
 */
export function resolveMediaSourceFromUrl(
  rawUrl: string,
  policy?: AcquisitionPolicyContext,
): UniversalMediaSource {
  const allowLocalDirect =
    Boolean(policy?.allowLocalhostDirectMediaForTest) && process.env.NODE_ENV !== 'production';

  let parsed: URL;
  if (allowLocalDirect) {
    let candidate: URL;
    try {
      candidate = new URL(rawUrl.trim());
    } catch {
      throw new MediaSourceError({ code: 'MALFORMED_URL', message: 'Malformed media source URL.' });
    }
    const candHost = candidate.hostname.toLowerCase().replace(/\.$/, '');
    if (
      policy?.approvedDirectMediaHosts?.has(candHost) &&
      (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
      !candidate.username &&
      !candidate.password
    ) {
      return resolveApprovedDirectMedia(candidate, policy);
    }
    parsed = parseAndValidateSafeUrl(rawUrl, policy?.urlSafety);
  } else {
    parsed = parseAndValidateSafeUrl(rawUrl, policy?.urlSafety);
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');

  if (YOUTUBE_HOSTS.has(host)) {
    return resolveYouTube(parsed, policy);
  }
  if (TWITCH_HOSTS.has(host)) {
    return resolveTwitch(parsed, policy);
  }
  if (KICK_HOSTS.has(host)) {
    return resolveKick(parsed, policy);
  }
  if (policy?.approvedDirectMediaHosts?.has(host)) {
    return resolveApprovedDirectMedia(parsed, policy);
  }

  throw new MediaSourceError({
    code: 'UNSUPPORTED_PROVIDER',
    message: `Unsupported media source host "${host}". Supported platforms: YouTube, Twitch, Kick, or direct upload.`,
  });
}

/**
 * Binds a ChannelDiscovery source (e.g. `twitch:channel:shroud`) to a verified platform
 * broadcast/session ID (e.g. `41928374650`), producing an immutable BroadcastIdentity
 * (`twitch:broadcast:shroud:41928374650`) safe for shared ingestion and cache reuse.
 *
 * Never fabricates timestamps or random IDs: callers MUST supply a real verified session ID.
 */
export function bindVerifiedBroadcastSession(
  channelSource: UniversalMediaSource,
  input: { broadcastId: string },
): UniversalMediaSource {
  if (channelSource.identityScope !== 'CHANNEL_DISCOVERY') {
    throw new MediaSourceError({
      code: 'COORDINATION_CONFLICT',
      message: `Cannot bind broadcast session: source ${channelSource.canonicalId} is already scoped as ${channelSource.identityScope}.`,
    });
  }

  const broadcastId = input.broadcastId?.trim();
  if (!broadcastId || !VERIFIED_BROADCAST_ID_RE.test(broadcastId)) {
    throw new MediaSourceError({
      code: 'BROADCAST_UNRESOLVED',
      message: 'A valid, verified platform broadcast/session ID is required to bind a live broadcast.',
      retryable: true,
    });
  }

  const provider = channelSource.provider;
  if (provider !== 'twitch' && provider !== 'kick' && provider !== 'youtube') {
    throw new MediaSourceError({
      code: 'UNSUPPORTED_PROVIDER',
      message: `Provider "${provider}" does not support channel-to-broadcast binding.`,
    });
  }

  const broadcastCanonicalId =
    `${provider}:broadcast:${channelSource.externalId}:${broadcastId}` as BroadcastIdentity;

  return UniversalMediaSourceSchema.parse({
    ...channelSource,
    canonicalId: broadcastCanonicalId,
    identityScope: 'IMMUTABLE_BROADCAST',
    channelId: channelSource.channelId ?? (`${provider}:channel:${channelSource.externalId}` as ChannelIdentity),
    broadcastId,
    availability: 'LIVE_NOW',
  });
}

/**
 * Resolves a direct user upload into the same UniversalMediaSource contract.
 * Distinct uploads always maintain distinct canonical identities and USER_OWNED rights.
 */
export function resolveDirectUploadSource(input: {
  assetId: string;
  title?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
}): UniversalMediaSource {
  const assetId = input.assetId?.trim();
  if (!assetId || !SAFE_ASSET_ID_RE.test(assetId)) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'Direct upload source requires a valid assetId.',
    });
  }

  return UniversalMediaSourceSchema.parse({
    canonicalId: `upload:uploaded:${assetId}`,
    identityScope: 'IMMUTABLE_UPLOAD',
    provider: 'upload',
    sourceType: 'uploaded',
    externalId: assetId,
    availability: 'AVAILABLE',
    acquisitionCapability: 'DIRECT_UPLOAD',
    rightsStatus: 'USER_OWNED',
    ingestionStatus: 'READY',
    metadata: {
      title: input.title,
      durationSec: input.durationSec,
      width: input.width,
      height: input.height,
      fps: input.fps,
      hasAudio: input.hasAudio ?? true,
      isLive: false,
    },
  });
}

/**
 * Enforces broadcast identity resolution, acquisition capability, and copying rights
 * before any media download or recording can start.
 * Never bypasses DRM, paywalls, login restrictions, or unsupported acquisition capabilities.
 */
export function assertAcquisitionPermitted(source: UniversalMediaSource): void {
  if (source.identityScope === 'CHANNEL_DISCOVERY') {
    throw new MediaSourceError({
      code: 'BROADCAST_UNRESOLVED',
      message: `Acquisition pending: ${source.canonicalId} identifies a mutable channel, not a verified broadcast session.`,
      retryable: true,
    });
  }
  if (source.rightsStatus === 'RESTRICTED_DRM') {
    throw new MediaSourceError({
      code: 'DRM_RESTRICTED',
      message: `Acquisition blocked: source ${source.canonicalId} is DRM-protected.`,
    });
  }
  if (source.rightsStatus === 'DENIED' || source.rightsStatus === 'REQUIRES_AUTHORIZATION') {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: `Acquisition blocked: source ${source.canonicalId} requires explicit rights authorization.`,
    });
  }
  if (source.acquisitionCapability === 'UNSUPPORTED') {
    throw new MediaSourceError({
      code: 'UNSUPPORTED_ACQUISITION',
      message: `Acquisition unsupported for ${source.provider} (${source.canonicalId}): no approved acquisition method is enabled.`,
    });
  }
  if (source.rightsStatus === 'UNKNOWN') {
    throw new MediaSourceError({
      code: 'RIGHTS_UNVERIFIED',
      message: `Acquisition blocked: copying/recording rights for ${source.canonicalId} are unverified.`,
    });
  }
}
