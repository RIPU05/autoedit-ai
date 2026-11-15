import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { db, prismaMock, queueAdds, resetDb, resetQueues } from './test-state.js';
import { resetUploadSessionsForTesting } from '../src/services/upload-session.service.js';

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
  enqueueRender: vi.fn(async () => ({ id: 'render-job-1' })),
  enqueueN8n: vi.fn(async () => ({ id: 'n8n-job-1' })),
  moveToDeadLetter: vi.fn(async () => undefined),
}));
vi.mock('../src/ffmpeg/probe.js', () => ({
  probe: vi.fn(async () => ({ durationSec: 10, width: 1920, height: 1080, fps: 30 })),
  detectSilences: vi.fn(async () => []),
  extractAudio: vi.fn(async (_f: string, out: string) => out),
}));
vi.mock('../src/services/integration-events.service.js', () => ({
  dispatchIntegrationEvent: vi.fn(async () => undefined),
  getConnectedClaudeApiKey: vi.fn(async () => undefined),
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

async function registerUser(name = 'Test User') {
  const email = `test-${Math.random().toString(16).slice(2)}@example.com`;
  const { body } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'x-test-rate-limit-key': email },
    body: JSON.stringify({ email, password: 'Password123!', name }),
  });
  return { email, token: body.token as string, user: body.user };
}

beforeAll(async () => {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (baseUrl && String(url).startsWith(baseUrl)) return realFetch(url, init);
    if (String(url).includes('s3.test/download')) return new Response(new Uint8Array([1, 2, 3]));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
  resetUploadSessionsForTesting();
  vi.mocked(global.fetch).mockClear();
});

describe('Critical Upload Object-Level Authorization (BOLA Regression Tests)', () => {
  // Test 1: Owner completes own upload
  it('1. Owner completes own upload successfully', async () => {
    const owner = await registerUser('Owner User');
    const headers = { Authorization: `Bearer ${owner.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });
    expect(start.res.status).toBe(200);

    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start.body.key,
        uploadId: start.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(complete.res.status).toBe(200);
    expect(complete.body.projectId).toBe(start.body.projectId);
    expect(db.projects.find((p) => p.id === start.body.projectId)?.status).toBe('UPLOADED');
  });

  // Test 2: Owner aborts own upload
  it('2. Owner aborts own upload successfully', async () => {
    const owner = await registerUser('Owner User');
    const headers = { Authorization: `Bearer ${owner.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });
    expect(start.res.status).toBe(200);

    const abort = await request('/api/upload/abort', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start.body.key,
        uploadId: start.body.uploadId,
      }),
    });

    expect(abort.res.status).toBe(200);
    expect(abort.body.ok).toBe(true);
    expect(db.projects.find((p) => p.id === start.body.projectId)?.status).toBe('FAILED');
  });

  // Test 3: User B attempts to complete User A's upload
  it("3. User B attempts to complete User A's upload (fails with 403 Forbidden)", async () => {
    const userA = await registerUser('User A');
    const userB = await registerUser('User B');

    const startA = await request('/api/upload/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.token}` },
      body: JSON.stringify({ filename: 'video_a.mp4', contentType: 'video/mp4' }),
    });
    expect(startA.res.status).toBe(200);

    const completeB = await request('/api/upload/complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userB.token}` },
      body: JSON.stringify({
        projectId: startA.body.projectId,
        key: startA.body.key,
        uploadId: startA.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(completeB.res.status).toBe(403);
    expect(completeB.body.error).toContain('forbidden: you do not own this project');
    // Ensure project A status remained UPLOADING and no assets or analysis jobs were created
    expect(db.projects.find((p) => p.id === startA.body.projectId)?.status).toBe('UPLOADING');
    expect(queueAdds.analysis.length).toBe(0);
  });

  // Test 4: User B attempts to abort User A's upload
  it("4. User B attempts to abort User A's upload (fails with 403 Forbidden)", async () => {
    const userA = await registerUser('User A');
    const userB = await registerUser('User B');

    const startA = await request('/api/upload/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.token}` },
      body: JSON.stringify({ filename: 'video_a.mp4', contentType: 'video/mp4' }),
    });
    expect(startA.res.status).toBe(200);

    const abortB = await request('/api/upload/abort', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userB.token}` },
      body: JSON.stringify({
        projectId: startA.body.projectId,
        key: startA.body.key,
        uploadId: startA.body.uploadId,
      }),
    });

    expect(abortB.res.status).toBe(403);
    expect(db.projects.find((p) => p.id === startA.body.projectId)?.status).toBe('UPLOADING');
  });

  // Test 5: Valid user with wrong project ID
  it('5. Valid user with wrong project ID (fails with 404 Project Not Found)', async () => {
    const user = await registerUser('User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });

    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: 'non_existent_project_id',
        key: start.body.key,
        uploadId: start.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(complete.res.status).toBe(404);
    expect(complete.body.error).toContain('project not found');
  });

  // Test 6: Valid user with substituted S3 key
  it('6. Valid user with substituted S3 key (fails with 403 or 400)', async () => {
    const user = await registerUser('User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });

    // Substituted key belonging to another user
    const substitutedKey = 'sources/other_user_id/12345/secret.mp4';
    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: substitutedKey,
        uploadId: start.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(complete.res.status).toBe(403);
    expect(complete.body.error).toContain('forbidden: s3 key does not belong to user');
  });

  // Test 7: Invalid upload ID
  it('7. Invalid upload ID matching session (fails with 400)', async () => {
    const user = await registerUser('User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });

    // Start a second upload to generate a different valid session
    const start2 = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video2.mp4', contentType: 'video/mp4' }),
    });

    // Use uploadId from start2 with projectId from start1
    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start2.body.key,
        uploadId: start2.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(complete.res.status).toBe(400);
    expect(complete.body.error).toContain('upload does not belong to this project');
  });

  // Test 7b: Non-existent or expired upload ID
  it('7b. Non-existent or expired upload ID (fails safely with 400 Bad Request)', async () => {
    const user = await registerUser('User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });

    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start.body.key,
        uploadId: 'completely_fake_or_expired_upload_id',
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(complete.res.status).toBe(400);
    expect(complete.body.error).toContain('upload session not found or expired');
  });

  // Test 8: Missing authentication
  it('8. Missing authentication (fails with 401 Unauthorized)', async () => {
    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers: {}, // No Authorization header
      body: JSON.stringify({
        projectId: 'project_1',
        key: 'sources/user_1/vid.mp4',
        uploadId: 'upload_1',
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(complete.res.status).toBe(401);
  });

  // Test 9: Already completed upload
  it('9. Already completed upload cannot be re-completed (fails with 409 Conflict)', async () => {
    const user = await registerUser('User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });

    // Manually mark project as already UPLOADED
    const proj = db.projects.find((p) => p.id === start.body.projectId);
    if (proj) proj.status = 'UPLOADED';

    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start.body.key,
        uploadId: start.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 1024,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });

    expect(complete.res.status).toBe(409);
    expect(complete.body.error).toContain('upload already completed');
  });

  // Test 10: Duplicate completion request
  it('10. Duplicate completion request (fails on second call with 409 Conflict)', async () => {
    const user = await registerUser('User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });

    const payload = {
      projectId: start.body.projectId,
      key: start.body.key,
      uploadId: start.body.uploadId,
      contentType: 'video/mp4',
      sizeBytes: 1024,
      parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
    };

    // First completion
    const complete1 = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    expect(complete1.res.status).toBe(200);

    // Second duplicate completion
    const complete2 = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    expect(complete2.res.status).toBe(409);
    expect(complete2.body.error).toContain('upload already completed');
  });
});
