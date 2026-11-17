import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { db, prismaMock, queueAdds, resetDb, resetQueues, storageMock } from './test-state.js';
import { resetUploadSessionsForTesting, setUploadSessionForTesting } from '../src/services/upload-session.service.js';

vi.mock('../src/storage/index.js', () => ({
  getStorageProvider: vi.fn(() => storageMock),
  createStorageProvider: vi.fn(() => storageMock),
  resolveStorageConfig: vi.fn(),
  setStorageProvider: vi.fn(),
}));
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
    headers: {
      'content-type': 'application/json',
      'x-test-rate-limit-key': `auth-test-${Math.random().toString(36).slice(2)}`,
      ...(init.headers ?? {}),
    },
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
  vi.clearAllMocks();
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

  // --- STEP 3B.2.1 AUTHORIZATION HARDENING TESTS ---

  // 1. Missing upload session on /part
  it('fails /part before storage access when upload session is missing', async () => {
    const user = await registerUser('Missing Session User');
    const headers = { Authorization: `Bearer ${user.token}` };
    const fakeKey = `sources/${user.user.id}/session-fake/video.mp4`;

    const res = await request('/api/upload/part', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: fakeKey, uploadId: 'non-existent-upload-id', partNumber: 1 }),
    });

    expect(res.res.status).toBe(400);
    expect(res.body.error).toContain('upload session not found or expired');
    expect(storageMock.presignUploadPart).not.toHaveBeenCalled();
  });

  // 2. Expired upload session on /part
  it('fails /part before storage access when upload session has expired', async () => {
    const user = await registerUser('Expired Session User');
    const headers = { Authorization: `Bearer ${user.token}` };
    const uploadId = 'expired-upload-id-123';
    const key = `sources/${user.user.id}/session-expired/video.mp4`;
    db.projects.push({
      id: 'proj-expired',
      userId: user.user.id,
      status: 'UPLOADING',
    });

    // Register session expired > 24 hours ago
    setUploadSessionForTesting({
      projectId: 'proj-expired',
      userId: user.user.id,
      uploadId,
      key,
      bucket: 'autoedit-test-bucket',
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
    });

    const res = await request('/api/upload/part', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key, uploadId, partNumber: 1, projectId: 'proj-expired' }),
    });

    expect(res.res.status).toBe(400);
    expect(res.body.error).toContain('upload session not found or expired');
    expect(storageMock.presignUploadPart).not.toHaveBeenCalled();
  });

  // 3. Missing upload session on /abort
  it('fails /abort before storage access when upload session is missing', async () => {
    const user = await registerUser('Abort Missing User');
    const headers = { Authorization: `Bearer ${user.token}` };
    const fakeKey = `sources/${user.user.id}/session-abort-fake/video.mp4`;

    const res = await request('/api/upload/abort', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: fakeKey, uploadId: 'non-existent-abort-upload-id' }),
    });

    expect(res.res.status).toBe(400);
    expect(res.body.error).toContain('upload session not found or expired');
    expect(storageMock.abortMultipartUpload).not.toHaveBeenCalled();
  });

  // 4. Foreign user's upload session
  it("fails /part and /abort before storage access when accessing another user's upload session", async () => {
    const userA = await registerUser('User A Foreign');
    const userB = await registerUser('User B Foreign');

    const startA = await request('/api/upload/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.token}` },
      body: JSON.stringify({ filename: 'video_a.mp4', contentType: 'video/mp4' }),
    });
    expect(startA.res.status).toBe(200);

    // User B tries to call /part using User A's upload session but User B's key
    const userBKey = `sources/${userB.user.id}/session-b/video_b.mp4`;
    const partRes = await request('/api/upload/part', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userB.token}` },
      body: JSON.stringify({ key: userBKey, uploadId: startA.body.uploadId, partNumber: 1 }),
    });
    expect(partRes.res.status).toBe(403);
    expect(partRes.body.error).toContain('forbidden: upload does not belong to user');
    expect(storageMock.presignUploadPart).not.toHaveBeenCalled();

    // User B tries to call /abort using User A's upload session
    const abortRes = await request('/api/upload/abort', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userB.token}` },
      body: JSON.stringify({ key: userBKey, uploadId: startA.body.uploadId }),
    });
    expect(abortRes.res.status).toBe(403);
    expect(abortRes.body.error).toContain('forbidden: upload does not belong to user');
    expect(storageMock.abortMultipartUpload).not.toHaveBeenCalled();
  });

  // 5. Session-key mismatch
  it('fails /part and /abort before storage access when session key does not match request key', async () => {
    const user = await registerUser('Mismatch Key User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video.mp4', contentType: 'video/mp4' }),
    });
    expect(start.res.status).toBe(200);

    const differentKey = `sources/${user.user.id}/different-session/other.mp4`;

    const partRes = await request('/api/upload/part', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: differentKey, uploadId: start.body.uploadId, partNumber: 1 }),
    });
    expect(partRes.res.status).toBe(400);
    expect(partRes.body.error).toContain('s3 key does not match upload session');
    expect(storageMock.presignUploadPart).not.toHaveBeenCalled();

    const abortRes = await request('/api/upload/abort', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: differentKey, uploadId: start.body.uploadId }),
    });
    expect(abortRes.res.status).toBe(400);
    expect(abortRes.body.error).toContain('s3 key does not match upload session');
    expect(storageMock.abortMultipartUpload).not.toHaveBeenCalled();
  });

  // 6. Session-project mismatch
  it('fails /part and /abort before storage access when session project does not match request project', async () => {
    const user = await registerUser('Mismatch Project User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start1 = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video1.mp4', contentType: 'video/mp4' }),
    });
    const start2 = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'video2.mp4', contentType: 'video/mp4' }),
    });

    const partRes = await request('/api/upload/part', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: start1.body.key,
        uploadId: start1.body.uploadId,
        projectId: start2.body.projectId,
        partNumber: 1,
      }),
    });
    expect(partRes.res.status).toBe(400);
    expect(partRes.body.error).toContain('upload does not belong to this project');
    expect(storageMock.presignUploadPart).not.toHaveBeenCalled();

    const abortRes = await request('/api/upload/abort', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: start1.body.key,
        uploadId: start1.body.uploadId,
        projectId: start2.body.projectId,
      }),
    });
    expect(abortRes.res.status).toBe(400);
    expect(abortRes.body.error).toContain('upload does not belong to this project');
    expect(storageMock.abortMultipartUpload).not.toHaveBeenCalled();
  });

  // 7. Malformed sources/ keys
  it('rejects malformed sources/ keys on /part and /abort before storage access', async () => {
    const user = await registerUser('Malformed Key User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const malformedKeys = [
      `sources/${user.user.id}/file.mp4`, // 3 segments
      `sources/${user.user.id}/session_123/extra_segment/file.mp4`, // 5 segments
      `sources/${user.user.id}/session_123/../../file.mp4`, // traversal
      `sources/${user.user.id}/session_123/%2e%2e/file.mp4`, // encoded traversal
      `sources//session_123/file.mp4`, // double slash
      `sources\\${user.user.id}\\session_123\\file.mp4`, // backslash
    ];

    for (const key of malformedKeys) {
      const partRes = await request('/api/upload/part', {
        method: 'POST',
        headers,
        body: JSON.stringify({ key, uploadId: 'any-upload-id', partNumber: 1 }),
      });
      expect(partRes.res.status).toBe(403);
      expect(storageMock.presignUploadPart).not.toHaveBeenCalled();

      const abortRes = await request('/api/upload/abort', {
        method: 'POST',
        headers,
        body: JSON.stringify({ key, uploadId: 'any-upload-id' }),
      });
      expect(abortRes.res.status).toBe(403);
      expect(storageMock.abortMultipartUpload).not.toHaveBeenCalled();
    }
  });

  // 8. Cross-project render lookup
  it('rejects cross-project render lookups and cross-project version modifications', async () => {
    const userA = await registerUser('User A Render');
    const userB = await registerUser('User B Render');

    const projA = { id: 'proj-a-render', userId: userA.user.id, status: 'READY', title: 'Project A' };
    const projB = { id: 'proj-b-render', userId: userB.user.id, status: 'READY', title: 'Project B' };
    db.projects.push(projA, projB);

    const renderB = {
      id: 'render-b-secret',
      projectId: projB.id,
      format: 'reel',
      status: 'COMPLETED',
      outputUrl: 'https://s3.test/renders/proj-b/reel.mp4',
    };
    db.renders.push(renderB);

    const versionB = {
      id: 'version-b-secret',
      projectId: projB.id,
      name: 'Original Version B',
      timelineJson: {},
    };
    db.versions.push(versionB);

    // User A tries to view Project B's render via Project A's route
    const renderRes = await request(`/api/projects/${projA.id}/renders/${renderB.id}`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    expect(renderRes.res.status).toBe(404);
    expect(renderRes.body.error).toContain('render not found');

    // User A tries to rename Project B's version via Project A's route
    const versionRes = await request(`/api/projects/${projA.id}/versions/${versionB.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userA.token}` },
      body: JSON.stringify({ name: 'Hacked Version Name' }),
    });
    expect(versionRes.res.status).toBe(404);
    expect(versionRes.body.error).toContain('version not found');
    expect(db.versions.find((v) => v.id === versionB.id)?.name).toBe('Original Version B');
  });

  // 9. Missing authentication on /part and /abort
  it('rejects unauthenticated requests on /part and /abort', async () => {
    const partRes = await request('/api/upload/part', {
      method: 'POST',
      body: JSON.stringify({ key: 'sources/u1/sess/v.mp4', uploadId: 'up-1', partNumber: 1 }),
    });
    expect(partRes.res.status).toBe(401);
    expect(storageMock.presignUploadPart).not.toHaveBeenCalled();

    const abortRes = await request('/api/upload/abort', {
      method: 'POST',
      body: JSON.stringify({ key: 'sources/u1/sess/v.mp4', uploadId: 'up-1' }),
    });
    expect(abortRes.res.status).toBe(401);
    expect(storageMock.abortMultipartUpload).not.toHaveBeenCalled();
  });

  // 10. Valid multipart upload workflow continues to work
  it('preserves valid multipart upload flow through storage provider', async () => {
    const user = await registerUser('Valid Flow User');
    const headers = { Authorization: `Bearer ${user.token}` };

    const start = await request('/api/upload/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'valid_video.mp4', contentType: 'video/mp4' }),
    });
    expect(start.res.status).toBe(200);
    expect(start.body.uploadId).toBeDefined();

    const part = await request('/api/upload/part', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: start.body.key,
        uploadId: start.body.uploadId,
        partNumber: 1,
        projectId: start.body.projectId,
      }),
    });
    expect(part.res.status).toBe(200);
    expect(part.body.url).toContain('s3.test');
    expect(storageMock.presignUploadPart).toHaveBeenCalledWith({
      key: start.body.key,
      uploadId: start.body.uploadId,
      partNumber: 1,
    });

    const complete = await request('/api/upload/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: start.body.projectId,
        key: start.body.key,
        uploadId: start.body.uploadId,
        contentType: 'video/mp4',
        sizeBytes: 2048,
        parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
      }),
    });
    expect(complete.res.status).toBe(200);
    expect(complete.body.projectId).toBe(start.body.projectId);
    expect(storageMock.completeMultipartUpload).toHaveBeenCalledWith({
      key: start.body.key,
      uploadId: start.body.uploadId,
      parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
    });
  });
});
