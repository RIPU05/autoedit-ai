import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  putObject,
  presignDownload,
  startMultipart,
  presignUploadPart,
  completeMultipart,
  abortMultipart,
} from '../../src/lib/s3.js';

const MINIO_ENDPOINT = 'http://127.0.0.1:9002';
const BUCKET = 'autoedit-local';
const REGION = 'us-east-1';
const ACCESS_KEY_ID = 'minio_local_admin';
const SECRET_ACCESS_KEY = 'minio_local_secret_key';

// Test client connected directly to local MinIO
const minioClient = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: REGION,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('MinIO Local Storage Integration (Step 2B)', () => {
  let isMinioLive = false;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    try {
      const res = await fetch(`${MINIO_ENDPOINT}/minio/health/live`);
      isMinioLive = res.ok;
    } catch {
      isMinioLive = false;
    }
  });

  afterAll(async () => {
    if (!isMinioLive) return;
    for (const key of createdKeys) {
      try {
        await minioClient.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('verifies local MinIO is running and healthy on configured endpoint', async () => {
    if (!isMinioLive) {
      console.warn(`Skipping MinIO integration tests: ${MINIO_ENDPOINT} unreachable`);
      return;
    }
    expect(isMinioLive).toBe(true);
  });

  it('1 & 2. performs basic object upload and retrieval with SHA-256 verification', async () => {
    if (!isMinioLive) return;

    const key = `test-integration/${Date.now()}-basic.txt`;
    createdKeys.push(key);
    const content = Buffer.from('AutoAI Edit Step 2B — MinIO Direct Object Storage Verification', 'utf-8');
    const expectedHash = sha256(content);

    // 1. Upload
    await minioClient.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: content,
        ContentType: 'text/plain',
      }),
    );

    // 2. Retrieve
    const getRes = await minioClient.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const retrievedBytes = Buffer.from(await getRes.Body!.transformToByteArray());
    const retrievedHash = sha256(retrievedBytes);

    expect(retrievedBytes.toString('utf-8')).toBe(content.toString('utf-8'));
    expect(retrievedHash).toBe(expectedHash);
  });

  it('3. generates presigned GET URL and verifies download via standard HTTP fetch', async () => {
    if (!isMinioLive) return;

    const key = `test-integration/${Date.now()}-presigned-get.json`;
    createdKeys.push(key);
    const payload = JSON.stringify({ project: 'autoedit-local', step: '2B', timestamp: Date.now() });
    const content = Buffer.from(payload, 'utf-8');
    const expectedHash = sha256(content);

    await minioClient.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: content,
        ContentType: 'application/json',
      }),
    );

    // Generate Presigned GET URL
    const presignedGetUrl = await getSignedUrl(
      minioClient,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: 300 },
    );

    expect(presignedGetUrl).toContain('127.0.0.1:9002');
    expect(presignedGetUrl).toContain(`/${BUCKET}/`);

    // Fetch using standard HTTP client (simulating browser / external consumer)
    const httpRes = await fetch(presignedGetUrl);
    expect(httpRes.status).toBe(200);
    const arrayBuffer = await httpRes.arrayBuffer();
    const downloadedBuf = Buffer.from(arrayBuffer);
    expect(sha256(downloadedBuf)).toBe(expectedHash);
  });

  it('4-8. performs complete multipart upload lifecycle via presigned part PUT URLs', async () => {
    if (!isMinioLive) return;

    const key = `test-integration/${Date.now()}-multipart-video.mp4`;
    createdKeys.push(key);

    // S3 multipart requires parts 1..(N-1) to be >= 5 MiB (5,242,880 bytes).
    // Part 1: 5 MiB of repeating byte 0x41 ('A')
    const part1Size = 5 * 1024 * 1024;
    const part1Buf = Buffer.alloc(part1Size, 0x41);

    // Part 2 (final part): 256 KiB of repeating byte 0x42 ('B')
    const part2Size = 256 * 1024;
    const part2Buf = Buffer.alloc(part2Size, 0x42);

    const fullExpectedBuf = Buffer.concat([part1Buf, part2Buf]);
    const fullExpectedHash = sha256(fullExpectedBuf);

    // 4. Initiate multipart upload
    const startRes = await minioClient.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: 'video/mp4',
      }),
    );
    const uploadId = startRes.UploadId;
    expect(uploadId).toBeDefined();

    // 5. Generate presigned URLs for part 1 and part 2
    const part1Url = await getSignedUrl(
      minioClient,
      new UploadPartCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
      }),
      { expiresIn: 300 },
    );

    const part2Url = await getSignedUrl(
      minioClient,
      new UploadPartCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: 2,
      }),
      { expiresIn: 300 },
    );

    // 6. PUT parts using HTTP fetch and collect ETags (simulating direct browser chunk upload)
    const put1Res = await fetch(part1Url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: part1Buf,
    });
    expect(put1Res.status).toBe(200);
    const etag1 = put1Res.headers.get('etag');
    expect(etag1).toBeDefined();

    const put2Res = await fetch(part2Url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: part2Buf,
    });
    expect(put2Res.status).toBe(200);
    const etag2 = put2Res.headers.get('etag');
    expect(etag2).toBeDefined();

    // 7. Complete multipart upload
    const parts = [
      { PartNumber: 1, ETag: etag1! },
      { PartNumber: 2, ETag: etag2! },
    ];
    const completeRes = await minioClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    expect(completeRes.Key).toBe(key);

    // 8. Retrieve completed stitched object and verify length + SHA-256
    const headRes = await minioClient.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    expect(headRes.ContentLength).toBe(part1Size + part2Size);

    const getRes = await minioClient.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const assembledBytes = Buffer.from(await getRes.Body!.transformToByteArray());
    expect(assembledBytes.length).toBe(part1Size + part2Size);
    expect(sha256(assembledBytes)).toBe(fullExpectedHash);
  });

  it('9. initiates and aborts multipart upload, verifying cleanup', async () => {
    if (!isMinioLive) return;

    const key = `test-integration/${Date.now()}-aborted-multipart.bin`;
    const startRes = await minioClient.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: 'application/octet-stream',
      }),
    );
    const uploadId = startRes.UploadId;
    expect(uploadId).toBeDefined();

    // Abort
    const abortRes = await minioClient.send(
      new AbortMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
      }),
    );
    expect(abortRes).toBeDefined();

    // Ensure object was not created in bucket
    await expect(minioClient.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))).rejects.toThrow();
  });

  it('10. verifies error handling on non-existent key and unauthorized requests', async () => {
    if (!isMinioLive) return;

    // Non-existent key
    const missingKey = `test-integration/non-existent-${Date.now()}.bin`;
    await expect(
      minioClient.send(new GetObjectCommand({ Bucket: BUCKET, Key: missingKey })),
    ).rejects.toThrow();

    // Unauthorized client with invalid credentials
    const badClient = new S3Client({
      endpoint: MINIO_ENDPOINT,
      region: REGION,
      credentials: {
        accessKeyId: 'invalid-access-key',
        secretAccessKey: 'invalid-secret-key-12345',
      },
      forcePathStyle: true,
    });

    await expect(
      badClient.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'some-key' })),
    ).rejects.toThrow();
  });

  it('11. verifies s3.ts exported helpers work end-to-end against MinIO with client override', async () => {
    if (!isMinioLive) return;

    const key = `test-integration/${Date.now()}-helper-functions.txt`;
    createdKeys.push(key);
    const textData = Buffer.from('AutoEdit AI helpers test with local MinIO client', 'utf-8');

    // putObject helper
    const putRes = await putObject(key, textData, 'text/plain', minioClient, BUCKET);
    expect(putRes.key).toBe(key);
    expect(putRes.bucket).toBe(BUCKET);

    // presignDownload helper
    const downloadUrl = await presignDownload(key, minioClient, BUCKET);
    expect(downloadUrl).toContain('127.0.0.1:9002');
    const getRes = await fetch(downloadUrl);
    expect(getRes.status).toBe(200);
    const downloadedText = await getRes.text();
    expect(downloadedText).toBe('AutoEdit AI helpers test with local MinIO client');

    // startMultipart helper + abortMultipart helper
    const mpKey = `test-integration/${Date.now()}-helper-multipart.bin`;
    const startRes = await startMultipart(mpKey, 'application/octet-stream', minioClient, BUCKET);
    expect(startRes.uploadId).toBeDefined();

    const partUrl = await presignUploadPart(mpKey, startRes.uploadId, 1, minioClient, BUCKET);
    expect(partUrl).toContain('partNumber=1');

    const abortRes = await abortMultipart(mpKey, startRes.uploadId, minioClient, BUCKET);
    expect(abortRes).toBeDefined();
  });
});
