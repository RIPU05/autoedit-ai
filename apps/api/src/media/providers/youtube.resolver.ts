import type { UniversalMediaSource } from '@autoedit/contracts';
import { bindVerifiedBroadcastSession } from '../canonical-source.js';
import { ProviderRateLimitError, safeFetch } from '../safe-http.js';
import {
  parseIso8601DurationSec,
  sanitizeThumbnailUrl,
  type PlatformProviderConfig,
  type PlatformResolutionResult,
} from './types.js';

const YOUTUBE_API_HOSTS = new Set(['www.googleapis.com']);
const YOUTUBE_OEMBED_HOSTS = new Set(['www.youtube.com']);

const YOUTUBE_POLICY_REASON =
  'YouTube metadata was resolved, but YouTube Developer Policies prohibit third-party server-side video or stream downloading. Upload a video file you are authorized to edit.';

interface YouTubeVideoApiItem {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    liveBroadcastContent?: 'live' | 'upcoming' | 'none';
    thumbnails?: {
      high?: { url?: string };
      medium?: { url?: string };
      default?: { url?: string };
    };
  };
  contentDetails?: {
    duration?: string;
  };
  liveStreamingDetails?: {
    actualStartTime?: string;
    actualEndTime?: string;
    scheduledStartTime?: string;
    concurrentViewers?: string;
  };
  status?: {
    privacyStatus?: string;
    embeddable?: boolean;
  };
}

/**
 * Official YouTube Metadata Resolver (Step 3C.2).
 *
 * Uses strictly documented official endpoints:
 * 1. YouTube Data API v3 (`videos.list`, `channels.list`, quota-bounded `search.list?eventType=live`)
 *    when `YOUTUBE_API_KEY` is configured on the server (never exposed to browser).
 * 2. Official unauthenticated `https://www.youtube.com/oembed` fallback for public video/live URLs
 *    when `YOUTUBE_API_KEY` is absent.
 *
 * Strictly complies with YouTube Developer Policies: NEVER extracts raw media URLs or downloads streams.
 */
export class YouTubeSourceResolver {
  private dailySearchCalls = { day: '', count: 0 };

  constructor(private readonly config: PlatformProviderConfig = {}) {}

  private consumeSearchBudget(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailySearchCalls.day !== today) {
      this.dailySearchCalls = { day: today, count: 0 };
    }
    const limit = this.config.youtubeDailySearchLimit ?? 50;
    if (this.dailySearchCalls.count >= limit) return false;
    this.dailySearchCalls.count++;
    return true;
  }

  private async fetchOembed(url: string): Promise<{
    title?: string;
    channelName?: string;
    thumbnailUrl?: string;
  } | null> {
    if (this.config.enableYoutubeOembedFallback === false) return null;
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const { response } = await safeFetch(oembedUrl, {
        allowedHosts: YOUTUBE_OEMBED_HOSTS,
        timeoutMs: this.config.http?.timeoutMs ?? 6_000,
        maxRetries: 0,
        fetchImpl: this.config.http?.fetchImpl,
        dnsLookup: this.config.http?.dnsLookup,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      return {
        title: typeof body.title === 'string' ? body.title : undefined,
        channelName: typeof body.author_name === 'string' ? body.author_name : undefined,
        thumbnailUrl: sanitizeThumbnailUrl(body.thumbnail_url),
      };
    } catch {
      return null;
    }
  }

  async resolve(source: UniversalMediaSource): Promise<PlatformResolutionResult> {
    const apiKey = this.config.youtubeApiKey?.trim();

    // 1. YouTube Clip URL (not exposed for download in Data API v3)
    if (source.metadata?.isClip) {
      return {
        source,
        availability: 'UNKNOWN',
        capabilityStatus: 'UNSUPPORTED_ACQUISITION',
        canSubmitJob: false,
        reason:
          'YouTube clip URL recognized, but YouTube APIs do not provide third-party clip downloading. Upload an authorized video file instead.',
        supportedActions: ['upload_video'],
        metadata: {
          isLive: false,
          isClip: true,
          platformClipSupported: false,
        },
      };
    }

    // 2. YouTube Channel / @handle / UC... live discovery URL
    if (source.identityScope === 'CHANNEL_DISCOVERY') {
      if (!apiKey) {
        return {
          source,
          availability: 'UNKNOWN',
          capabilityStatus: 'BROADCAST_UNRESOLVED',
          canSubmitJob: false,
          reason:
            'Recognized YouTube channel URL. Live broadcast discovery requires server-side YouTube Data API v3 credentials, and YouTube Developer Policies prohibit automated stream downloading. Upload an authorized recording instead.',
          supportedActions: ['upload_video'],
          metadata: {
            channelName: source.metadata?.channelName,
            isLive: true,
            platformClipSupported: false,
          },
          providerNotice: {
            code: 'PROVIDER_CREDENTIALS_MISSING',
            message: 'YouTube Data API v3 key is not configured for live channel metadata lookup.',
          },
        };
      }

      try {
        const isUcId = source.externalId.startsWith('UC');
        const chanQuery = isUcId
          ? `id=${encodeURIComponent(source.externalId)}`
          : `forHandle=${encodeURIComponent(source.externalId)}`;
        const chanUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&${chanQuery}&key=${encodeURIComponent(apiKey)}`;
        const { response: chanRes } = await safeFetch(chanUrl, {
          allowedHosts: YOUTUBE_API_HOSTS,
          timeoutMs: this.config.http?.timeoutMs ?? 8_000,
          maxRetries: 1,
          fetchImpl: this.config.http?.fetchImpl,
          dnsLookup: this.config.http?.dnsLookup,
        });

        if (chanRes.status === 403 || chanRes.status === 429) {
          return this.handleQuotaOrError(source, chanRes.status);
        }
        if (!chanRes.ok) {
          return this.handleProviderUnavailable(source, chanRes.status);
        }

        const chanJson = (await chanRes.json()) as {
          items?: Array<{ id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }>;
        };
        const chanItem = chanJson.items?.[0];
        if (!chanItem?.id) {
          return {
            source: { ...source, availability: 'UNAVAILABLE' },
            availability: 'UNAVAILABLE',
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            canSubmitJob: false,
            reason: 'YouTube channel was not found.',
            supportedActions: ['upload_video'],
            metadata: { channelName: source.metadata?.channelName, isLive: false },
          };
        }

        const channelTitle = chanItem.snippet?.title ?? source.metadata?.channelName;
        const chanThumb = sanitizeThumbnailUrl(chanItem.snippet?.thumbnails?.default?.url);

        if (!this.consumeSearchBudget()) {
          return {
            source,
            availability: 'UNKNOWN',
            capabilityStatus: 'BROADCAST_UNRESOLVED',
            canSubmitJob: false,
            reason:
              'YouTube live-channel search quota budget reached for today. Paste a direct video/live URL or upload an authorized recording.',
            supportedActions: ['upload_video'],
            metadata: { channelName: channelTitle, thumbnailUrl: chanThumb, isLive: true },
            providerNotice: {
              code: 'PROVIDER_RATE_LIMITED',
              message: 'Daily YouTube live search quota limit reached.',
            },
          };
        }

        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(chanItem.id)}&eventType=live&type=video&maxResults=1&key=${encodeURIComponent(apiKey)}`;
        const { response: searchRes } = await safeFetch(searchUrl, {
          allowedHosts: YOUTUBE_API_HOSTS,
          timeoutMs: this.config.http?.timeoutMs ?? 8_000,
          maxRetries: 1,
          fetchImpl: this.config.http?.fetchImpl,
          dnsLookup: this.config.http?.dnsLookup,
        });

        if (searchRes.status === 403 || searchRes.status === 429) {
          return this.handleQuotaOrError(source, searchRes.status);
        }
        if (!searchRes.ok) {
          return this.handleProviderUnavailable(source, searchRes.status);
        }

        const searchJson = (await searchRes.json()) as {
          items?: Array<{
            id?: { videoId?: string };
            snippet?: {
              title?: string;
              channelTitle?: string;
              publishedAt?: string;
              thumbnails?: { high?: { url?: string }; default?: { url?: string } };
            };
          }>;
        };
        const liveItem = searchJson.items?.[0];
        const liveVideoId = liveItem?.id?.videoId;

        if (!liveVideoId) {
          return {
            source: { ...source, availability: 'OFFLINE' },
            availability: 'OFFLINE',
            capabilityStatus: 'BROADCAST_UNRESOLVED',
            canSubmitJob: false,
            reason: `${channelTitle || 'This YouTube channel'} does not currently have an active public livestream.`,
            supportedActions: ['upload_video'],
            metadata: {
              channelName: channelTitle,
              thumbnailUrl: chanThumb,
              isLive: false,
              platformClipSupported: false,
            },
          };
        }

        const bound = bindVerifiedBroadcastSession(source, { broadcastId: liveVideoId });
        const liveThumb = sanitizeThumbnailUrl(
          liveItem.snippet?.thumbnails?.high?.url ?? liveItem.snippet?.thumbnails?.default?.url ?? chanThumb,
        );

        return {
          source: {
            ...bound,
            normalizedUrl: `https://www.youtube.com/live/${liveVideoId}`,
            metadata: {
              ...bound.metadata,
              hasAudio: bound.metadata?.hasAudio ?? true,
              title: liveItem.snippet?.title,
              channelName: liveItem.snippet?.channelTitle ?? channelTitle,
              thumbnailUrl: liveThumb,
              isLive: true,
              publishedAt: liveItem.snippet?.publishedAt,
            },
          },
          availability: 'LIVE_NOW',
          capabilityStatus: 'UNSUPPORTED_ACQUISITION',
          canSubmitJob: false,
          reason: YOUTUBE_POLICY_REASON,
          supportedActions: ['upload_video'],
          metadata: {
            title: liveItem.snippet?.title,
            channelName: liveItem.snippet?.channelTitle ?? channelTitle,
            thumbnailUrl: liveThumb,
            broadcastId: liveVideoId,
            isLive: true,
            publishedAt: liveItem.snippet?.publishedAt,
            platformClipSupported: false,
          },
        };
      } catch (err) {
        if (err instanceof ProviderRateLimitError) {
          return this.handleQuotaOrError(source, 429, err.retryAfterSec);
        }
        return this.handleProviderUnavailable(source);
      }
    }

    // 3. Direct YouTube Video / Live Broadcast URL (`watch?v=`, `youtu.be/`, `live/`, `shorts/`)
    if (!apiKey) {
      const oembed = source.normalizedUrl ? await this.fetchOembed(source.normalizedUrl) : null;
      return {
        source: {
          ...source,
          availability: oembed ? 'AVAILABLE' : 'UNKNOWN',
          metadata: {
            ...source.metadata,
            hasAudio: source.metadata?.hasAudio ?? true,
            title: oembed?.title ?? source.metadata?.title,
            channelName: oembed?.channelName ?? source.metadata?.channelName,
            thumbnailUrl: oembed?.thumbnailUrl,
          },
        },
        availability: oembed ? 'AVAILABLE' : 'UNKNOWN',
        capabilityStatus: 'UNSUPPORTED_ACQUISITION',
        canSubmitJob: false,
        reason: YOUTUBE_POLICY_REASON,
        supportedActions: ['upload_video'],
        metadata: {
          title: oembed?.title,
          channelName: oembed?.channelName,
          thumbnailUrl: oembed?.thumbnailUrl,
          broadcastId: source.broadcastId,
          isLive: source.sourceType === 'live',
          isClip: false,
          platformClipSupported: false,
        },
        ...(oembed
          ? {}
          : {
              providerNotice: {
                code: 'PROVIDER_CREDENTIALS_MISSING',
                message: 'YouTube Data API v3 key is not configured; full duration and live status could not be verified.',
              },
            }),
      };
    }

    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails,status&id=${encodeURIComponent(source.externalId)}&key=${encodeURIComponent(apiKey)}`;
      const { response } = await safeFetch(url, {
        allowedHosts: YOUTUBE_API_HOSTS,
        timeoutMs: this.config.http?.timeoutMs ?? 8_000,
        maxRetries: 1,
        fetchImpl: this.config.http?.fetchImpl,
        dnsLookup: this.config.http?.dnsLookup,
      });

      if (response.status === 403 || response.status === 429) {
        return this.handleQuotaOrError(source, response.status);
      }
      if (!response.ok) {
        return this.handleProviderUnavailable(source, response.status);
      }

      const json = (await response.json()) as { items?: YouTubeVideoApiItem[] };
      const item = json.items?.[0];
      if (!item) {
        return {
          source: { ...source, availability: 'UNAVAILABLE' },
          availability: 'UNAVAILABLE',
          capabilityStatus: 'SOURCE_UNAVAILABLE',
          canSubmitJob: false,
          reason: 'This YouTube video or livestream is unavailable, private, or deleted.',
          supportedActions: ['upload_video'],
          metadata: { isLive: false, platformClipSupported: false },
        };
      }

      const liveFlag = item.snippet?.liveBroadcastContent;
      const liveDetails = item.liveStreamingDetails;
      const isLiveNow = liveFlag === 'live' || Boolean(liveDetails?.actualStartTime && !liveDetails?.actualEndTime);
      const isEndedBroadcast = Boolean(liveDetails?.actualEndTime);
      const durationSec = parseIso8601DurationSec(item.contentDetails?.duration);
      const thumb = sanitizeThumbnailUrl(
        item.snippet?.thumbnails?.high?.url ??
          item.snippet?.thumbnails?.medium?.url ??
          item.snippet?.thumbnails?.default?.url,
      );

      const availability = isLiveNow
        ? 'LIVE_NOW'
        : isEndedBroadcast && !durationSec
          ? 'ENDED_PROCESSING'
          : 'AVAILABLE';
      const resolvedSourceType = isLiveNow ? 'live' : 'vod';
      const canonicalId = isLiveNow
        ? (`youtube:broadcast:${source.externalId}` as const)
        : (`youtube:vod:${source.externalId}` as const);

      return {
        source: {
          ...source,
          canonicalId,
          identityScope: isLiveNow ? 'IMMUTABLE_BROADCAST' : 'IMMUTABLE_VOD',
          sourceType: resolvedSourceType,
          broadcastId: isLiveNow || isEndedBroadcast ? source.externalId : undefined,
          availability,
          metadata: {
            ...source.metadata,
            hasAudio: source.metadata?.hasAudio ?? true,
            title: item.snippet?.title,
            channelName: item.snippet?.channelTitle,
            durationSec,
            thumbnailUrl: thumb,
            isLive: isLiveNow,
            publishedAt: item.snippet?.publishedAt,
          },
        },
        availability,
        capabilityStatus: 'UNSUPPORTED_ACQUISITION',
        canSubmitJob: false,
        reason: isEndedBroadcast
          ? 'This YouTube livestream has ended and is now a recorded VOD. YouTube Developer Policies prohibit third-party server-side video downloading — upload an authorized video file instead.'
          : YOUTUBE_POLICY_REASON,
        supportedActions: ['upload_video'],
        metadata: {
          title: item.snippet?.title,
          channelName: item.snippet?.channelTitle,
          durationSec,
          thumbnailUrl: thumb,
          broadcastId: isLiveNow || isEndedBroadcast ? source.externalId : undefined,
          isLive: isLiveNow,
          isClip: false,
          publishedAt: item.snippet?.publishedAt,
          platformClipSupported: false,
        },
      };
    } catch (err) {
      if (err instanceof ProviderRateLimitError) {
        return this.handleQuotaOrError(source, 429, err.retryAfterSec);
      }
      return this.handleProviderUnavailable(source);
    }
  }

  private handleQuotaOrError(
    source: UniversalMediaSource,
    status: number,
    retryAfterSec?: number,
  ): PlatformResolutionResult {
    return {
      source,
      availability: 'UNKNOWN',
      capabilityStatus:
        source.identityScope === 'CHANNEL_DISCOVERY'
          ? 'BROADCAST_UNRESOLVED'
          : 'UNSUPPORTED_ACQUISITION',
      canSubmitJob: false,
      reason:
        'YouTube API quota or rate limit was reached while fetching metadata. You can still upload an authorized video file directly.',
      supportedActions: ['upload_video'],
      metadata: { isLive: source.sourceType === 'live', platformClipSupported: false },
      providerNotice: {
        code: 'PROVIDER_RATE_LIMITED',
        message: `YouTube Data API returned HTTP ${status} (quota/rate limit).`,
        retryAfterSec,
      },
    };
  }

  private handleProviderUnavailable(
    source: UniversalMediaSource,
    status?: number,
  ): PlatformResolutionResult {
    return {
      source,
      availability: 'UNKNOWN',
      capabilityStatus:
        source.identityScope === 'CHANNEL_DISCOVERY'
          ? 'BROADCAST_UNRESOLVED'
          : 'UNSUPPORTED_ACQUISITION',
      canSubmitJob: false,
      reason:
        'YouTube metadata API is temporarily unavailable. YouTube streams cannot be downloaded automatically — upload an authorized video file directly.',
      supportedActions: ['upload_video'],
      metadata: { isLive: source.sourceType === 'live', platformClipSupported: false },
      providerNotice: {
        code: 'PROVIDER_UNAVAILABLE',
        message: status
          ? `YouTube Data API returned HTTP ${status}.`
          : 'Unable to reach YouTube metadata API.',
      },
    };
  }
}
