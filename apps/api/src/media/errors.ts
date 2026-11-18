import type { MediaSourceErrorCode } from '@autoedit/contracts';

export class MediaSourceError extends Error {
  readonly code: MediaSourceErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(opts: {
    code: MediaSourceErrorCode;
    message: string;
    retryable?: boolean;
    statusCode?: number;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'MediaSourceError';
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.statusCode = opts.statusCode ?? defaultStatusForCode(opts.code);
    if (opts.cause) this.cause = opts.cause;
  }
}

function defaultStatusForCode(code: MediaSourceErrorCode): number {
  switch (code) {
    case 'MALFORMED_URL':
    case 'UNSUPPORTED_SCHEME':
    case 'UNSUPPORTED_PROVIDER':
      return 400;
    case 'ACCESS_DENIED':
    case 'RIGHTS_UNVERIFIED':
    case 'DRM_RESTRICTED':
    case 'SSRF_BLOCKED':
    case 'PRIVATE_NETWORK_BLOCKED':
      return 403;
    case 'SOURCE_UNAVAILABLE':
      return 404;
    case 'COORDINATION_CONFLICT':
    case 'INVALID_STATE_TRANSITION':
    case 'BROADCAST_UNRESOLVED':
    case 'LEASE_EXPIRED':
      return 409;
    case 'REQUEST_CANCELLED':
      return 499;
    case 'ARTIFACT_CORRUPT':
      return 502;
    case 'MAX_RETRIES_EXCEEDED':
      return 503;
    case 'COORDINATION_TIMEOUT':
      return 504;
    case 'UNSUPPORTED_ACQUISITION':
      return 422;
    default:
      return 400;
  }
}
