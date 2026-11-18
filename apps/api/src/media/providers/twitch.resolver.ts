import type { UniversalMediaSource } from '@autoedit/contracts';
import { bindVerifiedBroadcastSession } from '../canonical-source.js';
import { ProviderRateLimitError, safeFetch } from '../safe-http.js';
import {
  parseTwitchDurationSec,
  sanitizeThumbnailUrl,
  type PlatformProviderConfig,
  type PlatformResolutionResult,
} from './types.js';

const TWITCH_AUTH_HOSTS = new Set(['id.twitch.tv']);
const TWITCH_API_HOSTS = new Set(['api.twitch.tv']);

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Official Twitch Helix Metadata Resolver (Step 3C.2).
 *
 * Uses Twitch App Access Token (OAuth 2.0 Client Credentials flow via `id.twitch.tv/oauth2/token`)
 * so independent clippers NEVER need mandatory streamer login to inspect public URLs:
 * - Channel/live URLs: `GET /helix/streams?user_login=` & `GET /helix/users?login=`
 * - VOD URLs: `GET /helix/videos?id=`
 * - Clip URLs: `GET /helix/clips?id=`
 *
 * Truthful capability separation:
 * - Helix exposes metadata for live streams, VODs, and clips.
 * - Full-footage live/VOD downloading is NOT supported by the Twitch Helix API.
 * - Official clip MP4 retrieval (`GET /helix/clips/download`) requires broadcaster
 *   (`channel:manage:clips`) or channel editor (`editor:manage:clips`) authorization.
 */
export class TwitchSourceResolver {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly config: PlatformProviderConfig = {}) {}

  private async getAppAccessToken(): Promise<string | null> {
    const clientId = this.config.twitchClientId?.trim();
    const clientSecret = this.config.twitchClientSecret?.trim();
    if (!clientId || !clientSecret) return null;

    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now() + 60_000) {
      return this.cachedToken.accessToken;
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }).toString();

    const { response } = await safeFetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      allowedHosts: TWITCH_AUTH_HOSTS,
      timeoutMs: this.config.http?.timeoutMs ?? 8_000,
      maxRetries: 1,
      fetchImpl: this.config.http?.fetchImpl,
      dnsLookup: this.config.http?.dnsLookup,
    });

    if (!response.ok) {
      throw new Error(`Twitch OAuth token request failed (${response.status})`);
    }

    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Twitch OAuth response missing access_token');
    }
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.cachedToken.accessToken;
  }

  private async helixGet<T>(pathAndQuery: string, token: string): Promise<{ status: number; json: T | null }> {
    const clientId = this.config.twitchClientId!.trim();
    const { response } = await safeFetch(`https://api.twitch.tv/helix${pathAndQuery}`, {
      headers: {
        'Client-Id': clientId,
        Authorization: `Bearer ${token}`,
      },
      allowedHosts: TWITCH_API_HOSTS,
      timeoutMs: this.config.http?.timeoutMs ?? 8_000,
      maxRetries: 1,
      fetchImpl: this.config.http?.fetchImpl,
      dnsLookup: this.config.http?.dnsLookup,
    });

    if (!response.ok) {
      return { status: response.status, json: null };
    }
    return { status: response.status, json: (await response.json()) as T };
  }

  async resolve(source: UniversalMediaSource): Promise<PlatformResolutionResult> {
    const hasCreds = Boolean(
      this.config.twitchClientId?.trim() && this.config.twitchClientSecret?.trim(),
    );

    if (!hasCreds) {
      const isChannel = source.identityScope === 'CHANNEL_DISCOVERY';
      const isClip = Boolean(source.metadata?.isClip);
      return {
        source,
        availability: 'UNKNOWN',
        capabilityStatus: isChannel ? 'BROADCAST_UNRESOLVED' : 'UNSUPPORTED_ACQUISITION',
        canSubmitJob: false,
        reason: isClip
          ? 'Twitch clip URL recognized. Twitch clip download via Helix requires broadcaster/editor authorization, and server-side Twitch API credentials are not configured yet. Upload an authorized video file instead.'
          : isChannel
            ? 'Twitch live channel URL recognized. Live stream discovery requires server-side Twitch Helix credentials, and full livestream downloading is not supported via Helix. Upload an authorized recording instead.'
            : 'Twitch VOD URL recognized. Twitch Helix does not provide automated VOD downloading for third-party clippers. Upload an authorized video file instead.',
        supportedActions: ['upload_video'],
        metadata: {
          channelName: source.metadata?.channelName,
          isLive: source.sourceType === 'live',
          isClip,
          platformClipSupported: isClip,
        },
        providerNotice: {
          code: 'PROVIDER_CREDENTIALS_MISSING',
          message: 'Twitch Helix app credentials are not configured on this server.',
        },
      };
    }

    try {
      const token = await this.getAppAccessToken();
      if (!token) return this.handleUnavailable(source);

      // 1. Twitch Channel / Live URL -> GET /helix/streams?user_login=
      if (source.identityScope === 'CHANNEL_DISCOVERY') {
        const login = source.externalId.toLowerCase();
        const streamRes = await this.helixGet<{
          data?: Array<{
            id: string;
            user_login: string;
            user_name: string;
            title: string;
            started_at: string;
            thumbnail_url: string;
            type: string;
          }>;
        }>(`/streams?user_login=${encodeURIComponent(login)}`, token);

        if (streamRes.status >= 500 || !streamRes.json) {
          return this.handleUnavailable(source, streamRes.status);
        }

        const live = streamRes.json.data?.[0];
        if (live && live.id) {
          const bound = bindVerifiedBroadcastSession(source, { broadcastId: live.id });
          const thumb = sanitizeThumbnailUrl(live.thumbnail_url);
          return {
            source: {
              ...bound,
              metadata: {
                ...bound.metadata,
                hasAudio: bound.metadata?.hasAudio ?? true,
                title: live.title,
                channelName: live.user_name || live.user_login,
                thumbnailUrl: thumb,
                isLive: true,
                publishedAt: live.started_at,
              },
            },
            availability: 'LIVE_NOW',
            capabilityStatus: 'UNSUPPORTED_ACQUISITION',
            canSubmitJob: false,
            reason:
              'Active Twitch livestream resolved via Helix API, but Twitch Helix does not provide third-party server-side full-stream downloading. Upload an authorized recording to detect highlights.',
            supportedActions: ['upload_video'],
            metadata: {
              title: live.title,
              channelName: live.user_name || live.user_login,
              thumbnailUrl: thumb,
              broadcastId: live.id,
              isLive: true,
              isClip: false,
              publishedAt: live.started_at,
              platformClipSupported: true,
            },
          };
        }

        // Not live -> verify whether channel exists via GET /helix/users?login=
        const userRes = await this.helixGet<{
          data?: Array<{ id: string; login: string; display_name: string; profile_image_url?: string }>;
        }>(`/users?login=${encodeURIComponent(login)}`, token);

        const user = userRes.json?.data?.[0];
        if (!user) {
          return {
            source: { ...source, availability: 'UNAVAILABLE' },
            availability: 'UNAVAILABLE',
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            canSubmitJob: false,
            reason: `Twitch channel "${login}" was not found.`,
            supportedActions: ['upload_video'],
            metadata: { channelName: login, isLive: false },
          };
        }

        return {
          source: { ...source, availability: 'OFFLINE' },
          availability: 'OFFLINE',
          capabilityStatus: 'BROADCAST_UNRESOLVED',
          canSubmitJob: false,
          reason: `${user.display_name || login} is currently offline on Twitch (no active live broadcast).`,
          supportedActions: ['upload_video'],
          metadata: {
            channelName: user.display_name || login,
            thumbnailUrl: sanitizeThumbnailUrl(user.profile_image_url),
            isLive: false,
            platformClipSupported: true,
          },
        };
      }

      // 2. Twitch Clip URL -> GET /helix/clips?id=<slug>
      if (source.metadata?.isClip) {
        const slug = source.externalId.replace(/^clip_/, '');
        const clipRes = await this.helixGet<{
          data?: Array<{
            id: string;
            title: string;
            broadcaster_name: string;
            duration: number;
            thumbnail_url: string;
            created_at: string;
            video_id: string;
          }>;
        }>(`/clips?id=${encodeURIComponent(slug)}`, token);

        if (clipRes.status >= 500 || !clipRes.json) {
          return this.handleUnavailable(source, clipRes.status);
        }

        const clip = clipRes.json.data?.[0];
        if (!clip) {
          return {
            source: { ...source, availability: 'UNAVAILABLE' },
            availability: 'UNAVAILABLE',
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            canSubmitJob: false,
            reason: 'Twitch clip was not found or has been removed.',
            supportedActions: ['upload_video'],
            metadata: { isLive: false, isClip: true, platformClipSupported: true },
          };
        }

        const thumb = sanitizeThumbnailUrl(clip.thumbnail_url);
        return {
          source: {
            ...source,
            availability: 'AVAILABLE',
            metadata: {
              ...source.metadata,
              title: clip.title,
              channelName: clip.broadcaster_name,
              durationSec: clip.duration,
              thumbnailUrl: thumb,
              isLive: false,
              isClip: true,
              publishedAt: clip.created_at,
            },
          },
          availability: 'AVAILABLE',
          capabilityStatus: 'REQUIRES_PERMISSION',
          canSubmitJob: false,
          reason:
            'Twitch clip metadata resolved via Helix API. Official clip file download (/helix/clips/download) requires broadcaster or channel-editor OAuth scope (channel:manage:clips / editor:manage:clips). Upload a video file you are authorized to edit.',
          supportedActions: ['upload_video'],
          metadata: {
            title: clip.title,
            channelName: clip.broadcaster_name,
            durationSec: clip.duration,
            thumbnailUrl: thumb,
            isLive: false,
            isClip: true,
            publishedAt: clip.created_at,
            platformClipSupported: true,
          },
        };
      }

      // 3. Twitch VOD URL -> GET /helix/videos?id=<vodId>
      const vodRes = await this.helixGet<{
        data?: Array<{
          id: string;
          stream_id?: string | null;
          user_name: string;
          title: string;
          duration: string;
          thumbnail_url: string;
          created_at: string;
        }>;
      }>(`/videos?id=${encodeURIComponent(source.externalId)}`, token);

      if (vodRes.status === 404 || (vodRes.status === 200 && !vodRes.json?.data?.[0])) {
        return {
          source: { ...source, availability: 'UNAVAILABLE' },
          availability: 'UNAVAILABLE',
          capabilityStatus: 'SOURCE_UNAVAILABLE',
          canSubmitJob: false,
          reason: 'Twitch VOD was not found, expired, or is subscriber-restricted.',
          supportedActions: ['upload_video'],
          metadata: { isLive: false, platformClipSupported: true },
        };
      }
      if (vodRes.status >= 500 || !vodRes.json) {
        return this.handleUnavailable(source, vodRes.status);
      }

      const vod = vodRes.json.data![0];
      const durationSec = parseTwitchDurationSec(vod.duration);
      const thumb = sanitizeThumbnailUrl(vod.thumbnail_url);

      return {
        source: {
          ...source,
          availability: 'AVAILABLE',
          broadcastId: vod.stream_id || undefined,
            metadata: {
              ...source.metadata,
              hasAudio: source.metadata?.hasAudio ?? true,
              title: vod.title,
              channelName: vod.user_name,
              durationSec,
              thumbnailUrl: thumb,
              isLive: false,
              publishedAt: vod.created_at,
            },
        },
        availability: 'AVAILABLE',
        capabilityStatus: 'UNSUPPORTED_ACQUISITION',
        canSubmitJob: false,
        reason:
          'Twitch VOD metadata resolved via Helix API, but Twitch Helix does not expose a full VOD download endpoint for third-party clippers. Upload an authorized video file instead.',
        supportedActions: ['upload_video'],
        metadata: {
          title: vod.title,
          channelName: vod.user_name,
          durationSec,
          thumbnailUrl: thumb,
          broadcastId: vod.stream_id || undefined,
          isLive: false,
          isClip: false,
          publishedAt: vod.created_at,
          platformClipSupported: true,
        },
      };
    } catch (err) {
      if (err instanceof ProviderRateLimitError) {
        return {
          source,
          availability: 'UNKNOWN',
          capabilityStatus:
            source.identityScope === 'CHANNEL_DISCOVERY'
              ? 'BROADCAST_UNRESOLVED'
              : 'UNSUPPORTED_ACQUISITION',
          canSubmitJob: false,
          reason: 'Twitch Helix API rate limit reached. Please retry shortly or upload an authorized video.',
          supportedActions: ['upload_video'],
          metadata: { isLive: source.sourceType === 'live', platformClipSupported: true },
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
      capabilityStatus:
        source.identityScope === 'CHANNEL_DISCOVERY'
          ? 'BROADCAST_UNRESOLVED'
          : 'UNSUPPORTED_ACQUISITION',
      canSubmitJob: false,
      reason: 'Twitch Helix API is temporarily unavailable. Upload an authorized video file directly.',
      supportedActions: ['upload_video'],
      metadata: { isLive: source.sourceType === 'live', platformClipSupported: true },
      providerNotice: {
        code: 'PROVIDER_UNAVAILABLE',
        message: status ? `Twitch Helix API returned HTTP ${status}.` : 'Unable to reach Twitch Helix API.',
      },
    };
  }
}
