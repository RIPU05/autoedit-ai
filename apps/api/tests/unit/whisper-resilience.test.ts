import { describe, expect, it, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { transcribeRich, transcriberHealthy } from '../../src/services/transcribe.service.js';
import { buildFallbackPipelineResult } from '../../src/ai/providers.js';

describe('Whisper Resilience & Transcription Error Handling (Step 2C)', () => {
  const dummyAudioPath = path.resolve(process.cwd(), 'tmp', 'dummy-test-audio.wav');

  beforeEach(async () => {
    vi.restoreAllMocks();
    await fs.mkdir(path.dirname(dummyAudioPath), { recursive: true });
    await fs.writeFile(dummyAudioPath, Buffer.from('RIFF....WAVEfmt ....data....'));
  });

  it('2. handles Whisper connection refused (ECONNREFUSED) with bounded retries', async () => {
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      const err = new TypeError('fetch failed');
      (err as any).cause = { code: 'ECONNREFUSED' };
      throw err;
    });

    await expect(
      transcribeRich(dummyAudioPath, undefined, { retries: 2, retryBaseMs: 10 }),
    ).rejects.toThrow(/fetch failed/);

    expect(callCount).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('3. handles Whisper request timeout with bounded retries', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      // simulate delay exceeding timeout
      await new Promise((r) => setTimeout(r, 80));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await expect(
      transcribeRich(dummyAudioPath, undefined, { retries: 2, retryBaseMs: 10, timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/i);

    expect(callCount).toBe(2);
  });

  it('4. handles Whisper HTTP 500 error with bounded retries', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return new Response('Internal Server Error in Whisper sidecar', { status: 500 });
    });

    await expect(
      transcribeRich(dummyAudioPath, undefined, { retries: 2, retryBaseMs: 10 }),
    ).rejects.toThrow(/transcription failed: 500/);

    expect(callCount).toBe(2);
  });

  it('5. creates explicit unavailable-transcript state when Whisper fails', () => {
    const fallbackResult = buildFallbackPipelineResult({
      meta: { durationSec: 30 },
      transcript: [], // Empty because Whisper was unavailable
      silences: [],
      reason: 'Whisper service unavailable (ECONNREFUSED)',
    });

    expect(fallbackResult.model).toBe('fallback');
    expect(fallbackResult.captions).toEqual([]);
    expect(fallbackResult.effects.subtitles).toBe(false);
    expect(fallbackResult.operations.length).toBeGreaterThan(0);
    expect(fallbackResult.operations[0].end).toBe(30);
  });

  it('6. performs legitimate silence-only analysis when speech transcript is unavailable', () => {
    const silences = [
      { start: 5, end: 8 },
      { start: 20, end: 23 },
    ];

    const result = buildFallbackPipelineResult({
      meta: { durationSec: 30 },
      transcript: [], // Speech transcript unavailable
      silences,
      reason: 'Whisper service offline',
    });

    // Should create active audio operations subtracting the silences
    expect(result.captions).toEqual([]);
    expect(result.effects.subtitles).toBe(false);
    expect(result.summary).toContain('Degraded audio analysis generated using silence detection');
    expect(result.strategy).toContain('Silence-based edit');
    expect(result.operations.length).toBe(3);

    // Spans: [0, 5], [8, 20], [23, 30]
    expect(result.operations[0].start).toBe(0);
    expect(result.operations[0].end).toBe(5);
    expect(result.operations[1].start).toBe(8);
    expect(result.operations[1].end).toBe(20);
    expect(result.operations[2].start).toBe(23);
    expect(result.operations[2].end).toBe(30);
  });

  it('7. ensures corrupt media fails and is not turned into successful processing', async () => {
    const { probe } = await import('../../src/ffmpeg/probe.js');
    const corruptFilePath = path.resolve(process.cwd(), 'tmp', 'corrupt-media-test.mp4');
    await fs.writeFile(corruptFilePath, Buffer.from('NOT_A_VALID_MP4_HEADER_CORRUPT_BYTES_123456789'));

    await expect(probe(corruptFilePath)).rejects.toThrow();
  });

  it('verifies transcriberHealthy probe handling', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      return new Response(JSON.stringify({ ok: true, model: 'base' }), { status: 200 });
    });
    expect(await transcriberHealthy('http://127.0.0.1:9000')).toBe(true);

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await transcriberHealthy('http://127.0.0.1:9999')).toBe(false);
  });
});
