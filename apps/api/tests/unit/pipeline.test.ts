import { describe, it, expect } from 'vitest';
import { buildKeepSegments } from '../../src/ffmpeg/pipeline.js';
import { withTimeout, retry } from '../../src/lib/observability.js';

describe('buildKeepSegments — silence inversion', () => {
  it('keeps spoken spans and drops silence', () => {
    const keep = buildKeepSegments(60, [
      { start: 10, end: 12 },
      { start: 30, end: 35 },
    ]);
    // spans: 0-10, 12-30, 35-60
    expect(keep).toHaveLength(3);
    expect(keep[0]).toMatchObject({ start: 0, end: 10 });
    expect(keep[2]).toMatchObject({ start: 35, end: 60 });
  });

  it('honors highlights-only mode for short-form', () => {
    const keep = buildKeepSegments(120, [], {
      highlightsOnly: [
        { start: 5, end: 20 },
        { start: 60, end: 75 },
      ],
    });
    expect(keep).toHaveLength(2);
    expect(keep[0].start).toBe(5);
  });

  it('drops sub-300ms slivers', () => {
    const keep = buildKeepSegments(10, [{ start: 0.1, end: 9.9 }]);
    // remaining spans 0-0.1 and 9.9-10 are both < 0.3s → dropped
    expect(keep).toHaveLength(0);
  });
});

describe('withTimeout', () => {
  it('resolves when under the limit', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });
  it('rejects when over the limit', async () => {
    const slow = new Promise((r) => setTimeout(r, 50));
    await expect(withTimeout(slow, 10, 'render')).rejects.toThrow(/timed out/);
  });
});

describe('retry', () => {
  it('succeeds after transient failures', async () => {
    let n = 0;
    const r = await retry(async () => {
      if (++n < 3) throw new Error('flaky');
      return n;
    }, 5, 1);
    expect(r).toBe(3);
  });
  it('rethrows after exhausting attempts', async () => {
    await expect(retry(async () => { throw new Error('always'); }, 2, 1)).rejects.toThrow('always');
  });
});
