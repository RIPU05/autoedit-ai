import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  S3StorageProvider,
  createStorageProvider,
  resolveStorageConfig,
  getStorageProvider,
  setStorageProvider,
  type StorageConfig,
  type MediaStorageProvider,
} from '../../src/storage/index.js';
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { verifyKeyOwnership } from '../../src/routes/upload.routes.js';
import * as legacyS3 from '../../src/lib/s3.js';

describe('Storage Provider Abstraction & Migration Unit Tests (Step 3B.2)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    setStorageProvider(null);
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test-access-key-id',
      AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
      S3_BUCKET: 'test-storage-bucket',
      S3_PRESIGN_TTL: '3600',
    };
    process.env.S3_ENDPOINT = '';
    process.env.S3_FORCE_PATH_STYLE = '';
    process.env.STORAGE_PROVIDER = '';
  });

  afterEach(() => {
    process.env = originalEnv;
    setStorageProvider(null);
  });

  describe('Storage Configuration and Provider Resolution Precedence', () => {
    it('resolves AWS S3 default configuration when no custom endpoint is provided', () => {
      const config = resolveStorageConfig();

      expect(config.providerType).toBe('s3');
      expect(config.region).toBe('us-east-1');
      expect(config.bucket).toBe('test-storage-bucket');
      expect(config.accessKeyId).toBe('test-access-key-id');
      expect(config.secretAccessKey).toBe('test-secret-access-key');
      expect(config.endpoint).toBeUndefined();
      expect(config.forcePathStyle).toBe(false);
      expect(config.presignTtlSec).toBe(3600);
    });

    it('auto-detects minio provider and enables forcePathStyle when S3_ENDPOINT is set to local address', () => {
      process.env.S3_ENDPOINT = 'http://127.0.0.1:9002';
      const config = resolveStorageConfig();

      expect(config.providerType).toBe('minio');
      expect(config.endpoint).toBe('http://127.0.0.1:9002');
      expect(config.forcePathStyle).toBe(true);
    });

    it('auto-detects r2 provider when endpoint contains r2.cloudflarestorage.com', () => {
      process.env.S3_ENDPOINT = 'https://my-account-id.r2.cloudflarestorage.com';
      const config = resolveStorageConfig();

      expect(config.providerType).toBe('r2');
      expect(config.endpoint).toBe('https://my-account-id.r2.cloudflarestorage.com');
      expect(config.region).toBe('auto');
      expect(config.forcePathStyle).toBe(false);
    });

    it('respects explicit STORAGE_PROVIDER override over auto-detection', () => {
      process.env.STORAGE_PROVIDER = 'custom-s3';
      process.env.S3_ENDPOINT = 'http://127.0.0.1:9002';
      const config = resolveStorageConfig();

      expect(config.providerType).toBe('custom-s3');
      expect(config.endpoint).toBe('http://127.0.0.1:9002');
    });

    it('fails explicitly for unsupported provider type', () => {
      expect(() => {
        resolveStorageConfig({ providerType: 'azure-blob' as any });
      }).toThrow(/Invalid storage provider type "azure-blob"/);
    });

    it('fails explicitly when Cloudflare R2 is configured without an endpoint', () => {
      expect(() => {
        resolveStorageConfig({ providerType: 'r2', endpoint: undefined });
      }).toThrow(/Cloudflare R2 storage provider requires S3_ENDPOINT/);
    });

    it('fails explicitly when custom-s3 is configured without an endpoint', () => {
      expect(() => {
        resolveStorageConfig({ providerType: 'custom-s3', endpoint: undefined });
      }).toThrow(/custom-s3 storage provider requires S3_ENDPOINT/);
    });

    it('clamps presignTtlSec within safe bounds (60s minimum, 7 days maximum)', () => {
      // Lower bound clamp (e.g. 10s -> 60s)
      const low = resolveStorageConfig({ presignTtlSec: 10 });
      expect(low.presignTtlSec).toBe(60);

      // Upper bound clamp (e.g. 1,000,000s -> 604,800s)
      const high = resolveStorageConfig({ presignTtlSec: 1_000_000 });
      expect(high.presignTtlSec).toBe(604800);

      // Invalid NaN -> fallback to default 3600
      const nan = resolveStorageConfig({ presignTtlSec: NaN as any });
      expect(nan.presignTtlSec).toBe(3600);
    });

    it('createStorageProvider creates an S3StorageProvider with correct providerType and bucket', () => {
      const provider = createStorageProvider({
        providerType: 'minio',
        bucket: 'custom-bucket',
        endpoint: 'http://localhost:9002',
      });

      expect(provider).toBeInstanceOf(S3StorageProvider);
      expect(provider.providerType).toBe('minio');
      expect(provider.defaultBucket).toBe('custom-bucket');
    });

    it('getStorageProvider returns cached singleton and setStorageProvider allows testing override', () => {
      const p1 = getStorageProvider();
      const p2 = getStorageProvider();
      expect(p1).toBe(p2);

      const mockProvider: any = { providerType: 'custom-s3', defaultBucket: 'mock' };
      setStorageProvider(mockProvider);
      expect(getStorageProvider()).toBe(mockProvider);
    });
  });

  describe('Bucket and Object-Key Security Validation (verifyKeyOwnership)', () => {
    it('accepts valid authorized user key with sources/ prefix', () => {
      expect(() => {
        verifyKeyOwnership('sources/user_123/session_abc/video.mp4', 'user_123');
      }).not.toThrow();
    });

    it('rejects keys without sources/ prefix with 403 Forbidden', () => {
      expect(() => {
        verifyKeyOwnership('renders/user_123/video.mp4', 'user_123');
      }).toThrow(/must be within sources\/ prefix/);
    });

    it('rejects keys belonging to another user with 403 Forbidden', () => {
      expect(() => {
        verifyKeyOwnership('sources/victim_user/session_abc/video.mp4', 'attacker_user');
      }).toThrow(/does not belong to user/);
    });

    it('rejects directory traversal attempts with 403 Forbidden', () => {
      expect(() => {
        verifyKeyOwnership('sources/user_123/../../other/secret.mp4', 'user_123');
      }).toThrow(/invalid or escaping s3 key sequence/);
    });

    it('rejects backslash path escaping attempts with 403 Forbidden', () => {
      expect(() => {
        verifyKeyOwnership('sources\\user_123\\video.mp4', 'user_123');
      }).toThrow(/invalid or escaping s3 key sequence/);
    });

    it('rejects leading slashes and double slashes with 403 Forbidden', () => {
      expect(() => {
        verifyKeyOwnership('/sources/user_123/video.mp4', 'user_123');
      }).toThrow(/invalid or escaping s3 key sequence/);

      expect(() => {
        verifyKeyOwnership('sources//user_123/video.mp4', 'user_123');
      }).toThrow(/invalid or escaping s3 key sequence/);
    });

    it('rejects keys with missing or extra segments (unsupported structure)', () => {
      expect(() => {
        verifyKeyOwnership('sources/user_123/video.mp4', 'user_123');
      }).toThrow(/unsupported key structure/);

      expect(() => {
        verifyKeyOwnership('sources/user_123/session_abc/nested/video.mp4', 'user_123');
      }).toThrow(/unsupported key structure/);
    });

    it('rejects URL-encoded traversal or path ambiguities', () => {
      expect(() => {
        verifyKeyOwnership('sources/user_123/%2e%2e/video.mp4', 'user_123');
      }).toThrow(/invalid or escaping s3 key sequence/);

      expect(() => {
        verifyKeyOwnership('sources/user_123/session_abc/vid%2f.mp4', 'user_123');
      }).toThrow(/invalid or escaping s3 key sequence/);
    });

    it('rejects invalid upload session namespace and invalid filenames', () => {
      expect(() => {
        verifyKeyOwnership('sources/user_123/session@bad$/video.mp4', 'user_123');
      }).toThrow(/invalid upload session namespace/);

      expect(() => {
        verifyKeyOwnership('sources/user_123/session_abc/bad*name.mp4', 'user_123');
      }).toThrow(/invalid filename/);
    });
  });

  describe('Backward Compatibility Facade (apps/api/src/lib/s3.ts)', () => {
    let mockProvider: MediaStorageProvider;

    beforeEach(() => {
      mockProvider = {
        providerType: 's3',
        bucket: 'facade-test-bucket',
        putObject: vi.fn(async (input) => ({ key: input.key, bucket: input.bucket || 'facade-test-bucket' })),
        getObject: vi.fn(async () => ({ body: Buffer.from('facade-bytes'), contentType: 'text/plain' })),
        getObjectMetadata: vi.fn(async () => ({ contentLength: 100, contentType: 'text/plain' })),
        deleteObject: vi.fn(async (input) => ({ success: true, key: input.key, bucket: 'facade-test-bucket' })),
        startMultipartUpload: vi.fn(async (input) => ({ uploadId: 'facade-up-1', key: input.key, bucket: 'facade-test-bucket' })),
        presignUploadPart: vi.fn(async () => 'https://facade.test/part-1'),
        completeMultipartUpload: vi.fn(async (input) => ({ key: input.key, bucket: 'facade-test-bucket', etag: '"facade-etag"' })),
        abortMultipartUpload: vi.fn(async (input) => ({ success: true, key: input.key, uploadId: input.uploadId })),
        createDownloadUrl: vi.fn(async (input) => `https://facade.test/download/${input.key}`),
        checkHealth: vi.fn(async () => ({ ok: true, provider: 's3', bucket: 'facade-test-bucket', ms: 2 })),
      };
      setStorageProvider(mockProvider);
    });

    it('startMultipart delegates to getStorageProvider().startMultipartUpload', async () => {
      const res = await legacyS3.startMultipart('sources/u1/v.mp4', 'video/mp4');
      expect(mockProvider.startMultipartUpload).toHaveBeenCalledWith({
        key: 'sources/u1/v.mp4',
        contentType: 'video/mp4',
        bucket: expect.any(String),
      });
      expect(res.uploadId).toBe('facade-up-1');
    });

    it('presignUploadPart delegates to getStorageProvider().presignUploadPart', async () => {
      const url = await legacyS3.presignUploadPart('sources/u1/v.mp4', 'up-1', 1);
      expect(mockProvider.presignUploadPart).toHaveBeenCalledWith({
        key: 'sources/u1/v.mp4',
        uploadId: 'up-1',
        partNumber: 1,
        bucket: expect.any(String),
      });
      expect(url).toBe('https://facade.test/part-1');
    });

    it('completeMultipart delegates to getStorageProvider().completeMultipartUpload', async () => {
      const parts = [{ PartNumber: 1, ETag: '"e1"' }];
      const res = await legacyS3.completeMultipart('sources/u1/v.mp4', 'up-1', parts);
      expect(mockProvider.completeMultipartUpload).toHaveBeenCalledWith({
        key: 'sources/u1/v.mp4',
        uploadId: 'up-1',
        parts,
        bucket: expect.any(String),
      });
      expect(res).toBeDefined();
    });

    it('abortMultipart delegates to getStorageProvider().abortMultipartUpload', async () => {
      const res = await legacyS3.abortMultipart('sources/u1/v.mp4', 'up-1');
      expect(mockProvider.abortMultipartUpload).toHaveBeenCalledWith({
        key: 'sources/u1/v.mp4',
        uploadId: 'up-1',
        bucket: expect.any(String),
      });
      expect(res.success).toBe(true);
    });

    it('putObject delegates to getStorageProvider().putObject', async () => {
      const res = await legacyS3.putObject('renders/out.mp4', Buffer.from('data'), 'video/mp4');
      expect(mockProvider.putObject).toHaveBeenCalledWith({
        key: 'renders/out.mp4',
        body: expect.any(Buffer),
        contentType: 'video/mp4',
        bucket: expect.any(String),
      });
      expect(res.key).toBe('renders/out.mp4');
    });

    it('presignDownload delegates to getStorageProvider().createDownloadUrl', async () => {
      const url = await legacyS3.presignDownload('sources/u1/v.mp4');
      expect(mockProvider.createDownloadUrl).toHaveBeenCalledWith({
        key: 'sources/u1/v.mp4',
        bucket: expect.any(String),
      });
      expect(url).toBe('https://facade.test/download/sources/u1/v.mp4');
    });
  });

  describe('S3StorageProvider Operations with Mocked S3Client', () => {
    let mockSend: any;
    let mockClient: any;
    let provider: S3StorageProvider;
    const testConfig: StorageConfig = {
      providerType: 's3',
      bucket: 'autoedit-test-bucket',
      region: 'us-east-1',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    };

    beforeEach(() => {
      mockSend = vi.fn();
      mockClient = { send: mockSend };
      provider = new S3StorageProvider(testConfig, mockClient as any);
    });

    it('putObject sends PutObjectCommand with correct bucket, key, and metadata', async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"abc-123"' });

      const res = await provider.putObject({
        key: 'sources/u1/test.mp4',
        body: Buffer.from('video data'),
        contentType: 'video/mp4',
        metadata: { userId: 'u1' },
      });

      expect(res.key).toBe('sources/u1/test.mp4');
      expect(res.bucket).toBe('autoedit-test-bucket');
      expect(res.etag).toBe('"abc-123"');

      expect(mockSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
      const cmd = mockSend.mock.calls[0][0] as PutObjectCommand;
      expect(cmd.input.Bucket).toBe('autoedit-test-bucket');
      expect(cmd.input.Key).toBe('sources/u1/test.mp4');
      expect(cmd.input.ContentType).toBe('video/mp4');
      expect(cmd.input.Metadata).toEqual({ userId: 'u1' });
    });

    it('getObject sends GetObjectCommand and returns stream with headers', async () => {
      const fakeStream = {} as any;
      mockSend.mockResolvedValueOnce({
        Body: fakeStream,
        ContentType: 'video/mp4',
        ContentLength: 1024,
        ETag: '"etag-999"',
        LastModified: new Date('2026-11-17T00:00:00Z'),
      });

      const res = await provider.getObject({ key: 'renders/proj_1/reel.mp4' });

      expect(res.body).toBe(fakeStream);
      expect(res.contentType).toBe('video/mp4');
      expect(res.contentLength).toBe(1024);
      expect(res.etag).toBe('"etag-999"');
      expect(res.lastModified).toEqual(new Date('2026-11-17T00:00:00Z'));
      expect(mockSend).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    });

    it('getObjectMetadata sends HeadObjectCommand and returns metadata', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 2048,
        ContentType: 'audio/wav',
        ETag: '"etag-wav"',
        LastModified: new Date('2026-11-17T01:00:00Z'),
        Metadata: { durationSec: '12' },
      });

      const meta = await provider.getObjectMetadata({ key: 'audio/track.wav' });

      expect(meta.contentLength).toBe(2048);
      expect(meta.contentType).toBe('audio/wav');
      expect(meta.metadata).toEqual({ durationSec: '12' });
      expect(mockSend).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
    });

    it('deleteObject sends DeleteObjectCommand and returns success', async () => {
      mockSend.mockResolvedValueOnce({});

      const res = await provider.deleteObject({ key: 'sources/u1/scratch.tmp' });

      expect(res.key).toBe('sources/u1/scratch.tmp');
      expect(res.bucket).toBe('autoedit-test-bucket');
      expect(res.success).toBe(true);
      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('startMultipartUpload sends CreateMultipartUploadCommand', async () => {
      mockSend.mockResolvedValueOnce({ UploadId: 'upload-sess-123' });

      const res = await provider.startMultipartUpload({
        key: 'sources/u1/raw.mp4',
        contentType: 'video/mp4',
      });

      expect(res.uploadId).toBe('upload-sess-123');
      expect(res.key).toBe('sources/u1/raw.mp4');
      expect(res.bucket).toBe('autoedit-test-bucket');
      expect(mockSend).toHaveBeenCalledWith(expect.any(CreateMultipartUploadCommand));
    });

    it('completeMultipartUpload sorts parts by PartNumber and completes upload', async () => {
      mockSend.mockResolvedValueOnce({ Location: 'https://s3/raw.mp4', ETag: '"final-etag"' });

      const unsortedParts = [
        { PartNumber: 3, ETag: '"etag-3"' },
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
      ];

      const res = await provider.completeMultipartUpload({
        key: 'sources/u1/raw.mp4',
        uploadId: 'upload-sess-123',
        parts: unsortedParts,
      });

      expect(res.location).toBe('https://s3/raw.mp4');
      expect(res.etag).toBe('"final-etag"');

      const cmd = mockSend.mock.calls[0][0] as CompleteMultipartUploadCommand;
      expect(cmd.input.MultipartUpload?.Parts).toEqual([
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
        { PartNumber: 3, ETag: '"etag-3"' },
      ]);
    });

    it('abortMultipartUpload sends AbortMultipartUploadCommand and returns success', async () => {
      mockSend.mockResolvedValueOnce({});

      const res = await provider.abortMultipartUpload({
        key: 'sources/u1/raw.mp4',
        uploadId: 'upload-sess-123',
      });

      expect(res.uploadId).toBe('upload-sess-123');
      expect(res.success).toBe(true);
      expect(mockSend).toHaveBeenCalledWith(expect.any(AbortMultipartUploadCommand));
    });

    it('checkHealth reports ok: true when HeadBucketCommand succeeds', async () => {
      mockSend.mockResolvedValueOnce({});

      const health = await provider.checkHealth();

      expect(health.ok).toBe(true);
      expect(health.provider).toBe('s3');
      expect(health.bucket).toBe('autoedit-test-bucket');
      expect(health.ms).toBeGreaterThanOrEqual(0);
      expect(mockSend).toHaveBeenCalledWith(expect.any(HeadBucketCommand));
    });

    it('checkHealth reports ok: false with error message when HeadBucketCommand fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('BucketDoesNotExist'));

      const health = await provider.checkHealth();

      expect(health.ok).toBe(false);
      expect(health.error).toContain('BucketDoesNotExist');
      expect(health.provider).toBe('s3');
    });

    it('propagates errors when object operations fail', async () => {
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

      await expect(provider.getObject({ key: 'secret/file.txt' })).rejects.toThrow('AccessDenied');
    });
  });
});
