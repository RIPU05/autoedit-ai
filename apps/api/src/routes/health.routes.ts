import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { connection } from '../lib/redis.js';
import { getStorageProvider } from '../storage/index.js';
import * as queues from '../queue/queues.js';
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

async function safeWorkerCount(queue: { getWorkers?: () => Promise<unknown[]> } | undefined): Promise<number | null> {
  if (!queue || typeof queue.getWorkers !== 'function') return null;
  try {
    const workers = await Promise.race([
      queue.getWorkers(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('worker check timed out')), 2_000)),
    ]);
    return Array.isArray(workers) ? workers.length : 0;
  } catch {
    return null;
  }
}

export async function inspectWorkerHealth() {
  const [analysis, render, mediaProcess, privateRender] = await Promise.all([
    safeWorkerCount(queues.analysisQueue as any),
    safeWorkerCount(queues.renderQueue as any),
    safeWorkerCount((queues as any).mediaProcessQueue),
    safeWorkerCount((queues as any).privateRenderQueue),
  ]);
  const knownCounts = [analysis, render, mediaProcess, privateRender].filter((n): n is number => typeof n === 'number');
  const total = knownCounts.reduce((acc, n) => acc + n, 0);
  const online = knownCounts.length === 0 ? null : (analysis ?? 0) > 0 && (render ?? 0) > 0;
  return {
    online,
    total,
    analysis,
    render,
    mediaProcess,
    privateRender,
  };
}

const checkRedis = () => timed(() => connection.ping());
const checkDb = () => timed(() => prisma.$queryRaw`SELECT 1`);
const checkS3 = async (): Promise<Check> => {
  try {
    const res = await getStorageProvider().checkHealth();
    return { ok: res.ok, ms: res.ms, detail: res.detail };
  } catch (err) {
    return { ok: false, ms: 0, detail: err instanceof Error ? err.message : String(err) };
  }
};
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
const checkQueue = async (): Promise<Check> => {
  const t0 = Date.now();
  try {
    const [analysisCounts, renderCounts, n8nCounts, workers] = await Promise.all([
      queues.analysisQueue.getJobCounts('waiting', 'active', 'failed'),
      queues.renderQueue.getJobCounts('waiting', 'active', 'failed'),
      queues.n8nQueue.getJobCounts('waiting', 'active', 'failed'),
      inspectWorkerHealth(),
    ]);
    const waitingTotal = (analysisCounts.waiting ?? 0) + (renderCounts.waiting ?? 0) + (n8nCounts.waiting ?? 0);
    const detail =
      workers.online === false
        ? `no active analysis/render workers connected (analysisWorkers=${workers.analysis ?? 0}, renderWorkers=${workers.render ?? 0}, waiting=${waitingTotal})`
        : undefined;
    return { ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: (e as Error).message };
  }
};

healthRouter.get('/redis', async (_q, res) => res.json(await checkRedis()));
healthRouter.get('/db', async (_q, res) => res.json(await checkDb()));
healthRouter.get('/s3', async (_q, res) => res.json(await checkS3()));
healthRouter.get('/claude', async (_q, res) => res.json(await checkClaude()));
healthRouter.get('/ollama', async (_q, res) => res.json(await checkOllama()));
healthRouter.get('/queue', async (_q, res) => res.json(await checkQueue()));
healthRouter.get('/workers', async (_q, res) => res.json(await inspectWorkerHealth()));

// aggregate — returns 200 only if every dependency is healthy
healthRouter.get('/', async (_q, res) => {
  const [redis, db, s3c, claude, ollama, queue, workers] = await Promise.all([
    checkRedis(),
    checkDb(),
    checkS3(),
    checkClaude(),
    checkOllama(),
    checkQueue(),
    inspectWorkerHealth(),
  ]);
  const ai = env.AI_PROVIDER === 'ollama' ? ollama : env.AI_PROVIDER === 'claude' ? claude : { ok: true, ms: 0 };
  const ok = redis.ok && db.ok && s3c.ok && ai.ok && queue.ok;
  res.status(ok ? 200 : 503).json({ ok, redis, db, s3: s3c, claude, ollama, queue, workers });
});
