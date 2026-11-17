import { isIP } from 'node:net';
import { MediaSourceError } from './errors.js';

export interface UrlSafetyOptions {
  /** Allow plain http: ONLY for controlled test environments; defaults to false (https only). */
  allowHttp?: boolean;
  /** Maximum URL character length; defaults to 2048. */
  maxLength?: number;
}

const CLOUD_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

const PRIVATE_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.localdomain',
];

/**
 * Checks whether an IPv4 dotted-quad string falls inside a loopback, private,
 * link-local (cloud metadata), CGNAT, or reserved/non-public range.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;

  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC1918 private)
  if (a === 10) return true;
  // 100.64.0.0/10 (RFC6598 CGNAT / Alibaba metadata 100.100.100.200)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local & AWS/GCP/Azure metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918 private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24, 192.0.2.0/24 (IETF / TEST-NET-1)
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16 (RFC1918 private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4+ (multicast, reserved, broadcast)
  if (a >= 224) return true;

  return false;
}

/**
 * Checks whether an IPv6 address (brackets stripped) is loopback, unspecified,
 * unique-local, link-local, or IPv4-mapped private.
 */
export function isPrivateOrReservedIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip === '::' || ip === '::1') return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  // Unique local fc00::/7 (includes AWS IMDSv2 fd00:ec2::254)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  // IPv4-mapped ::ffff:a.b.c.d or ::ffff:xxxx:xxxx
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (isIP(mapped) === 4) {
      return isPrivateOrReservedIpv4(mapped);
    }
    return true;
  }
  return false;
}

/**
 * Validates a resolved IP address (e.g. after DNS lookup) before making any outbound connection.
 */
export function assertSafeResolvedIp(ip: string): void {
  const cleaned = ip.replace(/^\[|\]$/g, '');
  const version = isIP(cleaned);
  if (version === 4) {
    if (isPrivateOrReservedIpv4(cleaned)) {
      throw new MediaSourceError({
        code: 'PRIVATE_NETWORK_BLOCKED',
        message: 'Resolved IPv4 address is in a private, loopback, or metadata network range.',
      });
    }
    return;
  }
  if (version === 6) {
    if (isPrivateOrReservedIpv6(cleaned)) {
      throw new MediaSourceError({
        code: 'PRIVATE_NETWORK_BLOCKED',
        message: 'Resolved IPv6 address is in a private, loopback, or metadata network range.',
      });
    }
    return;
  }
  throw new MediaSourceError({
    code: 'SSRF_BLOCKED',
    message: 'Invalid resolved IP address.',
  });
}

function isObfuscatedNumericHost(hostname: string): boolean {
  // Single integer IPv4 (e.g. 2130706433) or hex (0x7f000001)
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(hostname)) return true;
  // Octal/hex dotted segments (e.g. 0177.0.0.1, 0x7f.0.0.1)
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+)){1,3}$/i.test(hostname)) {
    return true;
  }
  return false;
}

/**
 * Parses and validates a user-supplied URL against SSRF, unsafe schemes,
 * embedded credentials, loopback/private IPs, and cloud metadata endpoints.
 */
export function parseAndValidateSafeUrl(rawUrl: string, opts: UrlSafetyOptions = {}): URL {
  const maxLength = opts.maxLength ?? 2048;
  if (typeof rawUrl !== 'string') {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'Media source URL must be a string.',
    });
  }

  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: trimmed ? `URL exceeds maximum allowed length (${maxLength}).` : 'URL cannot be empty.',
    });
  }

  // Reject control characters or whitespace inside URLs
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'URL contains invalid control or whitespace characters.',
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'Malformed media source URL.',
      cause: err,
    });
  }

  const protocol = parsed.protocol.toLowerCase();
  const allowedProtocols = opts.allowHttp ? new Set(['https:', 'http:']) : new Set(['https:']);
  if (!allowedProtocols.has(protocol)) {
    throw new MediaSourceError({
      code: 'UNSUPPORTED_SCHEME',
      message: `Unsupported URL scheme "${protocol}". Only HTTPS URLs are permitted.`,
    });
  }

  // Never allow credentials embedded in URLs (prevents credential leakage and host confusion)
  if (parsed.username || parsed.password) {
    throw new MediaSourceError({
      code: 'SSRF_BLOCKED',
      message: 'URLs containing embedded user credentials are not allowed.',
    });
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: 'URL is missing a valid hostname.',
    });
  }

  // Block cloud metadata endpoints explicitly
  if (CLOUD_METADATA_HOSTS.has(hostname) || CLOUD_METADATA_HOSTS.has(hostname.replace(/^\[|\]$/g, ''))) {
    throw new MediaSourceError({
      code: 'SSRF_BLOCKED',
      message: 'Access to cloud metadata hostnames is strictly prohibited.',
    });
  }

  // Block localhost and internal network domain suffixes
  if (
    hostname === 'localhost' ||
    PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new MediaSourceError({
      code: 'PRIVATE_NETWORK_BLOCKED',
      message: 'Access to localhost or internal network domains is prohibited.',
    });
  }

  // Block raw IPv4 / IPv6 literals on private ranges (and block raw IP literals in general for SSRF safety)
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(bareHost);
  if (ipVersion === 4) {
    throw new MediaSourceError({
      code: isPrivateOrReservedIpv4(bareHost) ? 'PRIVATE_NETWORK_BLOCKED' : 'SSRF_BLOCKED',
      message: 'Direct IPv4 literal URLs are blocked for SSRF protection.',
    });
  }
  if (ipVersion === 6) {
    throw new MediaSourceError({
      code: isPrivateOrReservedIpv6(bareHost) ? 'PRIVATE_NETWORK_BLOCKED' : 'SSRF_BLOCKED',
      message: 'Direct IPv6 literal URLs are blocked for SSRF protection.',
    });
  }

  if (isObfuscatedNumericHost(bareHost)) {
    throw new MediaSourceError({
      code: 'SSRF_BLOCKED',
      message: 'Obfuscated numeric IP hostnames are blocked for SSRF protection.',
    });
  }

  return parsed;
}

/**
 * Validates redirect hops so an approved external URL cannot bounce into
 * a private network, loopback, metadata endpoint, or disallowed host.
 */
export function assertSafeRedirectTarget(
  targetUrl: string,
  allowedHosts?: ReadonlySet<string>,
  opts?: UrlSafetyOptions,
): URL {
  const parsed = parseAndValidateSafeUrl(targetUrl, opts);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(host)) {
    throw new MediaSourceError({
      code: 'SSRF_BLOCKED',
      message: `Redirect target host "${host}" is not in the permitted host list.`,
    });
  }
  return parsed;
}
