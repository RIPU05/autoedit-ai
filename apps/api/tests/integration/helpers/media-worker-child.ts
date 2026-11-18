import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import type { MediaProcessJobPayload } from '@autoedit/contracts';
import {
  ControlledVodAcquisitionAdapter,
  registerControlledTestFixture,
} from '../../../src/media/index.js';
import { createMediaWorker } from '../../../src/queue/workers/media.worker.js';
import { bullConnection, connection as redis } from '../../../src/lib/redis.js';
import { createStorageProvider } from '../../../src/storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });

const RAW_LOCAL_DB_URL =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('autoedit_test')
    ? process.env.DATABASE_URL
    : 'postgresql://autoedit:autoedit_local_pass@127.0.0.1:5432/autoedit_local?schema=public';
const LOCAL_DB_URL = RAW_LOCAL_DB_URL.replace('@localhost:', '@127.0.0.1:');

const queueName = process.env.CHILD_QUEUE_NAME!;
const keyPrefix = process.env.CHILD_KEY_PREFIX!;
const fixtureKey = process.env.CHILD_FIXTURE_KEY!;
const vodId = process.env.CHILD_VOD_ID!;
const fixturePath = process.env.CHILD_FIXTURE_PATH!;
const workRootDir = process.env.CHILD_WORK_ROOT!;
const workerLabel = process.env.CHILD_WORKER_LABEL || `child_${process.pid}`;
const leaseMs = Number(process.env.CHILD_LEASE_MS || '2000');
const stallMs = Number(process.env.CHILD_STALL_MS || '0');

async function main() {
  const db = new PrismaClient({
    datasources: { db: { url: LOCAL_DB_URL } },
  });
  const storage = createStorageProvider({
    providerType: 'minio',
    bucket:
      process.env.S3_BUCKET && process.env.S3_BUCKET !== 'autoedit-test-bucket'
        ? process.env.S3_BUCKET
        : 'autoedit-local',
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_ID !== 'test-access-key'
        ? process.env.AWS_ACCESS_KEY_ID
        : 'minio_local_admin',
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY !== 'test-secret-key'
        ? process.env.AWS_SECRET_ACCESS_KEY
        : 'minio_local_secret_key',
    endpoint: process.env.S3_ENDPOINT || 'http://127.0.0.1:9002',
    forcePathStyle: true,
    presignTtlSec: 3600,
  });

  const adapter = new ControlledVodAcquisitionAdapter({
    enabled: true,
    archetype: 'youtube_video',
    vodId,
    fixturePath,
    title: 'Child OS Worker Recovery VOD',
  });
  const reg = adapter.buildMediaSourceRegistration();

  registerControlledTestFixture({
    kind: 'vod',
    fixtureKey,
    canonicalSourceId: reg.canonicalId,
    adapter,
    onWorkerAttempt: async () => {
      if (stallMs > 0) {
        process.stdout.write(
          `${JSON.stringify({ event: 'STALLING', workerLabel, pid: process.pid })}\n`,
        );
        await new Promise((r) => setTimeout(r, stallMs));
      }
    },
  });

  const recoveryQueue = new Queue<MediaProcessJobPayload>(queueName, {
    connection: bullConnection,
  });

  const handle = createMediaWorker({
    queueName,
    db,
    storage,
    redis: redis as any,
    bullConnection,
    workRootDir,
    keyPrefix,
    concurrency: 1,
    leaseMs,
    reconcileIntervalMs: 0,
    workerIdPrefix: workerLabel,
    enqueueRecoveryJob: async (payload, opts) => {
      const job = await recoveryQueue.add('process-media', payload, {
        jobId: opts.jobId,
        attempts: 3,
        backoff: { type: 'fixed', delay: 300 },
      });
      return { id: job.id };
    },
    onClaimed: (ctx) => {
      process.stdout.write(
        `${JSON.stringify({
          event: 'CLAIMED',
          workerLabel,
          pid: process.pid,
          generation: ctx.generation,
          ownerToken: ctx.ownerToken,
          sharedWorkKey: ctx.sharedWorkKey,
        })}\n`,
      );
    },
  });

  await handle.worker.waitUntilReady();
  process.stdout.write(
    `${JSON.stringify({ event: 'READY', workerLabel, pid: process.pid })}\n`,
  );

  const shutdown = async () => {
    await handle.worker.close().catch(() => {});
    await recoveryQueue.close().catch(() => {});
    await db.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Child worker error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
