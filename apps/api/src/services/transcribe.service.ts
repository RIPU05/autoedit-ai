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

/**
 * Transcribe via the faster-whisper sidecar (services/whisper).
 * Returns segment cues + word-level timestamps + confidence scores.
 * `language`: 'en' | 'hi' | 'hinglish' | undefined (auto-detect).
 * Wrapped in retry + timeout for reliability.
 */
export async function transcribeRich(audioPath: string, language?: string): Promise<TranscriptionResult> {
  return retry(async () => {
    const buf = await fs.readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([buf]), path.basename(audioPath));
    if (language) form.append('language', language);

    const res = await withTimeout(
      fetch(`${env.WHISPER_URL}/transcribe`, { method: 'POST', body: form }),
      1000 * 60 * 30, // 30 min ceiling for long podcasts
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
  }, 3);
}

/** Back-compat: callers that only need cues for Claude. */
export async function transcribe(audioPath: string, language?: string): Promise<TranscriptCue[]> {
  const r = await transcribeRich(audioPath, language);
  return r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker }));
}

export async function transcriberHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${env.WHISPER_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
