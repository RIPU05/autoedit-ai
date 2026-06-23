import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../src/lib/prisma.js';
import { s3 } from '../src/lib/s3.js';
import { env } from '../src/config/env.js';

type UploadPartResult = {
  ETag: string;
  PartNumber: number;
};

type CaseResult = {
  name: string;
  ok: boolean;
  sizeBytes: number;
  partCount: number;
  ms: number;
  retryCount: number;
  projectId?: string;
  key?: string;
  uploadId?: string;
  failure?: {
    step: string;
    status?: number;
    message: string;
    s3Code?: string;
    partNumber?: number;
    etagPresent?: boolean;
    classification: string;
  };
};

const API_BASE = process.env.S3_RELIABILITY_API_BASE ?? env.API_BASE_URL;
const SMALL_UPLOADS = Number(process.env.S3_RELIABILITY_SMALL ?? 25);
const MEDIUM_UPLOADS = Number(process.env.S3_RELIABILITY_MEDIUM ?? 10);
const MULTIPART_UPLOADS = Number(process.env.S3_RELIABILITY_MULTIPART ?? 3);
const REQUEST_DELAY_MS = Number(process.env.S3_RELIABILITY_REQUEST_DELAY_MS ?? 3_250);
const REQUEST_TIMEOUT_MS = Number(process.env.S3_RELIABILITY_REQUEST_TIMEOUT_MS ?? 180_000);
const UPLOAD_PART_ATTEMPTS = Number(process.env.S3_RELIABILITY_UPLOAD_PART_ATTEMPTS ?? 3);
const PASSWORD = `Reliability-${randomUUID()}!`;

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function sizeFromArg(name: string, fallback: number) {
  const raw = argValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --${name} value`);
  return parsed;
}

const SMALL_SIZE = sizeFromArg('small-size', 256 * 1024);
const MEDIUM_SIZE = sizeFromArg('medium-size', 6 * 1024 * 1024);
const MULTIPART_SIZE = sizeFromArg('multipart-size', 13 * 1024 * 1024);
const PART_SIZE = sizeFromArg('part-size', 6 * 1024 * 1024);

async function delay(ms: number) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(path: string, init: RequestInit = {}) {
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(message), { step: path, ms: Date.now() - start });
  }
  const text = await res.text();
  const body = text ? tryJson(text) : undefined;
  if (!res.ok) {
    const message = typeof body?.error === 'string' ? body.error : text || `request failed: ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status, step: path, ms: Date.now() - start });
  }
  return body as T;
}

function tryJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function classifyFailure(step: string, status: number | undefined, message: string) {
  if (status === 429) return 'API 429: upload rate limit too strict for this request pace';
  if (status === 403 || /SignatureDoesNotMatch|AccessDenied/i.test(message)) return 'S3 auth/signing/region/clock issue';
  if (/NoSuchBucket/i.test(message)) return 'S3 bucket/env mismatch';
  if (/InvalidPartOrder/i.test(message)) return 'S3 complete payload part ordering issue';
  if (/InvalidPart/i.test(message)) return 'S3 complete payload ETag/part mismatch';
  if (/ETag/i.test(message)) return 'S3 CORS/header issue: ETag missing or unreadable';
  if (status && status >= 500) return 'transient API/S3/server failure';
  if (/timed out|aborted|ECONNRESET|network|fetch failed/i.test(message)) return 'transient cloud/network issue';
  return `${step} failure`;
}

function errorInfo(err: unknown, step: string, partNumber?: number, etagPresent?: boolean): CaseResult['failure'] {
  const e = err as Error & { status?: number; Code?: string; code?: string };
  const message = e instanceof Error ? e.message : String(err);
  return {
    step,
    status: e.status,
    message,
    s3Code: e.Code ?? e.code,
    partNumber,
    etagPresent,
    classification: classifyFailure(step, e.status, message),
  };
}

async function putPart(url: string, body: Buffer, partNumber: number) {
  let lastError: unknown;
  let retries = 0;
  for (let attempt = 1; attempt <= UPLOAD_PART_ATTEMPTS; attempt += 1) {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: 'PUT',
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'content-type': 'application/octet-stream' },
      });
      const etag = res.headers.get('ETag');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(text || `S3 PUT failed: ${res.status}`), {
          status: res.status,
        });
      }
      if (!etag) throw new Error('No ETag returned from S3 PUT');
      return { etag, retries };
    } catch (err) {
      lastError = err;
      if (attempt < UPLOAD_PART_ATTEMPTS) await delay(attempt * 1_000);
      else {
        const message = err instanceof Error ? err.message : String(err);
        throw Object.assign(new Error(message), {
          status: (err as { status?: number }).status,
          step: 's3-put',
          ms: Date.now() - start,
        });
      }
      retries += 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('S3 PUT failed');
}

async function runCase(
  name: string,
  token: string,
  sizeBytes: number,
  partSize: number,
  etagMode: 'raw' | 'unquoted',
): Promise<CaseResult> {
  const startedAt = Date.now();
  let projectId: string | undefined;
  let key: string | undefined;
  let uploadId: string | undefined;
  const parts: UploadPartResult[] = [];
  let retryCount = 0;

  try {
    const start = await api<{ projectId: string; key: string; uploadId: string }>('/api/upload/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filename: `${name}-${randomUUID()}.bin`,
        contentType: 'application/octet-stream',
        title: `S3 reliability ${name}`,
      }),
    });
    projectId = start.projectId;
    key = start.key;
    uploadId = start.uploadId;

    const partCount = Math.ceil(sizeBytes / partSize);
    for (let index = 0; index < partCount; index += 1) {
      await delay(REQUEST_DELAY_MS);
      const partNumber = index + 1;
      const offset = index * partSize;
      const bytes = Math.min(partSize, sizeBytes - offset);
      const body = randomBytes(bytes);
      const part = await api<{ url: string }>('/api/upload/part', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ key, uploadId, partNumber }),
      });
      const { etag: rawEtag, retries } = await putPart(part.url, body, partNumber);
      retryCount += retries;
      parts.push({
        ETag: etagMode === 'unquoted' ? rawEtag.replaceAll('"', '') : rawEtag,
        PartNumber: partNumber,
      });
    }

    await delay(REQUEST_DELAY_MS);
    await api<{ projectId: string; assetId: string; analysisJobId: string }>('/api/upload/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId,
        key,
        uploadId,
        contentType: 'application/octet-stream',
        sizeBytes,
        parts: [...parts].reverse(),
      }),
    });

    return { name, ok: true, sizeBytes, partCount, ms: Date.now() - startedAt, retryCount, projectId, key, uploadId };
  } catch (err) {
    const latestPart = parts.at(-1);
    return {
      name,
      ok: false,
      sizeBytes,
      partCount: Math.ceil(sizeBytes / partSize),
      ms: Date.now() - startedAt,
      retryCount,
      projectId,
      key,
      uploadId,
      failure: errorInfo(err, (err as { step?: string }).step ?? 'unknown', latestPart?.PartNumber, Boolean(latestPart?.ETag)),
    };
  }
}

async function cleanup(email: string, keys: string[]) {
  for (const key of keys) {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key })).catch(() => undefined);
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return;
  await prisma.project.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await prisma.asset.deleteMany({ where: { s3Key: { in: keys } } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
}

async function main() {
  const email = `s3-reliability-${randomUUID()}@example.com`;
  const registered = await api<{ token: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD, name: 'S3 Reliability' }),
  });
  const token = registered.token;
  const results: CaseResult[] = [];
  const uploadedKeys: string[] = [];

  const matrix: Array<{ prefix: string; count: number; size: number; partSize: number; etagMode: 'raw' | 'unquoted' }> = [
    { prefix: 'small-raw-etag', count: SMALL_UPLOADS, size: SMALL_SIZE, partSize: PART_SIZE, etagMode: 'raw' },
    { prefix: 'medium-raw-etag', count: MEDIUM_UPLOADS, size: MEDIUM_SIZE, partSize: PART_SIZE, etagMode: 'raw' },
    { prefix: 'multipart-raw-etag', count: MULTIPART_UPLOADS, size: MULTIPART_SIZE, partSize: PART_SIZE, etagMode: 'raw' },
    { prefix: 'etag-without-quotes-check', count: 1, size: SMALL_SIZE, partSize: PART_SIZE, etagMode: 'unquoted' },
  ];

  for (const group of matrix) {
    for (let i = 0; i < group.count; i += 1) {
      const result = await runCase(`${group.prefix}-${i + 1}`, token, group.size, group.partSize, group.etagMode);
      results.push(result);
      if (result.key) uploadedKeys.push(result.key);
      console.log(JSON.stringify(result));
      await delay(REQUEST_DELAY_MS);
    }
  }

  await cleanup(email, uploadedKeys);
  await prisma.$disconnect();

  const failures = results.filter((result) => !result.ok);
  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        total: results.length,
        passed: results.length - failures.length,
        failed: failures.length,
        retries: results.reduce((sum, result) => sum + result.retryCount, 0),
        failures: failures.map((failure) => ({
          name: failure.name,
          step: failure.failure?.step,
          status: failure.failure?.status,
          s3Code: failure.failure?.s3Code,
          partNumber: failure.failure?.partNumber,
          etagPresent: failure.failure?.etagPresent,
          classification: failure.failure?.classification,
        })),
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
