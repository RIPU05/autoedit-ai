import 'dotenv/config';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import Redis from 'ioredis';

type Check = {
  name: string;
  ok: boolean;
  detail?: string;
};

const required = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'INTEGRATION_ENCRYPTION_SECRET',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_BUCKET',
  'AI_PROVIDER',
  'WHISPER_URL',
  'RENDER_WORK_DIR',
] as const;

function maskUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    if (url.username) url.username = '***';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function runCheck(name: string, fn: () => Promise<string | void>): Promise<Check> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const checks: Check[] = [];

  checks.push({
    name: 'required env vars',
    ok: required.every((key) => Boolean(process.env[key])),
    detail: required.filter((key) => !process.env[key]).join(', ') || 'present',
  });

  checks.push({
    name: 'AI_PROVIDER fallback',
    ok: process.env.AI_PROVIDER === 'fallback',
    detail: `AI_PROVIDER=${process.env.AI_PROVIDER ?? '<missing>'}`,
  });

  checks.push({
    name: 'Anthropic key not required',
    ok: process.env.AI_PROVIDER === 'fallback',
    detail: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY is set but unused in fallback mode' : 'not set',
  });

  checks.push(
    await runCheck('Redis ping', async () => {
      if (!process.env.REDIS_URL) throw new Error('REDIS_URL missing');
      const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 10_000 });
      try {
        const pong = await redis.ping();
        return `pong=${pong}; url=${maskUrl(process.env.REDIS_URL)}`;
      } finally {
        redis.disconnect();
      }
    }),
  );

  checks.push(
    await runCheck('S3 bucket reachable', async () => {
      const region = process.env.AWS_REGION;
      const bucket = process.env.S3_BUCKET;
      if (!region) throw new Error('AWS_REGION missing');
      if (!bucket) throw new Error('S3_BUCKET missing');
      const s3 = new S3Client({
        region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
        },
      });
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return `bucket=${bucket}; region=${region}`;
    }),
  );

  checks.push(
    await runCheck('local Whisper health', async () => {
      const base = process.env.WHISPER_URL;
      if (!base) throw new Error('WHISPER_URL missing');
      const res = await fetch(`${base.replace(/\/$/, '')}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return base;
    }),
  );

  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
  }

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
