import path from 'node:path';
import type { CacheableSourceId, UniversalMediaSource } from '@autoedit/contracts';
import { MediaSourceError } from '../errors.js';
import { safeFetch } from '../safe-http.js';
import type { PlatformProviderConfig, PlatformResolutionResult } from './types.js';

const DEFAULT_MAX_DIRECT_MEDIA_BYTES = 500 * 1024 * 1024; // 500 MiB free-beta cap
const ALLOWED_VIDEO_CT_RE = /^(video\/|application\/octet-stream)/i;
const ALLOWED_HLS_CT_RE =
  /^(application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl|text\/plain|application\/octet-stream)/i;

function titleFromUrlPath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const base = path.posix.basename(parsed.pathname);
    return base || parsed.hostname;
  } catch {
    return 'Authorized Media';
  }
}

/**
 * Authorized Direct Media URL Resolver (Step 3C.2).
 *
 * Inspects remote media URLs on explicitly allowlisted hosts (`DIRECT_MEDIA_ALLOWED_HOSTS`)
 * using `safeFetch` (SSRF, DNS rebinding, and redirect-hop validation):
 * - Supports finite VOD media (`.mp4`, `.mov`, `.webm`, `.mkv`) via bounded `HEAD`.
 * - Supports live & recorded HLS playlists (`.m3u8`) via bounded `GET` (detecting live vs ended
 *   broadcast via `#EXT-X-ENDLIST` and deriving total duration when finite).
 *
 * CRITICAL RIGHTS BOUNDARY:
 * - Host allowlisting alone ONLY establishes a safe network destination (returns `REQUIRES_PERMISSION`).
 * - `READY_TO_PROCESS` is granted ONLY when an active server-verified `MediaRightsGrant` exists
 *   OR the host is explicitly configured in server-trusted `DIRECT_MEDIA_PERMITTED_PUBLIC_HOSTS`.
 */
export class DirectMediaSourceResolver {
  constructor(private readonly config: PlatformProviderConfig = {}) {}

  async resolve(
    source: UniversalMediaSource,
    opts: { hasServerVerifiedGrant?: boolean } = {},
  ): Promise<PlatformResolutionResult> {
    const normalizedUrl = source.normalizedUrl;
    if (!normalizedUrl) {
      return {
        source,
        availability: 'UNAVAILABLE',
        capabilityStatus: 'SOURCE_UNAVAILABLE',
        canSubmitJob: false,
        reason: 'Direct media URL is missing.',
        supportedActions: ['upload_video'],
        metadata: { isLive: false },
      };
    }

    const parsed = new URL(normalizedUrl);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const allowedHosts = this.config.directMediaAllowedHosts ?? new Set<string>();
    const permittedPublicHosts = this.config.directMediaPermittedPublicHosts ?? new Set<string>();
    const maxBytes = this.config.maxDirectMediaBytes ?? DEFAULT_MAX_DIRECT_MEDIA_BYTES;
    const isHls = /\.m3u8$/i.test(parsed.pathname);
    const isRightsPermitted = Boolean(opts.hasServerVerifiedGrant || permittedPublicHosts.has(host));

    try {
      if (isHls) {
        const { response, finalUrl } = await safeFetch(normalizedUrl, {
          method: 'GET',
          allowedHosts,
          timeoutMs: this.config.http?.timeoutMs ?? 8_000,
          maxRetries: 1,
          fetchImpl: this.config.http?.fetchImpl,
          dnsLookup: this.config.http?.dnsLookup,
          allowLocalhostForTest: this.config.http?.allowLocalhostForTest,
        });

        if (response.status === 404 || response.status === 410) {
          return {
            source: { ...source, availability: 'UNAVAILABLE' },
            availability: 'UNAVAILABLE',
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            canSubmitJob: false,
            reason: 'Authorized HLS playlist was not found (HTTP 404/410).',
            supportedActions: ['upload_video'],
            metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
          };
        }
        if (response.status === 401 || response.status === 403) {
          return {
            source: { ...source, availability: 'UNAVAILABLE', rightsStatus: 'REQUIRES_AUTHORIZATION' },
            availability: 'UNAVAILABLE',
            capabilityStatus: 'REQUIRES_PERMISSION',
            canSubmitJob: false,
            reason: 'Direct HLS playlist requires authentication or denied access.',
            supportedActions: ['upload_video'],
            metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
          };
        }
        if (!response.ok) {
          return {
            source,
            availability: 'UNKNOWN',
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            canSubmitJob: false,
            reason: `Direct HLS host returned HTTP ${response.status}.`,
            supportedActions: ['upload_video'],
            metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
          };
        }

        const ct = response.headers.get('content-type') ?? '';
        const text = (await response.text()).slice(0, 512_000);
        if (!text.includes('#EXTM3U') || (ct && !ALLOWED_HLS_CT_RE.test(ct))) {
          return {
            source,
            availability: 'UNAVAILABLE',
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            canSubmitJob: false,
            reason: 'Target URL did not return a valid HLS (#EXTM3U) media playlist.',
            supportedActions: ['upload_video'],
            metadata: { isLive: false },
          };
        }

        const isEndedVod = text.includes('#EXT-X-ENDLIST') || text.includes('#EXT-X-PLAYLIST-TYPE:VOD');
        const isLive = !isEndedVod;

        let durationSec: number | undefined;
        const extinfMatches = [...text.matchAll(/#EXTINF:([0-9]+(?:\.[0-9]+)?)/g)];
        if (extinfMatches.length > 0) {
          const sum = extinfMatches.reduce((acc, m) => acc + Number(m[1] || 0), 0);
          if (Number.isFinite(sum) && sum > 0) durationSec = Math.round(sum);
        }

        const canonicalId = (
          isLive ? `direct_media:broadcast:${source.externalId}` : `direct_media:vod:${source.externalId}`
        ) as CacheableSourceId;
        const updatedSource: UniversalMediaSource = {
          ...source,
          canonicalId,
          identityScope: isLive ? 'IMMUTABLE_BROADCAST' : 'IMMUTABLE_VOD',
          sourceType: isLive ? 'live' : 'vod',
          broadcastId: isLive ? source.externalId : undefined,
          availability: isLive ? 'LIVE_NOW' : 'AVAILABLE',
          acquisitionCapability: isRightsPermitted ? 'PERMITTED_DIRECT_URL' : 'UNSUPPORTED',
          rightsStatus: isRightsPermitted ? 'PERMITTED_PUBLIC' : 'UNKNOWN',
          metadata: {
            ...source.metadata,
            hasAudio: source.metadata?.hasAudio ?? true,
            title: titleFromUrlPath(finalUrl),
            durationSec: isLive ? undefined : durationSec,
            isLive,
          },
        };

        if (!isRightsPermitted) {
          return {
            source: updatedSource,
            availability: updatedSource.availability,
            capabilityStatus: 'REQUIRES_PERMISSION',
            canSubmitJob: false,
            reason:
              'Authorized direct HLS feed verified on allowlisted host, but copying/shared reuse rights are not yet granted for this source.',
            supportedActions: ['upload_video'],
            metadata: {
              title: titleFromUrlPath(finalUrl),
              durationSec: isLive ? undefined : durationSec,
              broadcastId: isLive ? source.externalId : undefined,
              isLive,
            },
          };
        }

        return {
          source: updatedSource,
          availability: updatedSource.availability,
          capabilityStatus: 'READY_TO_PROCESS',
          canSubmitJob: true,
          reason: isLive
            ? 'Authorized live HLS stream is live and ready for incremental highlight detection.'
            : 'Authorized recorded HLS media is verified and ready for highlight detection.',
          supportedActions: ['submit_job', 'create_project'],
          metadata: {
            title: titleFromUrlPath(finalUrl),
            durationSec: isLive ? undefined : durationSec,
            broadcastId: isLive ? source.externalId : undefined,
            isLive,
          },
          directMediaFinalUrl: finalUrl,
          directMediaIsLiveHls: isLive,
        };
      }

      // Finite direct media file (.mp4, .mov, .webm, .mkv) -> bounded HEAD check
      const { response, finalUrl } = await safeFetch(normalizedUrl, {
        method: 'HEAD',
        allowedHosts,
        timeoutMs: this.config.http?.timeoutMs ?? 8_000,
        maxRetries: 1,
        fetchImpl: this.config.http?.fetchImpl,
        dnsLookup: this.config.http?.dnsLookup,
        allowLocalhostForTest: this.config.http?.allowLocalhostForTest,
      });

      if (response.status === 404 || response.status === 410) {
        return {
          source: { ...source, availability: 'UNAVAILABLE' },
          availability: 'UNAVAILABLE',
          capabilityStatus: 'SOURCE_UNAVAILABLE',
          canSubmitJob: false,
          reason: 'Direct media file was not found (HTTP 404/410).',
          supportedActions: ['upload_video'],
          metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          source: { ...source, availability: 'UNAVAILABLE', rightsStatus: 'REQUIRES_AUTHORIZATION' },
          availability: 'UNAVAILABLE',
          capabilityStatus: 'REQUIRES_PERMISSION',
          canSubmitJob: false,
          reason: 'Direct media URL requires authentication or denied access.',
          supportedActions: ['upload_video'],
          metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
        };
      }
      if (!response.ok) {
        return {
          source,
          availability: 'UNKNOWN',
          capabilityStatus: 'SOURCE_UNAVAILABLE',
          canSubmitJob: false,
          reason: `Direct media host returned HTTP ${response.status}.`,
          supportedActions: ['upload_video'],
          metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
        };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !ALLOWED_VIDEO_CT_RE.test(contentType)) {
        return {
          source,
          availability: 'UNAVAILABLE',
          capabilityStatus: 'SOURCE_UNAVAILABLE',
          canSubmitJob: false,
          reason: `Unsupported media content-type "${contentType.split(';')[0]}". Expected video media.`,
          supportedActions: ['upload_video'],
          metadata: { isLive: false },
        };
      }

      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
      if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
        return {
          source,
          availability: 'AVAILABLE',
          capabilityStatus: 'UNSUPPORTED_ACQUISITION',
          canSubmitJob: false,
          reason: `Direct media file exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB free-beta highlight scan limit.`,
          supportedActions: ['upload_video'],
          metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
        };
      }

      const updatedSource: UniversalMediaSource = {
        ...source,
        availability: 'AVAILABLE',
        acquisitionCapability: isRightsPermitted ? 'PERMITTED_DIRECT_URL' : 'UNSUPPORTED',
        rightsStatus: isRightsPermitted ? 'PERMITTED_PUBLIC' : 'UNKNOWN',
        metadata: {
          ...source.metadata,
          hasAudio: source.metadata?.hasAudio ?? true,
          title: titleFromUrlPath(finalUrl),
          isLive: false,
        },
      };

      if (!isRightsPermitted) {
        return {
          source: updatedSource,
          availability: 'AVAILABLE',
          capabilityStatus: 'REQUIRES_PERMISSION',
          canSubmitJob: false,
          reason:
            'Media URL is reachable on an allowlisted host, but copying/shared reuse rights are not yet verified for this source.',
          supportedActions: ['upload_video'],
          metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
        };
      }

      return {
        source: updatedSource,
        availability: 'AVAILABLE',
        capabilityStatus: 'READY_TO_PROCESS',
        canSubmitJob: true,
        reason: 'Authorized direct media URL verified and ready for shared highlight detection.',
        supportedActions: ['submit_job', 'create_project'],
        metadata: { title: titleFromUrlPath(finalUrl), isLive: false },
        directMediaFinalUrl: finalUrl,
        directMediaIsLiveHls: false,
      };
    } catch (err) {
      if (err instanceof MediaSourceError && (err.code === 'SSRF_BLOCKED' || err.code === 'PRIVATE_NETWORK_BLOCKED')) {
        throw err;
      }
      return {
        source,
        availability: 'UNKNOWN',
        capabilityStatus: 'SOURCE_UNAVAILABLE',
        canSubmitJob: false,
        reason: err instanceof Error ? err.message : 'Unable to reach direct media host.',
        supportedActions: ['upload_video'],
        metadata: { isLive: false },
        providerNotice: {
          code: 'PROVIDER_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'Unable to inspect direct media URL.',
        },
      };
    }
  }
}
