import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { MediaSourceError } from './errors.js';
import {
  assertSafeRedirectTarget,
  assertSafeResolvedIp,
  parseAndValidateSafeUrl,
  type UrlSafetyOptions,
} from './url-safety.js';

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Per-attempt network timeout in ms; defaults to 8_000. */
  timeoutMs?: number;
  /** Maximum redirect hops followed with full SSRF + DNS re-validation; defaults to 4. */
  maxRedirects?: number;
  /** Optional allowlist of permitted hostnames (checked on initial URL AND every redirect hop). */
  allowedHosts?: ReadonlySet<string>;
  /** Maximum retries on transient 5xx/network errors; defaults to 1 (2 total attempts). */
  maxRetries?: number;
  /** URL safety flags (https-only by default). */
  urlSafety?: UrlSafetyOptions;
  /** Injectable DNS resolver for deterministic DNS-rebinding tests. */
  dnsLookup?: DnsLookupFn;
  /** Injectable fetch implementation for deterministic recorded-fixture tests. */
  fetchImpl?: typeof fetch;
  /** AbortSignal propagated from caller/worker. */
  signal?: AbortSignal;
  /**
   * Strictly non-production test escape hatch allowing loopback HTTP test servers
   * while still enforcing all redirect, scheme, and header safety checks.
   */
  allowLocalhostForTest?: boolean;
}

export class ProviderRateLimitError extends MediaSourceError {
  readonly retryAfterSec?: number;

  constructor(message: string, retryAfterSec?: number) {
    super({
      code: 'MAX_RETRIES_EXCEEDED',
      message,
      statusCode: 429,
      retryable: true,
    });
    this.retryAfterSec = retryAfterSec;
  }
}

export function parseRetryAfterSec(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const asNum = Number(retryAfter);
    if (Number.isFinite(asNum) && asNum > 0) return Math.ceil(asNum);
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
      const diff = Math.ceil((asDate - Date.now()) / 1000);
      if (diff > 0) return diff;
    }
  }
  const rlReset = headers.get('ratelimit-reset');
  if (rlReset) {
    const epochSec = Number(rlReset);
    if (Number.isFinite(epochSec) && epochSec > 0) {
      const diff = Math.ceil(epochSec - Date.now() / 1000);
      if (diff > 0) return Math.min(3600, diff);
    }
  }
  return undefined;
}

const defaultDnsLookup: DnsLookupFn = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family }));
};

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Resolves DNS for a target hostname and validates EVERY returned IPv4/IPv6 record
 * against private, loopback, link-local, CGNAT, and cloud metadata ranges to defend
 * against DNS rebinding and internal network probing.
 */
export async function validateOutboundTarget(
  rawUrl: string,
  opts: {
    allowedHosts?: ReadonlySet<string>;
    urlSafety?: UrlSafetyOptions;
    dnsLookup?: DnsLookupFn;
    allowLocalhostForTest?: boolean;
  } = {},
): Promise<URL> {
  const allowLocalTest =
    Boolean(opts.allowLocalhostForTest) && process.env.NODE_ENV !== 'production';

  if (allowLocalTest) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new MediaSourceError({ code: 'MALFORMED_URL', message: 'Malformed media source URL.' });
    }
    const proto = parsed.protocol.toLowerCase();
    if (proto !== 'http:' && proto !== 'https:') {
      throw new MediaSourceError({
        code: 'UNSUPPORTED_SCHEME',
        message: `Unsupported URL scheme "${proto}".`,
      });
    }
    if (parsed.username || parsed.password) {
      throw new MediaSourceError({
        code: 'SSRF_BLOCKED',
        message: 'URLs containing embedded user credentials are not allowed.',
      });
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (opts.allowedHosts && opts.allowedHosts.size > 0 && !opts.allowedHosts.has(host)) {
      throw new MediaSourceError({
        code: 'SSRF_BLOCKED',
        message: `Target host "${host}" is not in the permitted host list.`,
      });
    }
    return parsed;
  }

  const parsed = parseAndValidateSafeUrl(rawUrl, opts.urlSafety);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');

  if (opts.allowedHosts && opts.allowedHosts.size > 0 && !opts.allowedHosts.has(host)) {
    throw new MediaSourceError({
      code: 'SSRF_BLOCKED',
      message: `Target host "${host}" is not in the permitted host list.`,
    });
  }

  // Resolve DNS and assert EVERY A/AAAA record is a safe public IP (blocks DNS rebinding!)
  if (isIP(host) === 0) {
    const lookupFn = opts.dnsLookup ?? defaultDnsLookup;
    let records: Array<{ address: string; family: number }>;
    try {
      records = await lookupFn(host);
    } catch (err) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `Unable to resolve host "${host}".`,
        retryable: true,
        cause: err,
      });
    }
    if (!records || records.length === 0) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `DNS returned no records for host "${host}".`,
      });
    }
    for (const rec of records) {
      assertSafeResolvedIp(rec.address);
    }
  }

  return parsed;
}

/**
 * Hardened outbound HTTP client for provider metadata APIs and authorized direct-media fetches.
 *
 * Security guarantees:
 * - Enforces HTTPS (unless explicitly overridden in non-production tests).
 * - Blocks raw IP literals, localhost, private RFC1918/RFC6598/IPv6 ranges, and cloud metadata.
 * - Validates DNS resolution against private-IP rebinding BEFORE sending any request.
 * - Follows redirects manually with full URL + host-allowlist + DNS re-validation on every hop.
 * - Enforces bounded timeouts, bounded retries on transient 5xx/network errors, and surfaces
 *   provider rate limits (`429`) cleanly without retrying aggressively.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<{
  response: Response;
  finalUrl: string;
  redirectCount: number;
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxRedirects = opts.maxRedirects ?? 4;
  const maxRetries = opts.maxRetries ?? 1;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Outbound request cancelled.' });
    }

    let currentUrl = rawUrl;
    let redirectCount = 0;

    try {
      while (true) {
        const validated = await validateOutboundTarget(currentUrl, {
          allowedHosts: opts.allowedHosts,
          urlSafety: opts.urlSafety,
          dnsLookup: opts.dnsLookup,
          allowLocalhostForTest: opts.allowLocalhostForTest,
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onCallerAbort = () => controller.abort();
        opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

        let res: Response;
        try {
          res = await fetchImpl(validated.toString(), {
            method: opts.method ?? 'GET',
            headers: opts.headers,
            body: opts.body,
            redirect: 'manual',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onCallerAbort);
        }

        if (isRedirectStatus(res.status)) {
          const location = res.headers.get('location');
          if (!location) {
            throw new MediaSourceError({
              code: 'SOURCE_UNAVAILABLE',
              message: 'Redirect response missing Location header.',
            });
          }
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new MediaSourceError({
              code: 'SSRF_BLOCKED',
              message: `Exceeded maximum allowed redirects (${maxRedirects}).`,
            });
          }
          const resolvedNext = new URL(location, validated.toString()).toString();
          if (!opts.allowLocalhostForTest || process.env.NODE_ENV === 'production') {
            assertSafeRedirectTarget(resolvedNext, opts.allowedHosts, opts.urlSafety);
          }
          currentUrl = resolvedNext;
          continue;
        }

        if (res.status === 429) {
          const retryAfterSec = parseRetryAfterSec(res.headers);
          throw new ProviderRateLimitError(
            retryAfterSec
              ? `Provider API rate limit reached. Retry after ${retryAfterSec}s.`
              : 'Provider API rate limit reached. Please retry shortly.',
            retryAfterSec,
          );
        }

        if (res.status >= 500 && attempt < maxRetries) {
          lastErr = new MediaSourceError({
            code: 'SOURCE_UNAVAILABLE',
            message: `Provider returned HTTP ${res.status}.`,
            statusCode: 502,
            retryable: true,
          });
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          break;
        }

        return { response: res, finalUrl: validated.toString(), redirectCount };
      }
    } catch (err) {
      // Never retry deterministic SSRF, DNS-rebinding, rate-limit, or cancellation errors!
      if (
        err instanceof ProviderRateLimitError ||
        (err instanceof MediaSourceError && !err.retryable)
      ) {
        throw err;
      }
      if (opts.signal?.aborted) {
        throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Outbound request cancelled.' });
      }
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      if (err instanceof MediaSourceError) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new MediaSourceError({
        code: isAbort ? 'COORDINATION_TIMEOUT' : 'SOURCE_UNAVAILABLE',
        message: isAbort
          ? `Outbound provider request timed out after ${timeoutMs}ms.`
          : 'Provider or media host could not be reached.',
        retryable: true,
        cause: err,
      });
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new MediaSourceError({ code: 'SOURCE_UNAVAILABLE', message: 'Outbound request failed.' });
}
