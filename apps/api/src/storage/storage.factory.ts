import { env } from '../config/env.js';
import type {
  MediaStorageProvider,
  StorageConfig,
  StorageProviderType,
} from './storage.types.js';
import { S3StorageProvider } from './s3-storage.provider.js';

export function resolveStorageConfig(overrides?: Partial<StorageConfig>): StorageConfig {
  const envEndpoint = process.env.S3_ENDPOINT !== undefined ? (process.env.S3_ENDPOINT.trim() || undefined) : env.S3_ENDPOINT;
  const endpoint = overrides?.endpoint !== undefined ? overrides.endpoint : envEndpoint;

  const rawProvider = (overrides?.providerType ??
    (process.env.STORAGE_PROVIDER ? (process.env.STORAGE_PROVIDER.trim() as StorageProviderType) : undefined) ??
    env.STORAGE_PROVIDER) as StorageProviderType;
  let providerType: StorageProviderType = rawProvider || 's3';

  if (!overrides?.providerType && !process.env.STORAGE_PROVIDER && endpoint) {
    if (endpoint.includes('r2.cloudflarestorage.com')) {
      providerType = 'r2';
    } else {
      providerType = 'minio';
    }
  }

  const bucket = overrides?.bucket ?? process.env.S3_BUCKET ?? env.S3_BUCKET;
  const region = overrides?.region ?? process.env.AWS_REGION ?? env.AWS_REGION;
  const accessKeyId = overrides?.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    overrides?.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;

  let forcePathStyle = overrides?.forcePathStyle;
  if (forcePathStyle === undefined && process.env.S3_FORCE_PATH_STYLE !== undefined) {
    const rawFps = process.env.S3_FORCE_PATH_STYLE.trim().toLowerCase();
    forcePathStyle = rawFps.length > 0 ? rawFps === 'true' || rawFps === '1' : undefined;
  } else if (forcePathStyle === undefined && env.S3_FORCE_PATH_STYLE !== undefined) {
    forcePathStyle = env.S3_FORCE_PATH_STYLE;
  }

  if (forcePathStyle === undefined && endpoint) {
    forcePathStyle = true;
  }

  const presignTtlSec =
    overrides?.presignTtlSec ??
    (process.env.S3_PRESIGN_TTL ? Number(process.env.S3_PRESIGN_TTL) : env.S3_PRESIGN_TTL);

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
