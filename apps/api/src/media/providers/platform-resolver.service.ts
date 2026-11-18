import type { UniversalMediaSource } from '@autoedit/contracts';
import { env } from '../../config/env.js';
import { resolveMediaSourceFromUrl, type AcquisitionPolicyContext } from '../canonical-source.js';
import { DirectMediaSourceResolver } from './direct-media.resolver.js';
import { KickSourceResolver } from './kick.resolver.js';
import { TwitchSourceResolver } from './twitch.resolver.js';
import {
  parseCsvHostSet,
  type PlatformProviderConfig,
  type PlatformResolutionResult,
} from './types.js';
import { YouTubeSourceResolver } from './youtube.resolver.js';

/**
 * Builds default platform provider config from server-only environment variables.
 * Never exposes credentials to the browser; all external acquisition hosts fail closed by default.
 */
export function buildDefaultPlatformProviderConfig(): PlatformProviderConfig {
  return {
    youtubeApiKey: env.YOUTUBE_API_KEY || undefined,
    enableYoutubeOembedFallback: process.env.NODE_ENV !== 'test',
    twitchClientId: env.TWITCH_CLIENT_ID || undefined,
    twitchClientSecret: env.TWITCH_CLIENT_SECRET || undefined,
    kickClientId: env.KICK_CLIENT_ID || undefined,
    kickClientSecret: env.KICK_CLIENT_SECRET || undefined,
    directMediaAllowedHosts: parseCsvHostSet(env.DIRECT_MEDIA_ALLOWED_HOSTS),
    directMediaPermittedPublicHosts: parseCsvHostSet(env.DIRECT_MEDIA_PERMITTED_PUBLIC_HOSTS),
  };
}

/**
 * Unified Official Platform Metadata & Capability Resolver (Step 3C.2).
 *
 * Parses and canonicalizes public URLs (YouTube, Twitch, Kick, and explicitly allowlisted
 * direct media hosts), resolves real metadata via official provider APIs with strict SSRF,
 * DNS-rebinding, redirect, and rate-limit controls, and returns truthful acquisition capability
 * status without ever faking downloads.
 */
export class PlatformSourceResolverService {
  readonly config: PlatformProviderConfig;
  readonly youtube: YouTubeSourceResolver;
  readonly twitch: TwitchSourceResolver;
  readonly kick: KickSourceResolver;
  readonly directMedia: DirectMediaSourceResolver;

  constructor(config?: PlatformProviderConfig) {
    this.config = config ?? buildDefaultPlatformProviderConfig();
    this.youtube = new YouTubeSourceResolver(this.config);
    this.twitch = new TwitchSourceResolver(this.config);
    this.kick = new KickSourceResolver(this.config);
    this.directMedia = new DirectMediaSourceResolver(this.config);
  }

  buildCanonicalPolicy(): AcquisitionPolicyContext {
    return {
      approvedDirectMediaHosts: this.config.directMediaAllowedHosts,
      allowLocalhostDirectMediaForTest: this.config.http?.allowLocalhostForTest,
      urlSafety: {
        allowHttp: Boolean(this.config.http?.allowLocalhostForTest && process.env.NODE_ENV !== 'production'),
      },
    };
  }

  parseCanonicalUrl(rawUrl: string): UniversalMediaSource {
    return resolveMediaSourceFromUrl(rawUrl, this.buildCanonicalPolicy());
  }

  async resolveUrl(
    rawUrl: string,
    opts: {
      hasServerVerifiedGrant?: (canonicalId: string) => Promise<boolean>;
    } = {},
  ): Promise<PlatformResolutionResult> {
    const parsed = this.parseCanonicalUrl(rawUrl);

    switch (parsed.provider) {
      case 'youtube':
        return this.youtube.resolve(parsed);
      case 'twitch':
        return this.twitch.resolve(parsed);
      case 'kick':
        return this.kick.resolve(parsed);
      case 'direct_media': {
        const hasGrant = opts.hasServerVerifiedGrant
          ? await opts.hasServerVerifiedGrant(parsed.canonicalId).catch(() => false)
          : false;
        return this.directMedia.resolve(parsed, { hasServerVerifiedGrant: hasGrant });
      }
      default:
        return {
          source: parsed,
          availability: 'UNKNOWN',
          capabilityStatus: 'UNSUPPORTED_ACQUISITION',
          canSubmitJob: false,
          reason: `Unsupported media provider "${parsed.provider}".`,
          supportedActions: ['upload_video'],
          metadata: {},
        };
    }
  }
}
