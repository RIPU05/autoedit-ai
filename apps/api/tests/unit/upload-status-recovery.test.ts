import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { db, prismaMock, queueAdds, resetDb, resetQueues, storageMock } from '../test-state.js';

const workerMocks = {
  analysisWorkers: [] as unknown[],
  renderWorkers: [] as unknown[],
  existingBullJobs: new Map<string, { state: string }>(),
};

vi.mock('../../src/storage/index.js', () => ({
  getStorageProvider: vi.fn(() => storageMock),
  createStorageProvider: vi.fn(() => storageMock),
  resolveStorageConfig: vi.fn(),
  setStorageProvider: vi.fn(),
}));
vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../../src/lib/redis.js', () => ({
  connection: { ping: vi.fn(async () => 'PONG') },
  bullConnection: {},
}));
vi.mock('../../src/queue/queues.js', () => ({
  ANALYSIS_QUEUE: 'analysis',
  RENDER_QUEUE: 'render',
  N8N_QUEUE: 'n8n-dispatch',
  MEDIA_PROCESS_QUEUE: 'media-process',
  PRIVATE_RENDER_QUEUE: 'private-render',
  analysisQueue: {
    getJobCounts: vi.fn(async () => ({ waiting: queueAdds.analysis.length, active: 0, failed: 0 })),
    getWorkers: vi.fn(async () => workerMocks.analysisWorkers),
    getJob: vi.fn(async (id: string) => {
      const found = workerMocks.existingBullJobs.get(id);
      return found ? { id, getState: async () => found.state } : null;
    }),
  },
  renderQueue: {
    getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })),
    getWorkers: vi.fn(async () => workerMocks.renderWorkers),
  },
  n8nQueue: {
    getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })),
  },
  mediaProcessQueue: {
    getWorkers: vi.fn(async () => []),
  },
  privateRenderQueue: {
    getWorkers: vi.fn(async () => []),
  },
  enqueueAnalysis: vi.fn(async (data) => {
    queueAdds.analysis.push(data);
    const id = `analysis-job-${queueAdds.analysis.length}`;
    workerMocks.existingBullJobs.set(id, { state: 'waiting' });
    return { id };
  }),
  enqueueRender: vi.fn(async (data) => {
    queueAdds.render.push(data);
    return { id: `render-job-${queueAdds.render.length}` };
  }),
  enqueueN8n: vi.fn(async (data) => {
    queueAdds.n8n.push(data);
    return { id: `n8n-job-${queueAdds.n8n.length}` };
  }),
  moveToDeadLetter: vi.fn(async () => undefined),
}));

const probeMock = vi.fn(async () => ({ durationSec: 12, width: 1280, height: 720, fps: 30 }));
vi.mock('../../src/ffmpeg/probe.js', () => ({
  probe: probeMock,
  detectSilences: vi.fn(async () => []),
  extractAudio: vi.fn(async (_file: string, out: string) => out),
}));
vi.mock('../../src/services/integration-events.service.js', () => ({
  dispatchIntegrationEvent: vi.fn(async () => undefined),
  getConnectedClaudeApiKey: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/creator-memory.service.js', () => ({
  buildPromptInjection: vi.fn(async () => ''),
  learnFromPromptEdit: vi.fn(async () => undefined),
  learnFromProject: vi.fn(async () => undefined),
}));

let baseUrl = '';
let server: http.Server;

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

async function registerUser(email: string) {
  const { body } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'x-test-rate-limit-key': email },
    body: JSON.stringify({ email, password: 'Password123!', name: 'Recovery Test User' }),
  });
  return { token: body.token as string, user: body.user as { id: string } };
}

beforeAll(async () => {
  const { createApp } = await import('../../src/app.js');
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetDb();
  resetQueues();
  probeMock.mockClear();
  workerMocks.analysisWorkers = [];
  workerMocks.renderWorkers = [];
  workerMocks.existingBullJobs.clear();
});

describe('Upload analysis visibility, worker-offline diagnostics, and safe retry regression', () => {
  it('surfaces missing analysis/render workers in /health and /health/workers', async () => {
    const offline = await request('/health/workers');
    expect(offline.res.status).toBe(200);
    expect(offline.body).toMatchObject({
      online: false,
      analysis: 0,
      render: 0,
      total: 0,
    });

    const queueHealth = await request('/health/queue');
    expect(queueHealth.res.status).toBe(200);
    expect(queueHealth.body.detail).toContain('no active analysis/render workers connected');

    workerMocks.analysisWorkers = [{ id: 'w1' }];
    workerMocks.renderWorkers = [{ id: 'w2' }];
    const online = await request('/health/workers');
    expect(online.body).toMatchObject({
      online: true,
      analysis: 1,
      render: 1,
      total: 2,
    });
  });

  it('completes a >50 MB upload without synchronous HTTP probe timeout, reports worker-offline status on GET /api/projects/:id, deduplicates queued retries, and retries FAILED projects safely', async () => {
    const owner = await registerUser('owner-recovery@local.test');
    const other = await registerUser('other-recovery@local.test');

    // 1. Start & complete a 62 MB upload (reproducing the sneak-peek 62 MB MP4)
    const start = await request('/api/upload/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ filename: 'live-performance.mp4', contentType: 'video/mp4', title: 'Live Perf' }),
    });
    expect(start.res.status).toBe(200);

    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start.body.key,
        uploadId: start.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 62_083_660,
        parts: [{ ETag: 'etag-1', PartNumber: 1 }],
      }),
    });
    expect(complete.res.status).toBe(200);
    expect(complete.body.analysisJobId).toBe('analysis-job-1');
    // >50 MB skipped blocking HTTP download/probe so /complete returns promptly
    expect(probeMock).not.toHaveBeenCalled();

    // 2. GET /api/projects/:id exposes real UPLOADED + QUEUED job + 0 workers online
    const detail = await request(`/api/projects/${start.body.projectId}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(detail.res.status).toBe(200);
    expect(detail.body.project.status).toBe('UPLOADED');
    expect(detail.body.project.analysisJob).toMatchObject({
      type: 'ANALYZE',
      status: 'QUEUED',
      bullId: 'analysis-job-1',
    });
    expect(detail.body.project.workerStatus).toMatchObject({
      analysisWorkersOnline: 0,
      renderWorkersOnline: 0,
    });

    // 3. Clicking Retry while job is already waiting in Redis deduplicates (0 extra enqueues)
    const dedupRetry = await request(`/api/projects/${start.body.projectId}/retry-analysis`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(dedupRetry.res.status).toBe(200);
    expect(dedupRetry.body).toMatchObject({
      ok: true,
      reusedExistingJob: true,
      analysisJobId: 'analysis-job-1',
      workersOnline: 0,
    });
    expect(queueAdds.analysis).toHaveLength(1);

    // 4. Cross-user retry is rejected (404)
    const crossUser = await request(`/api/projects/${start.body.projectId}/retry-analysis`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(crossUser.res.status).toBe(404);

    // 5. Simulate terminal failure + ErrorEvent -> GET surfaces error, retry re-enqueues cleanly
    const projectRow = db.projects.find((p) => p.id === start.body.projectId)!;
    const assetRow = db.assets.find((a) => a.id === projectRow.sourceAssetId)!;
    projectRow.status = 'FAILED';
    projectRow.sourceAsset = assetRow;
    db.jobs[0].status = 'FAILED';
    db.jobs[0].error = 'FFmpeg failed: corrupt moov atom';
    db.errorEvents.push({
      id: 'err_1',
      projectId: projectRow.id,
      category: 'FFMPEG',
      message: 'FFmpeg failed: corrupt moov atom',
      createdAt: new Date(),
    });

    const failedDetail = await request(`/api/projects/${projectRow.id}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(failedDetail.body.project.status).toBe('FAILED');
    expect(failedDetail.body.project.latestError?.message).toBe('FFmpeg failed: corrupt moov atom');

    workerMocks.analysisWorkers = [{ id: 'w1' }];
    const retryAfterFail = await request(`/api/projects/${projectRow.id}/retry-analysis`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(retryAfterFail.res.status).toBe(200);
    expect(retryAfterFail.body).toMatchObject({
      ok: true,
      reusedExistingJob: false,
      analysisJobId: 'analysis-job-2',
      workersOnline: 1,
    });
    expect(queueAdds.analysis).toHaveLength(2);
    expect(projectRow.status).toBe('UPLOADED');

    // 6. Reject retry while ANALYZING (409)
    projectRow.status = 'ANALYZING';
    const whileAnalyzing = await request(`/api/projects/${projectRow.id}/retry-analysis`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(whileAnalyzing.res.status).toBe(409);
  });
});
