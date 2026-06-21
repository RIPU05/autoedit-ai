import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db, prismaMock, queueAdds, resetDb, resetQueues } from './test-state.js';

const processors = new Map<string, (job: any) => Promise<unknown>>();
const failedHandlers = new Map<string, (job: any, err: Error) => Promise<void>>();
const dispatchIntegrationEvent = vi.fn(async () => undefined);
const hasAudioStream = vi.fn(async () => true);
const detectSilences = vi.fn(async () => [{ start: 4, end: 5 }]);
const extractAudio = vi.fn(async (_file: string, out: string) => out);
const transcribeRich = vi.fn(async () => ({
  language: 'en',
  durationSec: 10,
  avgConfidence: 0.98,
  model: 'mock-whisper',
  segments: [{ start: 0, end: 3, text: 'hello world', confidence: 0.98 }],
  words: [{ start: 0, end: 0.5, word: 'hello', confidence: 0.98 }],
}));
const renderEdit = vi.fn(async (_plan, _workDir, progress) => {
  await progress(100);
  const outPath = path.join(process.cwd(), 'tmp', 'worker-rendered.mp4');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, Buffer.from('mock video'));
  return outPath;
});

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    async add(_name: string, data: any) {
      queueAdds[this.name === 'analysis' ? 'analysis' : this.name === 'render' ? 'render' : 'n8n'].push(data);
      return { id: `${this.name}-job-${queueAdds.render.length + queueAdds.analysis.length + queueAdds.n8n.length}` };
    }
    async getJobCounts() {
      return { waiting: 0, active: 0, failed: 0 };
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
vi.mock('../src/ffmpeg/probe.js', () => ({
  probe: vi.fn(async () => ({ durationSec: 10, width: 640, height: 360, fps: 30 })),
  hasAudioStream,
  detectSilences,
  extractAudio,
}));
vi.mock('../src/services/transcribe.service.js', () => ({
  transcribeRich,
}));
vi.mock('../src/ai/providers.js', () => ({
  runAiProvider: vi.fn(async ({ transcript, meta }) => {
    const noAudio = transcript.length === 0;
    return {
      provider: 'fallback',
      fallback: true,
      reason: 'mock AI unavailable',
      result: {
        summary: noAudio ? 'video-only fallback' : 'hello world',
        strategy: 'fallback strategy',
        highlights: [{ start: 0, end: noAudio ? meta.durationSec : 3, label: noAudio ? 'Video-only segment' : 'hello world', score: 0.5 }],
        silences: noAudio ? [] : [{ start: 4, end: 5 }],
        speakers: noAudio ? [] : [{ id: 'spk_1', label: 'Speaker 1', segments: [{ start: 0, end: 3 }] }],
        captions: noAudio ? [] : [{ start: 0, end: 3, text: 'hello world' }],
        suggestedTitles: ['Auto-generated edit'],
        socialCopy: { instagram: 'edit', tiktok: 'edit', youtube: 'edit', linkedin: 'edit' },
        hook: { hook: { start: 0, end: noAudio ? 5 : 3, text: 'hello world' }, alternatives: [] },
        thumbnail: { concept: 'opening', overlayText: 'edit', bestFrameSec: 0 },
        agentLog: [{ agent: 'Fallback', ms: 0, summary: 'mock AI unavailable' }],
        operations: [{ index: 0, start: 0, end: noAudio ? meta.durationSec : 3, label: noAudio ? 'Video-only segment' : 'hello world', keep: true, zoom: 1 }],
        effects: { subtitles: !noAudio, zooms: false, transitions: 'none', music: false, metadata: { aiProvider: 'fallback', noAudio } },
        model: 'fallback',
      },
    };
  }),
}));
vi.mock('../src/services/version.service.js', () => ({
  createVersion: vi.fn(async (data) => ({ id: 'version_1', ...data })),
}));
vi.mock('../src/services/creator-memory.service.js', () => ({
  buildPromptInjection: vi.fn(async () => ''),
  learnFromProject: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/observability.js', () => ({
  timeStage: vi.fn(async (_stage: string, _projectId: string, fn: () => Promise<unknown>) => fn()),
  captureError: vi.fn(async () => undefined),
  isInvalidJsonError: vi.fn(() => false),
  withTimeout: vi.fn(async (promise: Promise<unknown>) => promise),
}));
vi.mock('../src/services/integration-events.service.js', () => ({
  dispatchIntegrationEvent,
  getConnectedClaudeApiKey: vi.fn(async () => undefined),
}));
vi.mock('../src/ffmpeg/pipeline.js', () => ({
  renderEdit,
  buildKeepSegments: vi.fn(() => [{ start: 0, end: 3, zoom: 1 }]),
}));

beforeEach(async () => {
  resetDb();
  resetQueues();
  processors.clear();
  failedHandlers.clear();
  dispatchIntegrationEvent.mockClear();
  hasAudioStream.mockReset();
  hasAudioStream.mockResolvedValue(true);
  detectSilences.mockClear();
  extractAudio.mockClear();
  transcribeRich.mockClear();
  renderEdit.mockClear();
  global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  vi.resetModules();
  await import('../src/queue/workers/analysis.worker.js');
  await import('../src/queue/workers/render.worker.js');
});

describe('analysis worker regression', () => {
  it('persists transcript, falls back when AI fails, creates timeline, and enqueues render jobs', async () => {
    db.projects.push({ id: 'project_1', userId: 'user_1', title: 'Worker Project', status: 'UPLOADED' });
    const processor = processors.get('analysis');
    expect(processor).toBeDefined();

    const result = await processor!({
      id: 'analysis-job',
      data: { projectId: 'project_1', s3Key: 'sources/user/video.mp4', bucket: 'autoedit-test-bucket' },
      updateProgress: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({ provider: 'fallback', fallback: true });
    expect(db.transcripts[0]).toMatchObject({ projectId: 'project_1', model: 'mock-whisper' });
    expect(db.analyses[0]).toMatchObject({ projectId: 'project_1', model: 'fallback' });
    expect(db.timelines[0]).toMatchObject({ projectId: 'project_1', approved: true });
    expect(db.projects.find((p) => p.id === 'project_1')?.status).toBe('RENDERING');
    expect(db.renders.map((render) => render.format).sort()).toEqual(['landscape', 'reel', 'short']);
    expect(queueAdds.render).toHaveLength(3);
    expect(extractAudio).toHaveBeenCalledOnce();
    expect(transcribeRich).toHaveBeenCalledOnce();
  });

  it('skips extractAudio for no-audio media, persists an empty transcript, and enqueues fallback renders', async () => {
    hasAudioStream.mockResolvedValue(false);
    db.projects.push({ id: 'project_1', userId: 'user_1', title: 'No Audio Project', status: 'UPLOADED' });
    const processor = processors.get('analysis');
    expect(processor).toBeDefined();

    const result = await processor!({
      id: 'analysis-job',
      data: { projectId: 'project_1', s3Key: 'sources/user/no-audio.mp4', bucket: 'autoedit-test-bucket' },
      updateProgress: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({ provider: 'fallback', fallback: true });
    expect(extractAudio).not.toHaveBeenCalled();
    expect(transcribeRich).not.toHaveBeenCalled();
    expect(detectSilences).not.toHaveBeenCalled();
    expect(db.transcripts[0]).toMatchObject({
      projectId: 'project_1',
      language: 'unknown',
      durationSec: 10,
      segments: [],
      words: [],
      avgConfidence: null,
      model: 'no-audio',
    });
    expect(db.analyses[0]).toMatchObject({ projectId: 'project_1', model: 'fallback', captions: [] });
    expect(db.timelines[0]).toMatchObject({ projectId: 'project_1', approved: true });
    expect(db.timelines[0].operations).toEqual([expect.objectContaining({ start: 0, end: 10, keep: true })]);
    expect(db.projects.find((p) => p.id === 'project_1')?.status).toBe('RENDERING');
    expect(queueAdds.render).toHaveLength(3);
  });
});

describe('render worker regression', () => {
  it('completes render, uploads output, and dispatches n8n event best-effort', async () => {
    const project = {
      id: 'project_1',
      userId: 'user_1',
      title: 'Render Project',
      analysis: {
        captions: [{ start: 0, end: 3, text: 'hello world' }],
        silences: [],
        highlights: [{ start: 0, end: 3 }],
        socialCopy: {},
        suggestedTitles: ['Render Project'],
      },
      timeline: {
        operations: [{ index: 0, start: 0, end: 3, keep: true, zoom: 1 }],
        effects: { subtitles: true, zooms: false, transitions: 'none', music: false },
      },
      sourceAsset: { s3Key: 'sources/user/video.mp4', durationSec: 10 },
    };
    db.projects.push(project);
    db.renders.push({ id: 'render_1', projectId: 'project_1', format: 'short', status: 'QUEUED', progress: 0 });

    const processor = processors.get('render');
    expect(processor).toBeDefined();
    const result = await processor!({
      id: 'render-job',
      data: { projectId: 'project_1', renderId: 'render_1', format: 'short' },
      updateProgress: vi.fn(async () => undefined),
      attemptsMade: 0,
      opts: { attempts: 1 },
    });

    expect(result).toMatchObject({ outKey: 'renders/project_1/render_1-short.mp4' });
    expect(db.renders[0]).toMatchObject({ status: 'COMPLETED', progress: 100, outputS3Key: 'renders/project_1/render_1-short.mp4' });
    expect(db.projects[0].status).toBe('RENDERED');
    expect(dispatchIntegrationEvent).toHaveBeenCalledWith('user_1', 'render.completed', expect.objectContaining({ renderId: 'render_1' }));
  });

  it('logs render failure and n8n failure dispatch remains best-effort', async () => {
    db.projects.push({ id: 'project_1', userId: 'user_1', title: 'Render Project' });
    db.renders.push({ id: 'render_1', projectId: 'project_1', format: 'short', status: 'RUNNING', progress: 5 });
    dispatchIntegrationEvent.mockRejectedValueOnce(new Error('n8n down'));

    const handler = failedHandlers.get('render');
    expect(handler).toBeDefined();
    await handler!(
      { data: { projectId: 'project_1', renderId: 'render_1', format: 'short' }, id: 'render-job', attemptsMade: 1, opts: { attempts: 1 } },
      new Error('ffmpeg failed'),
    );

    expect(db.renders[0]).toMatchObject({ status: 'FAILED', error: 'ffmpeg failed' });
  });
});
