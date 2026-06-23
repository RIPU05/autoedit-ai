import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { db, prismaMock, queueAdds, resetDb, resetQueues } from './test-state.js';

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../src/lib/redis.js', () => ({
  connection: { ping: vi.fn(async () => 'PONG') },
  bullConnection: {},
}));
vi.mock('../src/lib/s3.js', () => ({
  s3: { send: vi.fn(async () => ({ ok: true })) },
  startMultipart: vi.fn(async (key: string) => ({ uploadId: `upload-${key}`, bucket: 'autoedit-test-bucket' })),
  presignUploadPart: vi.fn(async () => 'https://s3.test/upload-part'),
  completeMultipart: vi.fn(async () => ({ ok: true })),
  abortMultipart: vi.fn(async () => ({ ok: true })),
  presignDownload: vi.fn(async () => 'https://s3.test/download'),
  putObject: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/queue/queues.js', () => ({
  ANALYSIS_QUEUE: 'analysis',
  RENDER_QUEUE: 'render',
  N8N_QUEUE: 'n8n-dispatch',
  analysisQueue: { getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })) },
  renderQueue: { getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })) },
  n8nQueue: { getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })) },
  enqueueAnalysis: vi.fn(async (data) => {
    queueAdds.analysis.push(data);
    return { id: 'analysis-job-1' };
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
vi.mock('../src/ffmpeg/probe.js', () => ({
  probe: vi.fn(async () => ({ durationSec: 12, width: 640, height: 360, fps: 30 })),
  detectSilences: vi.fn(async () => [{ start: 4, end: 5 }]),
  extractAudio: vi.fn(async (_file: string, out: string) => out),
}));
vi.mock('../src/services/integration-events.service.js', () => ({
  dispatchIntegrationEvent: vi.fn(async () => undefined),
  getConnectedClaudeApiKey: vi.fn(async () => undefined),
}));
vi.mock('../src/services/creator-memory.service.js', () => ({
  buildPromptInjection: vi.fn(async () => ''),
  learnFromPromptEdit: vi.fn(async () => undefined),
  learnFromProject: vi.fn(async () => undefined),
}));

let baseUrl = '';
let server: http.Server;
const realFetch = global.fetch;

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { res, body };
}

async function register() {
  const email = `test-${Math.random().toString(16).slice(2)}@example.com`;
  const { body } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'x-test-rate-limit-key': email },
    body: JSON.stringify({ email, password: 'Password123!', name: 'Test User' }),
  });
  return { email, token: body.token, user: body.user };
}

beforeAll(async () => {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (baseUrl && String(url).startsWith(baseUrl)) return realFetch(url, init);
    if (String(url).includes('anthropic.com')) return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
    if (String(url).includes('/api/tags')) return Response.json({ models: [{ name: 'qwen3:1.7b' }] });
    if (String(url).includes('s3.test/download')) return new Response(new Uint8Array([1, 2, 3]));
    if (String(url).includes('s3.test/upload-part')) return new Response(null, { status: 200, headers: { ETag: '"etag-1"' } });
    return new Response(JSON.stringify({ ok: true }), { status: init?.method === 'POST' ? 200 : 200 });
  }) as typeof fetch;

  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  resetDb();
  resetQueues();
  vi.mocked(global.fetch).mockClear();
});

describe('auth routes', () => {
  it('registers, logs in, and returns me without leaking password hashes', async () => {
    const { email, token, user } = await register();
    expect(token).toEqual(expect.any(String));
    expect(user.passwordHash).toBeUndefined();

    const login = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'Password123!' }),
    });
    expect(login.res.status).toBe(200);
    expect(login.body.user.passwordHash).toBeUndefined();

    const me = await request('/api/auth/me', { headers: { Authorization: `Bearer ${login.body.token}` } });
    expect(me.res.status).toBe(200);
    expect(me.body.user.email).toBe(email);
  });
});

describe('project and upload routes', () => {
  it('creates project shell, lists it, completes upload, and enqueues analysis with mocked S3', async () => {
    const { token } = await register();
    const headers = { Authorization: `Bearer ${token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'sample.mp4', contentType: 'video/mp4', title: 'Sample' }),
    });
    expect(start.res.status).toBe(200);
    expect(start.body).toMatchObject({ bucket: 'autoedit-test-bucket', uploadId: expect.any(String), key: expect.stringContaining('sample.mp4') });

    const list = await request('/api/projects', { headers });
    expect(list.res.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);

    const detail = await request(`/api/projects/${start.body.projectId}`, { headers });
    expect(detail.res.status).toBe(200);
    expect(detail.body.project.title).toBe('Sample');

    const part = await request('/api/upload/part', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: start.body.key, uploadId: start.body.uploadId, partNumber: 1 }),
    });
    expect(part.res.status).toBe(200);
    expect(part.body.url).toContain('s3.test');

    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start.body.key,
        uploadId: start.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 123,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });
    expect(complete.res.status).toBe(200);
    expect(queueAdds.analysis).toEqual([{ projectId: start.body.projectId, s3Key: start.body.key, bucket: 'autoedit-test-bucket' }]);
    expect(db.assets[0].s3Key).toBe(start.body.key);
  });

  it('completes upload when best-effort metadata probe download fails', async () => {
    const { token } = await register();
    const headers = { Authorization: `Bearer ${token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'probe-timeout.mp4', contentType: 'video/mp4', title: 'Probe Timeout' }),
    });
    expect(start.res.status).toBe(200);

    const defaultFetch = vi.mocked(global.fetch).getMockImplementation();
    vi.mocked(global.fetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (baseUrl && String(url).startsWith(baseUrl)) return realFetch(url, init);
      if (String(url).includes('s3.test/download')) throw new TypeError('fetch failed');
      if (defaultFetch) return defaultFetch(url, init);
      throw new TypeError('fetch failed');
    });

    try {
      const complete = await request('/api/upload/complete', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectId: start.body.projectId,
          key: start.body.key,
          uploadId: start.body.uploadId,
          contentType: 'video/mp4',
          sizeBytes: 123,
          parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
        }),
      });

      expect(complete.res.status).toBe(200);
      expect(queueAdds.analysis).toEqual([{ projectId: start.body.projectId, s3Key: start.body.key, bucket: 'autoedit-test-bucket' }]);
      expect(db.assets[0]).toMatchObject({ s3Key: start.body.key, durationSec: undefined });
    } finally {
      if (defaultFetch) vi.mocked(global.fetch).mockImplementation(defaultFetch);
    }
  });
});

describe('integration routes', () => {
  it('handles Claude invalid key and disconnects without returning secrets', async () => {
    const { token } = await register();
    const headers = { Authorization: `Bearer ${token}` };

    const status = await request('/api/integrations/claude/status', { headers });
    expect(status.body.status).toBe('DISCONNECTED');

    const connect = await request('/api/integrations/claude/connect', {
      method: 'POST',
      headers,
      body: JSON.stringify({ apiKey: 'bad-key' }),
    });
    expect(connect.res.status).toBe(400);
    expect(JSON.stringify(connect.body)).not.toContain('bad-key');

    const test = await request('/api/integrations/claude/test', { method: 'POST', headers });
    expect(test.res.status).toBe(400);

    const disconnected = await request('/api/integrations/claude/disconnect', { method: 'DELETE', headers });
    expect(disconnected.body.status).toBe('DISCONNECTED');
  });

  it('connects, tests, and disconnects n8n without exposing signing secret', async () => {
    const { token } = await register();
    const headers = { Authorization: `Bearer ${token}` };

    const invalid = await request('/api/integrations/n8n/connect', {
      method: 'POST',
      headers,
      body: JSON.stringify({ webhookUrl: 'not-a-url' }),
    });
    expect(invalid.res.status).toBe(400);

    const connect = await request('/api/integrations/n8n/connect', {
      method: 'POST',
      headers,
      body: JSON.stringify({ webhookUrl: 'https://n8n.example.test/webhook/autoedit', workflowName: 'Local', signingSecret: 'secret-value' }),
    });
    expect(connect.res.status).toBe(200);
    expect(connect.body.status).toBe('CONNECTED');
    expect(JSON.stringify(connect.body)).not.toContain('secret-value');

    const test = await request('/api/integrations/n8n/test', { method: 'POST', headers });
    expect(test.res.status).toBe(200);

    const disconnected = await request('/api/integrations/n8n/disconnect', { method: 'DELETE', headers });
    expect(disconnected.body.status).toBe('DISCONNECTED');
  });
});

describe('health routes', () => {
  it('reports mocked db, redis, s3, and ollama health without real services', async () => {
    await expect(request('/health/db')).resolves.toMatchObject({ body: { ok: true } });
    await expect(request('/health/redis')).resolves.toMatchObject({ body: { ok: true } });
    await expect(request('/health/s3')).resolves.toMatchObject({ body: { ok: true } });
    await expect(request('/health/ollama')).resolves.toMatchObject({ body: { ok: true } });
  });
});

describe('rate limit regression', () => {
  it('limits auth routes and returns JSON 429 with retry information', async () => {
    const key = `auth-limit-${Math.random()}`;
    const statuses: number[] = [];
    let limitedBody: unknown;

    for (let i = 0; i < 6; i++) {
      const response = await request('/api/auth/register', {
        method: 'POST',
        headers: { 'x-test-rate-limit-key': key },
        body: JSON.stringify({ email: `${key}-${i}@example.com`, password: 'Password123!', name: 'Limited User' }),
      });
      statuses.push(response.res.status);
      limitedBody = response.body;
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    expect(limitedBody).toMatchObject({ error: 'rate limit exceeded', retryAfterSec: expect.any(Number) });
  });

  it('limits upload routes after normal threshold usage', async () => {
    const { token } = await register();
    const key = `upload-limit-${Math.random()}`;
    const headers = { Authorization: `Bearer ${token}`, 'x-test-rate-limit-key': key };
    let last = await request('/api/upload/part', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'sources/test.mp4', uploadId: 'upload-id', partNumber: 1 }),
    });
    expect(last.res.status).toBe(200);

    for (let i = 1; i < 21; i++) {
      last = await request('/api/upload/part', {
        method: 'POST',
        headers,
        body: JSON.stringify({ key: 'sources/test.mp4', uploadId: 'upload-id', partNumber: i + 1 }),
      });
    }

    expect(last.res.status).toBe(429);
    expect(last.body).toMatchObject({ error: 'rate limit exceeded', retryAfterSec: expect.any(Number) });
  });

  it('keys authenticated upload limits by user instead of sharing one client bucket', async () => {
    const firstUser = await register();
    const secondUser = await register();
    const sharedClientKey = `shared-client-${Math.random()}`;
    const firstHeaders = { Authorization: `Bearer ${firstUser.token}`, 'x-test-rate-limit-key': sharedClientKey };
    const secondHeaders = { Authorization: `Bearer ${secondUser.token}`, 'x-test-rate-limit-key': sharedClientKey };
    let last = await request('/api/upload/part', {
      method: 'POST',
      headers: firstHeaders,
      body: JSON.stringify({ key: 'sources/test.mp4', uploadId: 'upload-id', partNumber: 1 }),
    });
    expect(last.res.status).toBe(200);

    for (let i = 1; i < 21; i++) {
      last = await request('/api/upload/part', {
        method: 'POST',
        headers: firstHeaders,
        body: JSON.stringify({ key: 'sources/test.mp4', uploadId: 'upload-id', partNumber: i + 1 }),
      });
    }

    expect(last.res.status).toBe(429);

    const secondUserRequest = await request('/api/upload/part', {
      method: 'POST',
      headers: secondHeaders,
      body: JSON.stringify({ key: 'sources/test.mp4', uploadId: 'upload-id', partNumber: 1 }),
    });
    expect(secondUserRequest.res.status).toBe(200);
  });

  it('limits integration routes', async () => {
    const { token } = await register();
    const key = `integration-limit-${Math.random()}`;
    const headers = { Authorization: `Bearer ${token}`, 'x-test-rate-limit-key': key };
    let last = await request('/api/integrations/claude/test', { method: 'POST', headers });
    expect(last.res.status).toBe(400);

    for (let i = 1; i < 11; i++) {
      last = await request('/api/integrations/claude/test', { method: 'POST', headers });
    }

    expect(last.res.status).toBe(429);
    expect(last.body).toMatchObject({ error: 'rate limit exceeded', retryAfterSec: expect.any(Number) });
  });
});
