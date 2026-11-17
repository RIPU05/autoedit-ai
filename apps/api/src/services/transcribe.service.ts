import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TranscriptCue } from './claude.service.js';
import { env } from '../config/env.js';
import { retry, withTimeout } from '../lib/observability.js';

export interface TranscriptionResult {
  language: string;
  durationSec: number;
  segments: { start: number; end: number; text: string; speaker?: string; confidence?: number }[];
  words: { start: number; end: number; word: string; confidence?: number }[];
  avgConfidence: number | null;
  model: string;
}

export interface TranscribeOptions {
  retries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

/**
 * Transcribe via the faster-whisper sidecar (services/whisper).
 * Returns segment cues + word-level timestamps + confidence scores.
 * `language`: 'en' | 'hi' | 'hinglish' | undefined (auto-detect).
 * Wrapped in bounded retry + timeout for reliability.
 */
export async function transcribeRich(
  audioPath: string,
  language?: string,
  opts?: TranscribeOptions,
): Promise<TranscriptionResult> {
  const attempts = opts?.retries ?? 3;
  const baseMs = opts?.retryBaseMs ?? (env.NODE_ENV === 'test' ? 100 : 800);
  const timeoutMs = opts?.timeoutMs ?? (env.NODE_ENV === 'test' ? 60000 : 1000 * 60 * 30);
  const baseUrl = opts?.baseUrl ?? env.WHISPER_URL;

  return retry(
    async () => {
      const buf = await fs.readFile(audioPath);
      const form = new FormData();
      form.append('file', new Blob([buf]), path.basename(audioPath));
      if (language) form.append('language', language);

      const res = await withTimeout(
        fetch(`${baseUrl}/transcribe`, { method: 'POST', body: form }),
        timeoutMs,
        'transcription',
      );
      if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`);

      const data = (await res.json()) as Omit<TranscriptionResult, 'model'> & { duration: number };
      return {
        language: data.language,
        durationSec: (data as any).duration ?? data.durationSec,
        segments: data.segments ?? [],
        words: data.words ?? [],
        avgConfidence: data.avgConfidence ?? null,
        model: env.WHISPER_MODEL ?? 'base',
      };
    },
    attempts,
    baseMs,
  );
}

/** Back-compat: callers that only need cues for Claude. */
export async function transcribe(
  audioPath: string,
  language?: string,
  opts?: TranscribeOptions,
): Promise<TranscriptCue[]> {
  const r = await transcribeRich(audioPath, language, opts);
  return r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker }));
}

export async function transcriberHealthy(baseUrl?: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await withTimeout(
      fetch(`${baseUrl ?? env.WHISPER_URL}/health`),
      timeoutMs,
      'whisper-health',
    );
    return res.ok;
  } catch {
    return false;
  }
}
