import { Queue } from 'bullmq';
import { bullConnection as connection } from '../lib/redis.js';

export const ANALYSIS_QUEUE = 'analysis';
export const RENDER_QUEUE = 'render';
export const N8N_QUEUE = 'n8n-dispatch';

export interface AnalysisJobData {
  projectId: string;
  s3Key: string;
  bucket: string;
  userPrompt?: string;
}

export interface RenderJobData {
  projectId: string;
  renderId: string;
  format: 'reel' | 'short' | 'landscape';
}

export interface N8nJobData {
  connectionId: string;
  workflowRunId: string;
  webhookPath: string;
  payload: Record<string, unknown>;
}

export const analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE, { connection });
export const renderQueue = new Queue<RenderJobData>(RENDER_QUEUE, { connection });
export const n8nQueue = new Queue<N8nJobData>(N8N_QUEUE, { connection });

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
