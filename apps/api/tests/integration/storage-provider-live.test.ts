import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  createStorageProvider,
  type MediaStorageProvider,
} from '../../src/storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const MINIO_ENDPOINT = process.env.S3_ENDPOINT || 'http://127.0.0.1:9002';
const BUCKET = (process.env.S3_BUCKET && process.env.S3_BUCKET !== 'autoedit-test-bucket') ? process.env.S3_BUCKET : 'autoedit-local';
const ACCESS_KEY_ID = (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_ID !== 'test-access-key') ? process.env.AWS_ACCESS_KEY_ID : 'minio_local_admin';
const SECRET_ACCESS_KEY = (process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY !== 'test-secret-key') ? process.env.AWS_SECRET_ACCESS_KEY : 'minio_local_secret_key';
const REGION = process.env.AWS_REGION || 'us-east-1';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('Storage Provider Live MinIO Integration (Step 3B.1)', () => {
  let provider: MediaStorageProvider;
  let isMinioLive = false;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    try {
      const res = await fetch(`${MINIO_ENDPOINT}/minio/health/live`);
      isMinioLive = res.ok;
    } catch {
      isMinioLive = false;
    }

    provider = createStorageProvider({
      providerType: 'minio',
      bucket: BUCKET,
      region: REGION,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      endpoint: MINIO_ENDPOINT,
      forcePathStyle: true,
      presignTtlSec: 3600,
    });
  });

  afterAll(async () => {
    if (!isMinioLive) return;
    for (const key of createdKeys) {
      try {
        await provider.deleteObject({ key });
      } catch {
        // ignore cleanup errors in tests
      }
    }
  });

  it('1. verifies real local MinIO health check succeeds via provider.checkHealth()', async () => {
    if (!isMinioLive) return;

    const health = await provider.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe('minio');
    expect(health.bucket).toBe(BUCKET);
    expect(health.ms).toBeGreaterThanOrEqual(0);
  });

  it('2. performs direct object upload and retrieval with SHA-256 byte verification', async () => {
    if (!isMinioLive) return;

    const key = `test-provider-live/${Date.now()}-basic.txt`;
    createdKeys.push(key);
    const content = Buffer.from('AutoAI Edit Step 3B.1 — Storage Provider MinIO Live Verification', 'utf-8');
    const expectedHash = sha256(content);

    // 1. Put Object
    const putRes = await provider.putObject({
      key,
      body: content,
      contentType: 'text/plain',
      metadata: { 'test-meta': 'step3b1' },
    });
    expect(putRes.key).toBe(key);
    expect(putRes.bucket).toBe(BUCKET);
    expect(putRes.etag).toBeDefined();

    // 2. Get Object
    const getRes = await provider.getObject({ key });
    expect(getRes.contentType).toContain('text/plain');

    const chunks: Buffer[] = [];
    for await (const chunk of getRes.body as any) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const retrievedBytes = Buffer.concat(chunks);
    expect(sha256(retrievedBytes)).toBe(expectedHash);
    expect(retrievedBytes.toString('utf-8')).toBe(content.toString('utf-8'));
  });

  it('3. retrieves object metadata (HEAD) accurately', async () => {
    if (!isMinioLive) return;

    const key = `test-provider-live/${Date.now()}-meta.bin`;
    createdKeys.push(key);
    const content = Buffer.alloc(4096, 0x42);

    await provider.putObject({
      key,
      body: content,
      contentType: 'application/octet-stream',
    });

    const meta = await provider.getObjectMetadata({ key });
    expect(meta.contentLength).toBe(4096);
    expect(meta.contentType).toBe('application/octet-stream');
    expect(meta.etag).toBeDefined();
    expect(meta.lastModified).toBeInstanceOf(Date);
  });

  it('4. generates valid presigned download URL and retrieves exact object bytes', async () => {
    if (!isMinioLive) return;

    const key = `test-provider-live/${Date.now()}-download.txt`;
    createdKeys.push(key);
    const content = Buffer.from('Presigned download URL verification content', 'utf-8');

    await provider.putObject({
      key,
      body: content,
      contentType: 'text/plain',
    });

    const downloadUrl = await provider.createDownloadUrl({ key, expiresIn: 300 });
    expect(downloadUrl).toContain(MINIO_ENDPOINT);
    expect(downloadUrl).toContain(key);

    const res = await fetch(downloadUrl);
    expect(res.ok).toBe(true);
    const downloadedText = await res.text();
    expect(downloadedText).toBe(content.toString('utf-8'));
  });

  it('5. executes full multipart upload lifecycle via presigned part PUT URLs', async () => {
    if (!isMinioLive) return;

    const key = `test-provider-live/${Date.now()}-multipart.bin`;
    createdKeys.push(key);

    // MinIO default minimum part size is 5MB for non-final parts
    const partSize = 5 * 1024 * 1024;
    const part1 = Buffer.alloc(partSize, 0xaa);
    const part2 = Buffer.alloc(1024 * 512, 0xbb); // 512KB final part
    const fullContent = Buffer.concat([part1, part2]);
    const expectedHash = sha256(fullContent);

    // Step A: Initiate multipart upload
    const startRes = await provider.startMultipartUpload({
      key,
      contentType: 'application/octet-stream',
    });
    expect(startRes.uploadId).toBeDefined();
    expect(startRes.key).toBe(key);
    const uploadId = startRes.uploadId;

    // Step B: Presign parts and upload directly via HTTP PUT
    const part1Url = await provider.presignUploadPart({
      key,
      uploadId,
      partNumber: 1,
    });
    const putRes1 = await fetch(part1Url, {
      method: 'PUT',
      body: part1,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(putRes1.ok).toBe(true);
    const etag1 = putRes1.headers.get('etag');
    expect(etag1).toBeDefined();

    const part2Url = await provider.presignUploadPart({
      key,
      uploadId,
      partNumber: 2,
    });
    const putRes2 = await fetch(part2Url, {
      method: 'PUT',
      body: part2,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(putRes2.ok).toBe(true);
    const etag2 = putRes2.headers.get('etag');
    expect(etag2).toBeDefined();

    // Step C: Complete multipart upload
    const completeRes = await provider.completeMultipartUpload({
      key,
      uploadId,
      parts: [
        { PartNumber: 1, ETag: etag1! },
        { PartNumber: 2, ETag: etag2! },
      ],
    });
    expect(completeRes.key).toBe(key);
    expect(completeRes.bucket).toBe(BUCKET);
    expect(completeRes.etag).toBeDefined();

    // Step D: Verify stitched file integrity via download
    const downloadUrl = await provider.createDownloadUrl({ key });
    const dlRes = await fetch(downloadUrl);
    expect(dlRes.ok).toBe(true);
    const downloadedBuf = Buffer.from(await dlRes.arrayBuffer());
    expect(downloadedBuf.length).toBe(fullContent.length);
    expect(sha256(downloadedBuf)).toBe(expectedHash);
  });

  it('6. safely aborts multipart upload and cleans up in-progress parts', async () => {
    if (!isMinioLive) return;

    const key = `test-provider-live/${Date.now()}-aborted.bin`;
    createdKeys.push(key);

    const startRes = await provider.startMultipartUpload({
      key,
      contentType: 'application/octet-stream',
    });
    const uploadId = startRes.uploadId;

    // Upload one part
    const partUrl = await provider.presignUploadPart({
      key,
      uploadId,
      partNumber: 1,
    });
    const putRes = await fetch(partUrl, {
      method: 'PUT',
      body: Buffer.alloc(1024 * 1024, 0x11),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(putRes.ok).toBe(true);

    // Abort
    const abortRes = await provider.abortMultipartUpload({ key, uploadId });
    expect(abortRes.success).toBe(true);
    expect(abortRes.uploadId).toBe(uploadId);

    // Attempting to complete aborted upload must fail
    await expect(
      provider.completeMultipartUpload({
        key,
        uploadId,
        parts: [{ PartNumber: 1, ETag: putRes.headers.get('etag') || '"dummy"' }],
      }),
    ).rejects.toThrow();
  });

  it('7. deletes object and subsequent getObject fails closed', async () => {
    if (!isMinioLive) return;

    const key = `test-provider-live/${Date.now()}-delete-me.txt`;
    await provider.putObject({
      key,
      body: Buffer.from('disposable content'),
      contentType: 'text/plain',
    });

    const delRes = await provider.deleteObject({ key });
    expect(delRes.success).toBe(true);
    expect(delRes.key).toBe(key);

    await expect(provider.getObject({ key })).rejects.toThrow();
  });
});
