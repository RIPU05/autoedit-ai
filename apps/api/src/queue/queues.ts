import { Queue } from 'bullmq';
import { bullConnection as connection } from '../lib/redis.js';
import type {
  AnalysisJobPayload,
  RenderJobPayload,
  N8nJobPayload,
  MediaProcessJobPayload,
  PrivateRenderQueuePayload,
} from '@autoedit/contracts';

export const ANALYSIS_QUEUE = 'analysis';
export const RENDER_QUEUE = 'render';
export const N8N_QUEUE = 'n8n-dispatch';
export const MEDIA_PROCESS_QUEUE = 'media-process';
export const PRIVATE_RENDER_QUEUE = 'private-render';

export type AnalysisJobData = AnalysisJobPayload;
export type RenderJobData = RenderJobPayload;
export type N8nJobData = N8nJobPayload;
export type MediaProcessJobData = MediaProcessJobPayload;
export type PrivateRenderJobData = PrivateRenderQueuePayload;

export const analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE, { connection });
export const renderQueue = new Queue<RenderJobData>(RENDER_QUEUE, { connection });
export const n8nQueue = new Queue<N8nJobData>(N8N_QUEUE, { connection });
export const mediaProcessQueue = new Queue<MediaProcessJobData>(MEDIA_PROCESS_QUEUE, { connection });
export const privateRenderQueue = new Queue<PrivateRenderJobData>(PRIVATE_RENDER_QUEUE, { connection });

// Dead-letter queue: jobs that exhaust all retries are parked here for
// inspection / manual replay instead of vanishing (Phase 6).
export const DEAD_LETTER_QUEUE = 'dead-letter';
export const deadLetterQueue = new Queue(DEAD_LETTER_QUEUE, { connection });

export async function moveToDeadLetter(origin: string, data: unknown, error: string) {
  await deadLetterQueue.add(
    'dead',
    { origin, data, error, at: new Date().toISOString() },
    { removeOnComplete: false, removeOnFail: false },
  );
}

const defaultJobOpts = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

export const enqueueAnalysis = (data: AnalysisJobData) =>
  analysisQueue.add('analyze', data, defaultJobOpts);

// priority: lower number = higher priority. Short-form renders jump the queue.
export const enqueueRender = (data: RenderJobData) =>
  renderQueue.add('render', data, {
    ...defaultJobOpts,
    priority: data.format === 'landscape' ? 10 : 1,
  });

export const enqueueN8n = (data: N8nJobData) =>
  n8nQueue.add('dispatch', data, { ...defaultJobOpts, attempts: 5 });

/**
 * Enqueues shared media ingestion/analysis/clip generation onto BullMQ using a
 * generation-scoped deterministic jobId (`${sharedWorkKey}__g${generation}`) so
 * concurrent clippers on the same generation deduplicate cleanly onto one job,
 * while crash recovery or post-cancel restarts get a fresh generation jobId.
 */
export const enqueueMediaProcess = (
  data: MediaProcessJobData,
  opts?: { jobId?: string; attempts?: number; backoffDelayMs?: number },
) => {
  const safeKey = data.sharedWorkKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const defaultJobId =
    data.generation !== undefined ? `${safeKey}__g${data.generation}` : `${safeKey}__g1`;
  return mediaProcessQueue.add('process-media', data, {
    ...defaultJobOpts,
    jobId: opts?.jobId ?? defaultJobId,
    attempts: opts?.attempts ?? 3,
    backoff: { type: 'exponential' as const, delay: opts?.backoffDelayMs ?? 1500 },
  });
};

/**
 * Enqueues a durable owner-scoped private clip render job onto BullMQ using a
 * generation-scoped deterministic jobId (`priv_${renderJobId}__g${generation}`)
 * so retries and crash recovery generations never collide with completed or superseded attempts.
 */
export const enqueuePrivateRender = (
  data: PrivateRenderJobData,
  opts?: { jobId?: string; attempts?: number; backoffDelayMs?: number },
) => {
  const safeId = data.renderJobId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const defaultJobId = `priv_${safeId}__g${data.generation}`;
  return privateRenderQueue.add('private-render', data, {
    ...defaultJobOpts,
    jobId: opts?.jobId ?? defaultJobId,
    attempts: opts?.attempts ?? 3,
    backoff: { type: 'exponential' as const, delay: opts?.backoffDelayMs ?? 2000 },
  });
};
