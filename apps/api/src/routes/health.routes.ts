import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { connection } from '../lib/redis.js';
import { s3 } from '../lib/s3.js';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { analysisQueue, renderQueue, n8nQueue } from '../queue/queues.js';
import { env } from '../config/env.js';

export const healthRouter = Router();

type Check = { ok: boolean; ms: number; detail?: string };

async function timed(fn: () => Promise<unknown>): Promise<Check> {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: (e as Error).message };
  }
}

const checkRedis = () => timed(() => connection.ping());
const checkDb = () => timed(() => prisma.$queryRaw`SELECT 1`);
const checkS3 = () => timed(() => s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET })));
const checkClaude = () =>
  timed(async () => {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`claude ${res.status}`);
  });
const checkOllama = () =>
  timed(async () => {
    const res = await fetch(`${env.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/tags`);
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { models?: { name?: string }[] };
    if (!data.models?.some((model) => model.name === env.OLLAMA_MODEL)) {
      throw new Error(`ollama model missing: ${env.OLLAMA_MODEL}`);
    }
  });
const checkQueue = () =>
  timed(async () => {
    const counts = await Promise.all([
      analysisQueue.getJobCounts('waiting', 'active', 'failed'),
      renderQueue.getJobCounts('waiting', 'active', 'failed'),
      n8nQueue.getJobCounts('waiting', 'active', 'failed'),
    ]);
    return counts;
  });

healthRouter.get('/redis', async (_q, res) => res.json(await checkRedis()));
healthRouter.get('/db', async (_q, res) => res.json(await checkDb()));
healthRouter.get('/s3', async (_q, res) => res.json(await checkS3()));
healthRouter.get('/claude', async (_q, res) => res.json(await checkClaude()));
healthRouter.get('/ollama', async (_q, res) => res.json(await checkOllama()));
healthRouter.get('/queue', async (_q, res) => res.json(await checkQueue()));

// aggregate — returns 200 only if every dependency is healthy
healthRouter.get('/', async (_q, res) => {
  const [redis, db, s3c, claude, ollama, queue] = await Promise.all([
    checkRedis(),
    checkDb(),
    checkS3(),
    checkClaude(),
    checkOllama(),
    checkQueue(),
  ]);
  const ai = env.AI_PROVIDER === 'ollama' ? ollama : env.AI_PROVIDER === 'claude' ? claude : { ok: true, ms: 0 };
  const ok = redis.ok && db.ok && s3c.ok && ai.ok && queue.ok;
  res.status(ok ? 200 : 503).json({ ok, redis, db, s3: s3c, claude, ollama, queue });
});
