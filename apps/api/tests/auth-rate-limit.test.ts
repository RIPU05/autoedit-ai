import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { db, prismaMock, resetDb } from './test-state.js';

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../src/lib/redis.js', () => ({
  connection: { ping: vi.fn(async () => 'PONG') },
  bullConnection: {},
}));
vi.mock('../src/queue/queues.js', () => ({
  ANALYSIS_QUEUE: 'analysis',
  RENDER_QUEUE: 'render',
  N8N_QUEUE: 'n8n-dispatch',
  analysisQueue: { getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })) },
  renderQueue: { getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })) },
  n8nQueue: { getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })) },
  enqueueAnalysis: vi.fn(async () => ({ id: 'analysis-job-1' })),
  enqueueRender: vi.fn(async () => ({ id: 'render-job-1' })),
  enqueueN8n: vi.fn(async () => ({ id: 'n8n-job-1' })),
  moveToDeadLetter: vi.fn(async () => undefined),
}));

import { ResilientRedisRateLimitStore } from '../src/middleware/rateLimit.js';

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

beforeAll(async () => {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (baseUrl && String(url).startsWith(baseUrl)) return realFetch(url, init);
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
  vi.mocked(global.fetch).mockClear();
});

describe('Authentication Rate Limiting Reliability', () => {
  it('allows normal registration followed by immediate /auth/me without lockout', async () => {
    const email = `reg-me-${Math.random().toString(16).slice(2)}@example.com`;
    const regRes = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'x-test-rate-limit-key': email },
      body: JSON.stringify({ email, password: 'Password123!', name: 'Immediate Session User' }),
    });

    expect(regRes.res.status).toBe(200);
    const token = regRes.body.token;

    // Immediately fetch /auth/me multiple times (simulating frontend page mount and hooks)
    for (let i = 0; i < 5; i++) {
      const meRes = await request('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-test-rate-limit-key': email,
        },
      });
      expect(meRes.res.status).toBe(200);
      expect(meRes.body.user.email).toBe(email);
    }
  });

  it('rate-limits repeated login attempts and returns retry information', async () => {
    const key = `brute-force-${Math.random().toString(16).slice(2)}`;
    let lastRes: any = null;

    // In test mode, login limit is 5 attempts per window
    for (let i = 0; i < 6; i++) {
      lastRes = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'x-test-rate-limit-key': key },
        body: JSON.stringify({ email: 'target@example.com', password: `WrongPassword${i}!` }),
      });
    }

    expect(lastRes.res.status).toBe(429);
    expect(lastRes.body).toMatchObject({
      error: 'rate limit exceeded',
      retryAfterSec: expect.any(Number),
    });
    expect(lastRes.body.retryAfterSec).toBeGreaterThan(0);
  });

  it('ResilientRedisRateLimitStore gracefully falls back to in-memory store and decrements/resets correctly', async () => {
    const store = new ResilientRedisRateLimitStore('test-store', 5000);
    const key = 'test-client-key';

    const first = await store.increment(key);
    expect(first.totalHits).toBe(1);

    const second = await store.increment(key);
    expect(second.totalHits).toBe(2);

    await store.decrement(key);
    const third = await store.increment(key);
    expect(third.totalHits).toBe(2);

    await store.resetKey(key);
    const afterReset = await store.increment(key);
    expect(afterReset.totalHits).toBe(1);
  });
});
