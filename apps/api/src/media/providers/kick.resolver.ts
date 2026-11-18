import type { UniversalMediaSource } from '@autoedit/contracts';
import { bindVerifiedBroadcastSession } from '../canonical-source.js';
import { ProviderRateLimitError, safeFetch } from '../safe-http.js';
import {
  sanitizeThumbnailUrl,
  type PlatformProviderConfig,
  type PlatformResolutionResult,
} from './types.js';

const KICK_AUTH_HOSTS = new Set(['id.kick.com']);
const KICK_API_HOSTS = new Set(['api.kick.com']);

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Official Kick Public API v1 Metadata Resolver (Step 3C.2).
 *
 * Uses official OAuth 2.1 App Access Token (`POST https://id.kick.com/oauth/token`,
 * `grant_type=client_credentials`) — zero mandatory streamer login for public URL lookup:
 * - Channel/live URLs: `GET https://api.kick.com/public/v1/channels?slug=` &
 *   `GET https://api.kick.com/public/v1/livestreams?broadcaster_user_id=`
 *
 * Truthful capability separation:
 * - Kick Public API v1 supports channel & active livestream metadata resolution.
 * - Kick Public API v1 does NOT expose official VOD download, clip download, or raw stream
 *   recording endpoints. AutoAI Edit never scrapes internal/undocumented endpoints.
 */
export class KickSourceResolver {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly config: PlatformProviderConfig = {}) {}

  private async getAppAccessToken(): Promise<string | null> {
    const clientId = this.config.kickClientId?.trim();
    const clientSecret = this.config.kickClientSecret?.trim();
    if (!clientId || !clientSecret) return null;

    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now() + 60_000) {
      return this.cachedToken.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();

    const { response } = await safeFetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      allowedHosts: KICK_AUTH_HOSTS,
      timeoutMs: this.config.http?.timeoutMs ?? 8_000,
      maxRetries: 1,
      fetchImpl: this.config.http?.fetchImpl,
      dnsLookup: this.config.http?.dnsLookup,
    });

    if (!response.ok) {
      throw new Error(`Kick OAuth token request failed (${response.status})`);
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Kick OAuth response missing access_token');
    }
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.cachedToken.accessToken;
  }

  async resolve(source: UniversalMediaSource): Promise<PlatformResolutionResult> {
    const isClip = Boolean(source.metadata?.isClip);

    // Kick VOD & Clip URLs: Kick Public API v1 has no official VOD/clip download endpoints
    if (source.identityScope !== 'CHANNEL_DISCOVERY') {
      return {
        source,
        availability: 'UNKNOWN',
        capabilityStatus: 'UNSUPPORTED_ACQUISITION',
        canSubmitJob: false,
        reason: isClip
          ? 'Kick clip URL recognized, but Kick’s official Public API v1 does not provide clip download endpoints yet. Upload an authorized video file instead.'
          : 'Kick VOD URL recognized, but Kick’s official Public API v1 does not provide VOD retrieval or download endpoints yet. Upload an authorized video file instead.',
        supportedActions: ['upload_video'],
        metadata: {
          channelName: source.metadata?.channelName,
          isLive: false,
          isClip,
          platformClipSupported: false,
        },
      };
    }

    // Kick Channel / Live URL
    const hasCreds = Boolean(
      this.config.kickClientId?.trim() && this.config.kickClientSecret?.trim(),
    );
    if (!hasCreds) {
      return {
        source,
        availability: 'UNKNOWN',
        capabilityStatus: 'BROADCAST_UNRESOLVED',
        canSubmitJob: false,
        reason:
          'Kick live channel URL recognized. Official Kick Public API v1 app credentials are not configured yet, and Kick Public API v1 does not expose server-side stream downloading. Upload an authorized recording instead.',
        supportedActions: ['upload_video'],
        metadata: {
          channelName: source.metadata?.channelName,
          isLive: true,
          platformClipSupported: false,
        },
        providerNotice: {
          code: 'PROVIDER_CREDENTIALS_MISSING',
          message: 'Kick Public API v1 OAuth credentials are not configured on this server.',
        },
      };
    }

    try {
      const token = await this.getAppAccessToken();
      if (!token) return this.handleUnavailable(source);

      const slug = source.externalId.toLowerCase();
      const { response: chanRes } = await safeFetch(
        `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          allowedHosts: KICK_API_HOSTS,
          timeoutMs: this.config.http?.timeoutMs ?? 8_000,
          maxRetries: 1,
          fetchImpl: this.config.http?.fetchImpl,
          dnsLookup: this.config.http?.dnsLookup,
        },
      );

      if (chanRes.status === 404) {
        return {
          source: { ...source, availability: 'UNAVAILABLE' },
          availability: 'UNAVAILABLE',
          capabilityStatus: 'SOURCE_UNAVAILABLE',
          canSubmitJob: false,
          reason: `Kick channel "${slug}" was not found.`,
          supportedActions: ['upload_video'],
          metadata: { channelName: slug, isLive: false, platformClipSupported: false },
        };
      }
      if (!chanRes.ok) {
        return this.handleUnavailable(source, chanRes.status);
      }

      const chanJson = (await chanRes.json()) as {
        data?: Array<{
          broadcaster_user_id?: number;
          slug?: string;
          stream_title?: string;
          banner_picture?: string;
          category?: { name?: string; thumbnail?: string };
          stream?: {
            is_live?: boolean;
            start_time?: string;
            thumbnail?: string;
            viewer_count?: number;
          };
        }>;
      };
      const ch = chanJson.data?.[0];
      if (!ch) {
        return {
          source: { ...source, availability: 'UNAVAILABLE' },
          availability: 'UNAVAILABLE',
          capabilityStatus: 'SOURCE_UNAVAILABLE',
          canSubmitJob: false,
          reason: `Kick channel "${slug}" was not found.`,
          supportedActions: ['upload_video'],
          metadata: { channelName: slug, isLive: false, platformClipSupported: false },
        };
      }

      const thumb = sanitizeThumbnailUrl(
        ch.stream?.thumbnail ?? ch.banner_picture ?? ch.category?.thumbnail,
      );

      if (!ch.stream?.is_live) {
        return {
          source: { ...source, availability: 'OFFLINE' },
          availability: 'OFFLINE',
          capabilityStatus: 'BROADCAST_UNRESOLVED',
          canSubmitJob: false,
          reason: `${ch.slug || slug} is currently offline on Kick (no active live broadcast).`,
          supportedActions: ['upload_video'],
          metadata: {
            channelName: ch.slug || slug,
            thumbnailUrl: thumb,
            isLive: false,
            platformClipSupported: false,
          },
        };
      }

      // Resolve immutable livestream session ID from /public/v1/livestreams when broadcaster_user_id is available
      let broadcastId: string | undefined;
      if (ch.broadcaster_user_id) {
        const { response: lsRes } = await safeFetch(
          `https://api.kick.com/public/v1/livestreams?broadcaster_user_id=${encodeURIComponent(String(ch.broadcaster_user_id))}`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            allowedHosts: KICK_API_HOSTS,
            timeoutMs: this.config.http?.timeoutMs ?? 8_000,
            maxRetries: 1,
            fetchImpl: this.config.http?.fetchImpl,
            dnsLookup: this.config.http?.dnsLookup,
          },
        );
        if (lsRes.ok) {
          const lsJson = (await lsRes.json()) as {
            data?: Array<{ id?: number | string; session_title?: string }>;
          };
          const activeLs = lsJson.data?.[0];
          if (activeLs?.id !== undefined && activeLs?.id !== null) {
            broadcastId = String(activeLs.id);
          }
        }
      }

      if (!broadcastId) {
        return {
          source: { ...source, availability: 'LIVE_NOW' },
          availability: 'LIVE_NOW',
          capabilityStatus: 'BROADCAST_UNRESOLVED',
          canSubmitJob: false,
          reason:
            'Kick channel appears live, but a verified immutable broadcast session ID could not be resolved via Public API v1, and stream download is not officially supported.',
          supportedActions: ['upload_video'],
          metadata: {
            title: ch.stream_title,
            channelName: ch.slug || slug,
            thumbnailUrl: thumb,
            isLive: true,
            publishedAt: ch.stream.start_time,
            platformClipSupported: false,
          },
        };
      }

      const bound = bindVerifiedBroadcastSession(source, { broadcastId });
      return {
        source: {
          ...bound,
          metadata: {
            ...bound.metadata,
            hasAudio: bound.metadata?.hasAudio ?? true,
            title: ch.stream_title,
            channelName: ch.slug || slug,
            thumbnailUrl: thumb,
            isLive: true,
            publishedAt: ch.stream.start_time,
          },
        },
        availability: 'LIVE_NOW',
        capabilityStatus: 'UNSUPPORTED_ACQUISITION',
        canSubmitJob: false,
        reason:
          'Active Kick livestream resolved via Public API v1, but Kick Public API v1 does not provide an official server-side media ingestion endpoint. Upload an authorized recording instead.',
        supportedActions: ['upload_video'],
        metadata: {
          title: ch.stream_title,
          channelName: ch.slug || slug,
          thumbnailUrl: thumb,
          broadcastId,
          isLive: true,
          isClip: false,
          publishedAt: ch.stream.start_time,
          platformClipSupported: false,
        },
      };
    } catch (err) {
      if (err instanceof ProviderRateLimitError) {
        return {
          source,
          availability: 'UNKNOWN',
          capabilityStatus: 'BROADCAST_UNRESOLVED',
          canSubmitJob: false,
          reason: 'Kick Public API rate limit reached. Please retry shortly or upload an authorized video.',
          supportedActions: ['upload_video'],
          metadata: { isLive: true, platformClipSupported: false },
          providerNotice: {
            code: 'PROVIDER_RATE_LIMITED',
            message: err.message,
            retryAfterSec: err.retryAfterSec,
          },
        };
      }
      return this.handleUnavailable(source);
    }
  }

  private handleUnavailable(source: UniversalMediaSource, status?: number): PlatformResolutionResult {
    return {
      source,
      availability: 'UNKNOWN',
      capabilityStatus: 'BROADCAST_UNRESOLVED',
      canSubmitJob: false,
      reason: 'Kick Public API v1 is temporarily unavailable. Upload an authorized video file directly.',
      supportedActions: ['upload_video'],
      metadata: { isLive: source.sourceType === 'live', platformClipSupported: false },
      providerNotice: {
        code: 'PROVIDER_UNAVAILABLE',
        message: status ? `Kick API returned HTTP ${status}.` : 'Unable to reach Kick Public API v1.',
      },
    };
  }
}
