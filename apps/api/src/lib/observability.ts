import { prisma } from './prisma.js';
import { log } from './logger.js';

export type ErrorCategory =
  | 'FFMPEG'
  | 'CLAUDE'
  | 'OLLAMA'
  | 'INVALID_JSON'
  | 'QUEUE'
  | 'WORKER_CRASH'
  | 'MEMORY'
  | 'RENDER_TIMEOUT'
  | 'TRANSCRIPTION'
  | 'UNKNOWN';

/** Record how long a pipeline stage took (and whether it succeeded). */
export async function timeStage<T>(
  stage: string,
  projectId: string | null,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    log.info('stage.done', { stage, projectId, ms });
    await prisma.stageTiming.create({ data: { stage, projectId, ms, ok: true, meta: meta as object } }).catch(() => {});
    return result;
  } catch (err) {
    const ms = Date.now() - t0;
    log.error('stage.failed', { stage, projectId, ms, err: (err as Error).message });
    await prisma.stageTiming.create({ data: { stage, projectId, ms, ok: false, meta: meta as object } }).catch(() => {});
    throw err;
  }
}

/** Persist a categorized error event + structured log line. */
export async function captureError(
  category: ErrorCategory,
  err: unknown,
  ctx: { projectId?: string; jobId?: string; meta?: Record<string, unknown> } = {},
) {
  const e = err as Error;
  log.error('error.captured', { category, message: e?.message, ...ctx });
  await prisma.errorEvent
    .create({
      data: {
        category: category as any,
        projectId: ctx.projectId,
        jobId: ctx.jobId,
        message: e?.message ?? String(err),
        stack: e?.stack,
        meta: ctx.meta as object,
      },
    })
    .catch(() => {});
}

/** Detect invalid-JSON failures from Claude and categorize them. */
export function isInvalidJsonError(err: unknown): boolean {
  const m = (err as Error)?.message ?? '';
  return /JSON|structured|tool_use|did not return/i.test(m);
}

/** Race a promise against a timeout; throws a tagged error on timeout. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Periodically sample RSS; log + record an ErrorEvent when it crosses a ceiling. */
export function startMemorySampler(thresholdMb = 1536, intervalMs = 15000) {
  let warned = false;
  const timer = setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMb > thresholdMb && !warned) {
      warned = true;
      void captureError('MEMORY', new Error(`RSS ${rssMb}MB exceeded ${thresholdMb}MB`), { meta: { rssMb } });
    }
    if (rssMb < thresholdMb * 0.8) warned = false; // reset hysteresis
    log.debug('mem.sample', { rssMb });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Simple retry with exponential backoff for flaky external calls. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 800): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw lastErr;
}
