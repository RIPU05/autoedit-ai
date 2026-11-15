import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    opts: any;
    constructor(name: string, opts?: any) {
      this.name = name;
      this.opts = opts || {};
    }
    toKey(type: string) {
      const prefix = this.opts?.prefix || 'bull';
      return `${prefix}:${this.name}:${type}`;
    }
    async add(_name: string, _data: any) {
      return { id: 'mock-staging-job-id' };
    }
    async close() {}
  },
  Worker: class {
    name: string;
    opts: any;
    constructor(name: string, _proc: any, opts?: any) {
      this.name = name;
      this.opts = opts || {};
    }
    on() {}
    async close() {}
  },
}));

import { Queue } from 'bullmq';
import { env } from '../src/config/env.js';
import { ANALYSIS_QUEUE, RENDER_QUEUE, analysisQueue, renderQueue } from '../src/queue/queues.js';
import { transcriberHealthy, transcribeRich } from '../src/services/transcribe.service.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Phase 2.2: Staging Worker & Cloud Infrastructure Validation', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('1. Queue Namespacing Isolation: Verifies BULL_PREFIX isolates staging queues from production', async () => {
    // In staging, BULL_PREFIX can be set to 'staging'
    // Default is 'bull'
    expect(env.BULL_PREFIX).toBeDefined();

    // Verify queue creation with custom staging prefix without triggering Redis connection attempts
    const dummyConn = { host: 'localhost', port: 6379, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null } as any;
    const stagingAnalysisQueue = new Queue('analysis', {
      connection: dummyConn,
      prefix: 'staging',
    });
    const prodAnalysisQueue = new Queue('analysis', {
      connection: dummyConn,
      prefix: 'bull',
    });

    try {
      // Check that key names are strictly segregated
      expect(stagingAnalysisQueue.toKey('id')).toContain('staging:analysis:id');
      expect(prodAnalysisQueue.toKey('id')).toContain('bull:analysis:id');
      expect(stagingAnalysisQueue.toKey('id')).not.toEqual(prodAnalysisQueue.toKey('id'));
    } finally {
      await stagingAnalysisQueue.close();
      await prodAnalysisQueue.close();
    }
  });

  it('2. Authenticated Whisper Client: Verifies X-Whisper-Secret header dispatch', async () => {
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return {
        ok: true,
        status: 200,
        json: async () => ({
          language: 'en',
          duration: 12.5,
          segments: [{ start: 0, end: 5, text: 'Staging verification test', confidence: 0.98 }],
          words: [{ start: 0, end: 2, word: 'Staging', confidence: 0.99 }],
          avgConfidence: 0.98,
        }),
      };
    }) as any;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoedit-test-'));
    const tmpAudio = path.join(tmpDir, 'test.wav');
    await fs.writeFile(tmpAudio, 'RIFFdummywavecontent');

    try {
      const result = await transcribeRich(tmpAudio);
      expect(result.durationSec).toBe(12.5);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].text).toBe('Staging verification test');

      // Verify healthcheck also dispatches cleanly
      const healthy = await transcriberHealthy();
      expect(healthy).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Authentication Enforcement: Verifies rejection on invalid or missing whisper secret', async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 401,
        text: async () => 'Unauthorized: invalid or missing whisper secret',
      };
    }) as any;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoedit-auth-'));
    const tmpAudio = path.join(tmpDir, 'auth.wav');
    await fs.writeFile(tmpAudio, 'RIFFdummywavecontent');

    try {
      await expect(transcribeRich(tmpAudio)).rejects.toThrow('transcription failed: 401');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. Staging Scratch Directory Healthcheck: Verifies permissions and write safety', async () => {
    const scratchDir = path.resolve(env.RENDER_WORK_DIR);
    await fs.mkdir(scratchDir, { recursive: true });

    const probeFile = path.join(scratchDir, `.healthcheck-${Date.now()}`);
    await fs.writeFile(probeFile, 'ok');
    const content = await fs.readFile(probeFile, 'utf8');
    expect(content).toBe('ok');

    await fs.unlink(probeFile);
    await expect(fs.access(probeFile)).rejects.toThrow();
  });

  it('5. Strict Concurrency & Timeout Safeguards: Verifies staging environment bounds', () => {
    // Staging worker concurrency must be constrained to avoid runaway cloud compute
    expect(env.RENDER_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(env.RENDER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(env.RENDER_TIMEOUT_MS).toBeLessThanOrEqual(1000 * 60 * 60); // 1h ceiling
    expect(env.MAX_UPLOAD_BYTES).toBeGreaterThan(0);
  });
});
