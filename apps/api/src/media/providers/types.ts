import type {
  ProviderNotice,
  SourceAvailability,
  SourceCapabilityStatus,
  UniversalMediaSource,
} from '@autoedit/contracts';
import type { DnsLookupFn } from '../safe-http.js';

export interface ProviderResolverHttpDeps {
  fetchImpl?: typeof fetch;
  dnsLookup?: DnsLookupFn;
  timeoutMs?: number;
  allowLocalhostForTest?: boolean;
}

export interface PlatformProviderConfig {
  youtubeApiKey?: string;
  /** Daily call budget for expensive YouTube search.list (100 units/call); defaults to 50. */
  youtubeDailySearchLimit?: number;
  /** Disable unauthenticated youtube.com/oembed fallback (useful in offline unit tests). */
  enableYoutubeOembedFallback?: boolean;
  twitchClientId?: string;
  twitchClientSecret?: string;
  kickClientId?: string;
  kickClientSecret?: string;
  directMediaAllowedHosts?: ReadonlySet<string>;
  directMediaPermittedPublicHosts?: ReadonlySet<string>;
  /** Max remote VOD file size in bytes; defaults to 500 MiB. */
  maxDirectMediaBytes?: number;
  http?: ProviderResolverHttpDeps;
}

export interface PlatformResolutionMetadata {
  title?: string;
  channelName?: string;
  durationSec?: number;
  thumbnailUrl?: string;
  broadcastId?: string;
  isLive?: boolean;
  isClip?: boolean;
  publishedAt?: string;
  platformClipSupported?: boolean;
}

export interface PlatformResolutionResult {
  source: UniversalMediaSource;
  availability: SourceAvailability;
  capabilityStatus: SourceCapabilityStatus;
  canSubmitJob: boolean;
  reason: string;
  supportedActions: string[];
  metadata: PlatformResolutionMetadata;
  providerNotice?: ProviderNotice;
  /** Set ONLY for authorized direct-media URLs ready for real non-fixture acquisition. */
  directMediaFinalUrl?: string;
  /** Indicates whether the direct-media feed is a live HLS stream (no #EXT-X-ENDLIST). */
  directMediaIsLiveHls?: boolean;
}

/**
 * Parses ISO-8601 duration strings returned by YouTube Data API v3 (e.g. `PT1H23M45S`, `PT42S`, `P0D`).
 */
export function parseIso8601DurationSec(raw?: string | null): number | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const match = raw.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const mins = Number(match[3] ?? 0);
  const secs = Number(match[4] ?? 0);
  const total = days * 86400 + hours * 3600 + mins * 60 + secs;
  return Number.isFinite(total) && total > 0 ? Math.round(total) : undefined;
}

/**
 * Parses Twitch Helix VOD duration strings (e.g. `3h8m33s`, `12m4s`, `45s`).
 */
export function parseTwitchDurationSec(raw?: string | null): number | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
  const total =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/**
 * Sanitizes an external thumbnail URL so only safe https:// URLs are surfaced to the browser.
 */
export function sanitizeThumbnailUrl(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/%\{width\}|\{width\}/gi, '640')
    .replace(/%\{height\}|\{height\}/gi, '360')
    .trim();
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // ignore malformed thumbnail URL
  }
  return undefined;
}

export function parseCsvHostSet(raw?: string): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const cleaned = part.trim().toLowerCase().replace(/\.$/, '');
    if (cleaned) out.add(cleaned);
  }
  return out;
}
