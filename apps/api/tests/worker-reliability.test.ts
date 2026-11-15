import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db, prismaMock, queueAdds, resetDb, resetQueues } from './test-state.js';
import { env } from '../src/config/env.js';

const processors = new Map<string, (job: any) => Promise<unknown>>();
const failedHandlers = new Map<string, (job: any, err: Error) => Promise<void>>();
const moveToDeadLetterMock = vi.fn(async () => undefined);

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    async add(_name: string, data: any) {
      return { id: 'mock-job-id' };
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
  enqueueRender: vi.fn(async () => ({ id: 'render-job-1' })),
  enqueueN8n: vi.fn(async () => ({ id: 'n8n-job-1' })),
  moveToDeadLetter: moveToDeadLetterMock,
}));

const extractAudio = vi.fn(async (_file: string, out: string) => out);
const renderEdit = vi.fn(async (_plan, _workDir, progress) => {
  await progress(100);
  const outPath = path.join(process.cwd(), 'tmp', 'test-rendered.mp4');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, Buffer.from('mock video'));
  return outPath;
});

vi.mock('../src/ffmpeg/probe.js', () => ({
  probe: vi.fn(async () => ({ durationSec: 10, width: 640, height: 360, fps: 30 })),
  hasAudioStream: vi.fn(async () => true),
  detectSilences: vi.fn(async () => []),
  extractAudio,
}));

vi.mock('../src/services/transcribe.service.js', () => ({
  transcribeRich: vi.fn(async () => ({
    language: 'en',
    durationSec: 10,
    avgConfidence: 0.95,
    model: 'whisper',
    segments: [{ start: 0, end: 5, text: 'hello' }],
    words: [],
  })),
}));

vi.mock('../src/ffmpeg/pipeline.js', () => ({
  buildKeepSegments: vi.fn(() => [{ start: 0, end: 5, zoom: 1 }]),
  renderEdit,
}));

vi.mock('../src/services/integration-events.service.js', () => ({
  dispatchIntegrationEvent: vi.fn(async () => undefined),
  getConnectedClaudeApiKey: vi.fn(async () => undefined),
}));

vi.mock('../src/services/creator-memory.service.js', () => ({
  buildPromptInjection: vi.fn(async () => undefined),
  learnFromProject: vi.fn(async () => undefined),
}));

beforeEach(async () => {
  resetDb();
  resetQueues();
  processors.clear();
  failedHandlers.clear();
  moveToDeadLetterMock.mockClear();
  extractAudio.mockClear();
  renderEdit.mockClear();
  global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  vi.resetModules();
  await import('../src/queue/workers/analysis.worker.js');
  await import('../src/queue/workers/render.worker.js');
});

describe('Worker Disk Cleanup and Failure Handling Reliability', () => {
  it('cleans up analysis scratch directory on successful completion', async () => {
    const projectId = 'clean_success_proj';
    db.projects.push({ id: projectId, userId: 'user_1', title: 'Clean Success', status: 'UPLOADED' });

    const processor = processors.get('analysis');
    expect(processor).toBeDefined();

    const expectedWorkDir = path.resolve(env.RENDER_WORK_DIR, 'analysis', projectId, 'job_success_1');

    await processor!({
      id: 'job_success_1',
      data: { projectId, s3Key: 'sources/user/video.mp4', bucket: 'test-bucket' },
      updateProgress: vi.fn(async () => undefined),
    });

    // Verify directory does not exist after completion
    const dirExists = await fs.stat(expectedWorkDir).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);
  });

  it('cleans up analysis scratch directory even if audio extraction fails', async () => {
    const projectId = 'clean_fail_audio_proj';
    db.projects.push({ id: projectId, userId: 'user_1', title: 'Audio Fail', status: 'UPLOADED' });

    extractAudio.mockRejectedValueOnce(new Error('FFmpeg audio extraction crashed'));

    const processor = processors.get('analysis');
    expect(processor).toBeDefined();

    const expectedWorkDir = path.resolve(env.RENDER_WORK_DIR, 'analysis', projectId, 'job_audio_fail');

    await expect(
      processor!({
        id: 'job_audio_fail',
        data: { projectId, s3Key: 'sources/user/video.mp4', bucket: 'test-bucket' },
        updateProgress: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('FFmpeg audio extraction crashed');

    // Verify directory was cleaned up despite the failure
    const dirExists = await fs.stat(expectedWorkDir).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);
  });

  it('cleans up render scratch directory on success and on failure', async () => {
    const projectId = 'clean_render_proj';
    const renderId = 'render_test_1';
    db.projects.push({
      id: projectId,
      userId: 'user_1',
      title: 'Render Clean',
      status: 'ANALYZED',
      sourceAsset: { s3Key: 'sources/user/video.mp4', durationSec: 10 },
      analysis: { silences: [], highlights: [], captions: [], socialCopy: {}, suggestedTitles: [] },
      timeline: { operations: [{ start: 0, end: 5, keep: true }], effects: {} },
    });
    db.renders.push({ id: renderId, projectId, format: 'short', status: 'QUEUED' });

    const renderProcessor = processors.get('render');
    expect(renderProcessor).toBeDefined();

    const expectedWorkDir = path.resolve(env.RENDER_WORK_DIR, 'renders', projectId, renderId);

    // Test successful render cleanup
    await renderProcessor!({
      id: 'bull_render_1',
      data: { projectId, renderId, format: 'short' },
      updateProgress: vi.fn(async () => undefined),
    });

    const dirExists = await fs.stat(expectedWorkDir).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);

    // Test failed render cleanup
    renderEdit.mockRejectedValueOnce(new Error('FFmpeg filtergraph error'));
    db.renders[0].status = 'QUEUED';

    await expect(
      renderProcessor!({
        id: 'bull_render_fail',
        data: { projectId, renderId, format: 'short' },
        updateProgress: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('FFmpeg filtergraph error');

    const failDirExists = await fs.stat(expectedWorkDir).then(() => true).catch(() => false);
    expect(failDirExists).toBe(false);
  });

  it('does not mark project FAILED on non-final retry attempts', async () => {
    const projectId = 'retry_proj_1';
    db.projects.push({ id: projectId, userId: 'user_1', title: 'Retry Project', status: 'ANALYZING' });

    const failedHandler = failedHandlers.get('analysis');
    expect(failedHandler).toBeDefined();

    // Attempt 1 of 3: Should NOT mark project FAILED
    await failedHandler!(
      {
        id: 'job_retry_1',
        data: { projectId },
        attemptsMade: 1,
        opts: { attempts: 3 },
      },
      new Error('Temporary network glitch'),
    );

    const projectAfterAttempt1 = db.projects.find((p) => p.id === projectId);
    expect(projectAfterAttempt1?.status).toBe('ANALYZING');
    expect(moveToDeadLetterMock).not.toHaveBeenCalled();

    // Final attempt (3 of 3): NOW it should mark project FAILED and move to dead letter
    await failedHandler!(
      {
        id: 'job_retry_1',
        data: { projectId },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error('Permanent failure'),
    );

    const projectAfterAttempt3 = db.projects.find((p) => p.id === projectId);
    expect(projectAfterAttempt3?.status).toBe('FAILED');
    expect(moveToDeadLetterMock).toHaveBeenCalledOnce();
  });
});
