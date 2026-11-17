import crypto from 'node:crypto';
import {
  UniversalMediaSourceSchema,
  type AcquisitionCapability,
  type CanonicalSourceId,
  type MediaSourceProvider,
  type RightsAccessStatus,
  type UniversalMediaSource,
} from '@autoedit/contracts';
import { MediaSourceError } from './errors.js';
import { parseAndValidateSafeUrl, type UrlSafetyOptions } from './url-safety.js';

export interface AcquisitionPolicyContext {
  /**
   * Optional registry of permitted acquisition adapters per provider.
   * Defaults to empty (fail-closed: external third-party platforms report UNSUPPORTED acquisition).
   */
  permittedProviders?: Partial<
    Record<
      Exclude<MediaSourceProvider, 'upload'>,
      {
        capability: AcquisitionCapability;
        rightsStatus: RightsAccessStatus;
      }
    >
  >;
  /**
   * Explicit allowlist of controlled direct-media hosts (e.g. authorized test media hosts).
   * Never populated with arbitrary hosts by default.
   */
  approvedDirectMediaHosts?: ReadonlySet<string>;
  /** URL safety options (https-only by default). */
  urlSafety?: UrlSafetyOptions;
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
const TWITCH_CHANNEL_RE = /^[a-z0-9_]{2,25}$/;
const TWITCH_VOD_ID_RE = /^\d{5,20}$/;
const TWITCH_CLIP_SLUG_RE = /^[a-zA-Z0-9_-]{6,120}$/;
const KICK_CHANNEL_RE = /^[a-z0-9_-]{2,32}$/;
const KICK_ASSET_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const SAFE_ASSET_ID_RE = /^[a-zA-Z0-9._:-]{2,128}$/;

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCapability(
  provider: Exclude<MediaSourceProvider, 'upload'>,
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
  const { capability, rightsStatus } = buildCapability('youtube', policy);

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
      message: 'YouTube URL does not contain a valid 11-character video or livestream ID.',
    });
  }

  const canonicalId = `youtube:${sourceType}:${videoId}` as CanonicalSourceId;
  const normalizedUrl =
    sourceType === 'live'
      ? `https://www.youtube.com/live/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;

  return UniversalMediaSourceSchema.parse({
    canonicalId,
    provider: 'youtube',
    sourceType,
    externalId: videoId,
    normalizedUrl,
    availability: sourceType === 'live' ? 'UNKNOWN' : 'UNKNOWN',
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
  const { capability, rightsStatus } = buildCapability('twitch', policy);

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
      provider: 'twitch',
      sourceType: 'vod',
      externalId,
      normalizedUrl: `https://clips.twitch.tv/${slug}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false },
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
      provider: 'twitch',
      sourceType: 'vod',
      externalId: vodId,
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
      provider: 'twitch',
      sourceType: 'vod',
      externalId,
      normalizedUrl: `https://clips.twitch.tv/${slug}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, channelName: channel },
    });
  }

  // twitch.tv/<channel> (live broadcast channel)
  if (segments.length === 1) {
    const channel = segments[0].toLowerCase();
    if (TWITCH_RESERVED_PATHS.has(channel) || !TWITCH_CHANNEL_RE.test(channel)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Twitch URL does not point to a valid channel or VOD.',
      });
    }
    return UniversalMediaSourceSchema.parse({
      canonicalId: `twitch:live:${channel}`,
      provider: 'twitch',
      sourceType: 'live',
      externalId: channel,
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
  const { capability, rightsStatus } = buildCapability('kick', policy);

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
      provider: 'kick',
      sourceType: 'vod',
      externalId: vodId,
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
      provider: 'kick',
      sourceType: 'vod',
      externalId,
      normalizedUrl: `https://kick.com/${channel}/clips/${clipId}`,
      availability: 'UNKNOWN',
      acquisitionCapability: capability,
      rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: { hasAudio: true, isLive: false, channelName: channel },
    });
  }

  // kick.com/<channel> (live channel)
  if (segments.length === 1) {
    const channel = segments[0].toLowerCase();
    if (KICK_RESERVED_PATHS.has(channel) || !KICK_CHANNEL_RE.test(channel)) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Kick URL does not point to a valid channel or VOD.',
      });
    }
    return UniversalMediaSourceSchema.parse({
      canonicalId: `kick:live:${channel}`,
      provider: 'kick',
      sourceType: 'live',
      externalId: channel,
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
  const normalizedPathname = url.pathname.replace(/\/+$/, '');
  const cleanUrl = `${url.protocol}//${host}${normalizedPathname}`;
  const isMediaExt = /\.(mp4|mov|webm|mkv|m3u8)$/i.test(normalizedPathname);

  if (!isMediaExt) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'Direct media URL must reference a supported media file path (.mp4, .mov, .webm, .mkv, .m3u8).',
    });
  }

  const hash = crypto.createHash('sha256').update(cleanUrl).digest('hex').slice(0, 24);
  const configured = policy?.permittedProviders?.direct_media;

  return UniversalMediaSourceSchema.parse({
    canonicalId: `direct_media:vod:${hash}`,
    provider: 'direct_media',
    sourceType: 'vod',
    externalId: hash,
    normalizedUrl: cleanUrl,
    availability: 'AVAILABLE',
    acquisitionCapability: configured?.capability ?? 'PERMITTED_DIRECT_URL',
    rightsStatus: configured?.rightsStatus ?? 'PERMITTED_PUBLIC',
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
  const parsed = parseAndValidateSafeUrl(rawUrl, policy?.urlSafety);
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
 * Enforces acquisition & copying rights before any media download or recording can start.
 * Never bypasses DRM, paywalls, login restrictions, or unsupported acquisition capabilities.
 */
export function assertAcquisitionPermitted(source: UniversalMediaSource): void {
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
