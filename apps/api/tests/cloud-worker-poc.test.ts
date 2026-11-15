import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db, prismaMock, resetDb } from './test-state.js';
import { env } from '../src/config/env.js';
import type { TranscriptionResult } from '../src/services/transcribe.service.js';

const processors = new Map<string, (job: any) => Promise<unknown>>();
const failedHandlers = new Map<string, (job: any, err: Error) => Promise<void>>();
const deadLetterCalls: any[] = [];

// Mock BullMQ worker harness
vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    async add(_name: string, _data: any) {
      return { id: 'mock-poc-job-id' };
    }
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: any) => Promise<unknown>) {
      this.name = name;
      processors.set(name, processor);
    }
    on(event: string, handler: (job: any, err: Error) => Promise<void>) {
      if (event === 'failed') failedHandlers.set(this.name, handler);
      return this;
    }
  },
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../src/lib/redis.js', () => ({ bullConnection: {}, connection: { ping: vi.fn(async () => 'PONG') } }));
vi.mock('../src/lib/s3.js', () => ({
  presignDownload: vi.fn(async (key: string) => `https://s3.test/${key}`),
  putObject: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/queue/queues.js', () => ({
  ANALYSIS_QUEUE: 'analysis',
  RENDER_QUEUE: 'render',
  N8N_QUEUE: 'n8n-dispatch',
  enqueueRender: vi.fn(async () => ({ id: 'render-job-poc' })),
  enqueueN8n: vi.fn(async () => ({ id: 'n8n-job-poc' })),
  moveToDeadLetter: vi.fn(async (origin, data, error) => {
    deadLetterCalls.push({ origin, data, error });
  }),
}));

const mockWordTimestamps = [
  { start: 0.1, end: 0.5, word: 'Welcome', confidence: 0.98 },
  { start: 0.6, end: 0.9, word: 'to', confidence: 0.99 },
  { start: 1.0, end: 1.4, word: 'AutoEdit', confidence: 0.95 },
  { start: 1.5, end: 2.0, word: 'Cloud', confidence: 0.97 },
];

const mockTranscriptionResult: TranscriptionResult = {
  language: 'en',
  durationSec: 2.0,
  segments: [
    { start: 0.1, end: 2.0, text: 'Welcome to AutoEdit Cloud', confidence: 0.97 },
  ],
  words: mockWordTimestamps,
  avgConfidence: 0.97,
  model: 'base',
};

const extractAudioMock = vi.fn(async (_file: string, out: string) => {
  await fs.writeFile(out, Buffer.from('mock wav audio data'));
  return out;
});

vi.mock('../src/ffmpeg/probe.js', () => ({
  probe: vi.fn(async () => ({ durationSec: 10, width: 1280, height: 720, fps: 30 })),
  hasAudioStream: vi.fn(async () => true),
  detectSilences: vi.fn(async () => []),
  extractAudio: extractAudioMock,
}));

vi.mock('../src/services/transcribe.service.js', () => ({
  transcribeRich: vi.fn(async () => mockTranscriptionResult),
  transcriberHealthy: vi.fn(async () => true),
}));

vi.mock('../src/services/creator-memory.service.js', () => ({
  buildPromptInjection: vi.fn(async () => ''),
  learnFromProject: vi.fn(async () => undefined),
}));

vi.mock('../src/services/integration-events.service.js', () => ({
  dispatchIntegrationEvent: vi.fn(async () => undefined),
  getConnectedClaudeApiKey: vi.fn(async () => undefined),
}));

describe('Cloud Worker Proof-of-Concept Integration', () => {
  let analysisProcessor: (job: any) => Promise<unknown>;
  let renderProcessor: (job: any) => Promise<unknown>;

  beforeEach(async () => {
    resetDb();
    deadLetterCalls.length = 0;
    extractAudioMock.mockClear();

    // Import workers to trigger initialization
    await import('../src/queue/workers/analysis.worker.js');
    await import('../src/queue/workers/render.worker.js');

    analysisProcessor = processors.get('analysis')!;
    renderProcessor = processors.get('render')!;

    // Seed test user and project
    db.users.push({ id: 'user_poc', email: 'poc@example.com' });
    db.projects.push({
      id: 'proj_poc_1',
      userId: 'user_poc',
      title: 'Cloud Worker Proof of Concept',
      status: 'UPLOADING',
    });
    db.jobs.push({
      id: 'job_poc_1',
      projectId: 'proj_poc_1',
      type: 'ANALYZE',
      status: 'QUEUED',
    });

    // Mock fetch for source download
    global.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: new ReadableStream(),
        arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer,
      } as any;
    });
  });

  it('1-8. Worker successfully retrieves job, extracts audio, gets word timestamps, and updates project status', async () => {
    const job = {
      id: 'bull_job_1',
      data: {
        projectId: 'proj_poc_1',
        s3Key: 'sources/user_poc/poc-test/test.mp4',
        bucket: 'test-bucket',
      },
      updateProgress: vi.fn(),
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    const result = await analysisProcessor(job);

    expect(result).toBeDefined();
    // 5. Audio extraction verified
    expect(extractAudioMock).toHaveBeenCalledTimes(1);

    // 7. Word timestamps verified in persisted transcript
    const transcript = db.transcripts.find((t) => t.projectId === 'proj_poc_1');
    expect(transcript).toBeDefined();
    expect(transcript?.language).toBe('en');
    expect(transcript?.words).toEqual(mockWordTimestamps);

    // 8. Project status transitioned to ANALYZED (or RENDERING on auto-render)
    const project = db.projects.find((p) => p.id === 'proj_poc_1');
    expect(['ANALYZED', 'RENDERING']).toContain(project?.status);

    // Timeline created
    const timeline = db.timelines.find((tl) => tl.projectId === 'proj_poc_1');
    expect(timeline).toBeDefined();

    // Version history created
    const version = db.versions.find((v) => v.projectId === 'proj_poc_1');
    expect(version).toBeDefined();
    expect(version?.name).toBe('Original AI cut');
  });

  it('9. Scratch directory is fully cleaned up on job completion', async () => {
    const safeProject = 'proj_poc_1';
    const safeJobId = 'bull_job_scratch';
    const expectedWorkDir = path.resolve(env.RENDER_WORK_DIR, 'analysis', safeProject, safeJobId);

    const job = {
      id: safeJobId,
      data: {
        projectId: safeProject,
        s3Key: 'sources/user_poc/scratch-test/test.mp4',
        bucket: 'test-bucket',
      },
      updateProgress: vi.fn(),
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await analysisProcessor(job);

    // Verify scratch directory does not remain on disk
    const exists = await fs.stat(expectedWorkDir).catch(() => false);
    expect(exists).toBe(false);
  });

  it('10. Worker preserves active state on retry, marks FAILED only on final attempt, and routes to Dead Letter Queue', async () => {
    const failedHandler = failedHandlers.get('analysis')!;
    expect(failedHandler).toBeDefined();

    const job = {
      id: 'job_retry_test',
      data: { projectId: 'proj_poc_1', s3Key: 'test.mp4', bucket: 'test-bucket' },
      opts: { attempts: 3 },
      attemptsMade: 1, // First failure of 3
    };

    // First retry attempt
    await failedHandler(job, new Error('Temporary network glitch'));

    // Project status should NOT be FAILED on attempt 1
    let project = db.projects.find((p) => p.id === 'proj_poc_1');
    expect(project?.status).not.toBe('FAILED');
    expect(deadLetterCalls.length).toBe(0);

    // Final attempt (attempt 3 of 3)
    job.attemptsMade = 3;
    await failedHandler(job, new Error('Terminal cloud timeout'));

    // On final attempt, project must be marked FAILED and routed to Dead Letter Queue
    project = db.projects.find((p) => p.id === 'proj_poc_1');
    expect(project?.status).toBe('FAILED');
    expect(deadLetterCalls.length).toBe(1);
    expect(deadLetterCalls[0].origin).toBe('analysis');
    expect(deadLetterCalls[0].error).toBe('Terminal cloud timeout');
  });
});
