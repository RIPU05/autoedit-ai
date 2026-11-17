import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { transcribeRich, transcribe, transcriberHealthy } from '../../src/services/transcribe.service.js';

describe('Whisper Live Sidecar Integration (Step 2C)', () => {
  const speechWav = path.resolve(process.cwd(), 'tmp', 'test-speech.wav');
  const WHISPER_LOCAL_URL = 'http://127.0.0.1:9000';

  it('verifies Whisper sidecar health probe', async () => {
    const isHealthy = await transcriberHealthy(WHISPER_LOCAL_URL);
    expect(isHealthy).toBe(true);
  });

  it('1. performs real speech transcription with known spoken words', async () => {
    const exists = await fs
      .stat(speechWav)
      .then((s) => s.isFile())
      .catch(() => false);
    expect(exists).toBe(true);

    const result = await transcribeRich(speechWav, 'en', {
      baseUrl: WHISPER_LOCAL_URL,
      retries: 2,
    });

    // 1. Language & duration
    expect(result.language).toBe('en');
    expect(result.durationSec).toBeGreaterThan(3);

    // 2. Segments & text
    expect(result.segments.length).toBeGreaterThanOrEqual(1);
    const fullText = result.segments.map((s) => s.text).join(' ');
    expect(fullText.toLowerCase()).toContain('welcome');
    expect(fullText.toLowerCase()).toContain('auto');
    expect(fullText.toLowerCase()).toContain('edit');
    expect(fullText.toLowerCase()).toContain('transcription');
    expect(fullText.toLowerCase()).toContain('prompt');

    // 3. Word-level timestamps & confidence
    expect(result.words.length).toBeGreaterThan(5);
    const firstWord = result.words[0];
    expect(firstWord).toHaveProperty('start');
    expect(firstWord).toHaveProperty('end');
    expect(firstWord).toHaveProperty('word');
    expect(firstWord.start).toBeLessThan(firstWord.end);

    // 4. Model recorded
    expect(result.model).toBeDefined();
    expect(typeof result.avgConfidence).toBe('number');
  });

  it('verifies transcribe() helper returns cues with start, end, text', async () => {
    const cues = await transcribe(speechWav, 'en', {
      baseUrl: WHISPER_LOCAL_URL,
      retries: 2,
    });

    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues[0]).toHaveProperty('start');
    expect(cues[0]).toHaveProperty('end');
    expect(cues[0]).toHaveProperty('text');
    expect(cues[0].text.length).toBeGreaterThan(0);
  });
});
