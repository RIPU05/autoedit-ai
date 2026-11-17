import { env } from '../config/env.js';
import type {
  MediaStorageProvider,
  StorageConfig,
  StorageProviderType,
} from './storage.types.js';
import { S3StorageProvider } from './s3-storage.provider.js';

const VALID_PROVIDERS: readonly StorageProviderType[] = ['s3', 'minio', 'r2', 'custom-s3'];

/**
 * Resolves the final StorageConfig following documented precedence:
 *   1. Explicit function overrides (e.g. In unit tests or specific callers)
 *   2. Runtime environment variables (process.env)
 *   3. Validated application configuration (env.ts defaults)
 */
export function resolveStorageConfig(overrides?: Partial<StorageConfig>): StorageConfig {
  const envEndpoint =
    process.env.S3_ENDPOINT !== undefined
      ? process.env.S3_ENDPOINT.trim() || undefined
      : env.S3_ENDPOINT;
  const endpoint = overrides?.endpoint !== undefined ? overrides.endpoint : envEndpoint;

  // 1. Determine and validate raw provider type
  const rawProvider = (
    overrides?.providerType ??
    (process.env.STORAGE_PROVIDER ? process.env.STORAGE_PROVIDER.trim() : undefined) ??
    env.STORAGE_PROVIDER
  ) as string;

  if (rawProvider && !VALID_PROVIDERS.includes(rawProvider as StorageProviderType)) {
    throw new Error(
      `Invalid storage provider type "${rawProvider}". Supported types are: ${VALID_PROVIDERS.join(', ')}`,
    );
  }

  let providerType: StorageProviderType = (rawProvider as StorageProviderType) || 's3';

  // If provider was not explicitly configured (or was default 's3') and endpoint is provided,
  // infer appropriate provider target without solely relying on fragile substring matching.
  const hasExplicitNonDefaultProvider =
    overrides?.providerType !== undefined ||
    (process.env.STORAGE_PROVIDER !== undefined &&
      process.env.STORAGE_PROVIDER.trim().length > 0 &&
      process.env.STORAGE_PROVIDER.trim() !== 's3') ||
    env.STORAGE_PROVIDER !== 's3';

  if (!hasExplicitNonDefaultProvider && endpoint) {
    if (endpoint.includes('r2.cloudflarestorage.com')) {
      providerType = 'r2';
    } else if (
      endpoint.includes('127.0.0.1') ||
      endpoint.includes('localhost') ||
      endpoint.includes('minio')
    ) {
      providerType = 'minio';
    } else {
      providerType = 'custom-s3';
    }
  }

  // 2. Validate provider-specific required parameters
  if (providerType === 'r2' && !endpoint) {
    throw new Error('Cloudflare R2 storage provider requires S3_ENDPOINT to be configured.');
  }
  if (providerType === 'custom-s3' && !endpoint) {
    throw new Error('custom-s3 storage provider requires S3_ENDPOINT to be configured.');
  }

  // 3. Resolve bucket, region, credentials
  const bucket = (overrides?.bucket ?? process.env.S3_BUCKET ?? env.S3_BUCKET)?.trim();
  if (!bucket) {
    throw new Error('Storage configuration requires a non-empty bucket name.');
  }

  let region = overrides?.region ?? process.env.AWS_REGION ?? env.AWS_REGION;
  if (providerType === 'r2' && (!region || region === 'us-east-1')) {
    region = 'auto';
  }

  const accessKeyId = (
    overrides?.accessKeyId ??
    process.env.AWS_ACCESS_KEY_ID ??
    env.AWS_ACCESS_KEY_ID
  )?.trim();
  const secretAccessKey = (
    overrides?.secretAccessKey ??
    process.env.AWS_SECRET_ACCESS_KEY ??
    env.AWS_SECRET_ACCESS_KEY
  )?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Storage configuration requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY credentials.',
    );
  }

  // 4. ForcePathStyle determination
  let forcePathStyle = overrides?.forcePathStyle;
  if (forcePathStyle === undefined && process.env.S3_FORCE_PATH_STYLE !== undefined) {
    const rawFps = process.env.S3_FORCE_PATH_STYLE.trim().toLowerCase();
    forcePathStyle = rawFps.length > 0 ? rawFps === 'true' || rawFps === '1' : undefined;
  } else if (forcePathStyle === undefined && env.S3_FORCE_PATH_STYLE !== undefined) {
    forcePathStyle = env.S3_FORCE_PATH_STYLE;
  }

  if (forcePathStyle === undefined) {
    if (providerType === 'minio') {
      forcePathStyle = true;
    } else if (providerType === 'r2') {
      forcePathStyle = false;
    } else if (endpoint && (endpoint.includes('127.0.0.1') || endpoint.includes('localhost'))) {
      forcePathStyle = true;
    } else {
      forcePathStyle = false;
    }
  }

  // 5. Presign TTL with safe bounded range (60s to 7 days / 604800s)
  const rawTtl =
    overrides?.presignTtlSec ??
    (process.env.S3_PRESIGN_TTL ? Number(process.env.S3_PRESIGN_TTL) : env.S3_PRESIGN_TTL);
  const numTtl = Number(rawTtl);
  const presignTtlSec = Number.isFinite(numTtl)
    ? Math.min(Math.max(Math.round(numTtl), 60), 604800)
    : 3600;

  return {
    providerType,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint,
    forcePathStyle,
    presignTtlSec,
  };
}

export function createStorageProvider(configOverrides?: Partial<StorageConfig>): MediaStorageProvider {
  const config = resolveStorageConfig(configOverrides);

  switch (config.providerType) {
    case 's3':
    case 'minio':
    case 'r2':
    case 'custom-s3':
      return new S3StorageProvider(config);
    default:
      throw new Error(`Unsupported storage provider type: ${config.providerType}`);
  }
}

let defaultProviderInstance: MediaStorageProvider | null = null;

export function getStorageProvider(): MediaStorageProvider {
  if (!defaultProviderInstance) {
    defaultProviderInstance = createStorageProvider();
  }
  return defaultProviderInstance;
}

export function setStorageProvider(provider: MediaStorageProvider | null): void {
  defaultProviderInstance = provider;
}
