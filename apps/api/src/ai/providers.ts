import { env } from '../config/env.js';
import { runEditorialPipeline, type PipelineResult } from '../agents/orchestrator.js';
import type { VideoMeta, TranscriptCue, SilenceSegment } from '../services/claude.service.js';

export type AiProviderName = 'claude' | 'ollama' | 'fallback';

export interface AiProviderInput {
  meta: VideoMeta;
  transcript: TranscriptCue[];
  silences: SilenceSegment[];
  goal?: string;
  creatorProfile?: string;
  claudeApiKey?: string;
}

export interface AiProvider {
  name: AiProviderName;
  analyzeTranscript(input: AiProviderInput): Promise<PipelineResult>;
  generateTimeline(input: AiProviderInput): Promise<PipelineResult['operations']>;
  generateTitles(input: AiProviderInput): Promise<PipelineResult['suggestedTitles']>;
  generateCaptions(input: AiProviderInput): Promise<PipelineResult['captions']>;
  generateSocialCopy(input: AiProviderInput): Promise<PipelineResult['socialCopy']>;
}

export interface AiProviderResult {
  provider: AiProviderName;
  result: PipelineResult;
  fallback: boolean;
  reason?: string;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function isExternalAiUnavailable(err: unknown) {
  const message = errorMessage(err);
  return /(?:invalid x-api-key|authentication|api key|credit balance|billing|quota|rate.?limit|claude (?:401|402|403|429)|ollama|model|ECONNREFUSED|fetch failed|\b(?:401|402|403|429)\b)/i.test(
    message,
  );
}

function subtractSilences(start: number, end: number, silences: SilenceSegment[]) {
  let spans = [{ start, end }];
  for (const silence of silences) {
    spans = spans.flatMap((span) => {
      if (silence.end <= span.start || silence.start >= span.end) return [span];
      return [
        { start: span.start, end: Math.max(span.start, silence.start) },
        { start: Math.min(span.end, silence.end), end: span.end },
      ].filter((s) => s.end - s.start > 0.3);
    });
  }
  return spans;
}

export function buildFallbackPipelineResult(input: {
  meta: { durationSec: number };
  transcript: TranscriptCue[];
  silences: SilenceSegment[];
  reason: string;
}): PipelineResult {
  const captions = input.transcript.map((cue) => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
  }));
  const operations = input.transcript
    .flatMap((cue) =>
      subtractSilences(
        Math.max(0, Math.min(cue.start, input.meta.durationSec)),
        Math.max(0, Math.min(cue.end, input.meta.durationSec)),
        input.silences,
      ).map((span) => ({ ...span, label: cue.text.slice(0, 80) || 'Transcript segment' })),
    )
    .filter((op) => op.end > op.start)
    .sort((a, b) => a.start - b.start)
    .map((op, index) => ({ index, ...op, keep: true, zoom: 1 }));

  const fullText = input.transcript.map((cue) => cue.text).join(' ').trim();
  const summary = fullText || 'Fallback edit generated from transcript and silence detection.';
  const highlights = operations.map((op) => ({
    start: op.start,
    end: op.end,
    label: op.label,
    score: 0.5,
  }));

  return {
    summary,
    strategy: 'Fallback edit from transcript segments with detected silences removed.',
    reasoning: input.reason,
    highlights,
    speakers: [{ id: 'spk_1', label: 'Speaker 1', segments: operations.map((op) => ({ start: op.start, end: op.end })) }],
    captions,
    suggestedTitles: ['Auto-generated edit'],
    socialCopy: {
      instagram: 'Auto-generated edit',
      tiktok: 'Auto-generated edit',
      youtube: 'Auto-generated edit',
      linkedin: 'Auto-generated edit',
    },
    hook: {
      hook: operations[0]
        ? { start: operations[0].start, end: operations[0].end, text: operations[0].label }
        : { start: 0, end: Math.min(input.meta.durationSec, 5), text: 'Auto-generated edit' },
      alternatives: ['Auto-generated edit'],
    },
    thumbnail: { concept: 'Use the opening frame', overlayText: 'Auto edit', bestFrameSec: operations[0]?.start ?? 0 },
    operations,
    effects: {
      subtitles: true,
      zooms: false,
      transitions: 'none',
      music: false,
      metadata: { aiProvider: 'fallback', reason: input.reason },
    } as PipelineResult['effects'],
    agentLog: [{ agent: 'Fallback', ms: 0, summary: input.reason }],
    model: 'fallback',
  };
}

abstract class BaseProvider implements AiProvider {
  abstract name: AiProviderName;
  abstract analyzeTranscript(input: AiProviderInput): Promise<PipelineResult>;

  async generateTimeline(input: AiProviderInput) {
    return (await this.analyzeTranscript(input)).operations;
  }

  async generateTitles(input: AiProviderInput) {
    return (await this.analyzeTranscript(input)).suggestedTitles;
  }

  async generateCaptions(input: AiProviderInput) {
    return (await this.analyzeTranscript(input)).captions;
  }

  async generateSocialCopy(input: AiProviderInput) {
    return (await this.analyzeTranscript(input)).socialCopy;
  }
}

export class ClaudeProvider extends BaseProvider {
  name: AiProviderName = 'claude';

  analyzeTranscript(input: AiProviderInput) {
    return runEditorialPipeline({ ...input, apiKey: input.claudeApiKey });
  }
}

export class FallbackProvider extends BaseProvider {
  name: AiProviderName = 'fallback';

  analyzeTranscript(input: AiProviderInput) {
    return Promise.resolve(
      buildFallbackPipelineResult({
        meta: input.meta,
        transcript: input.transcript,
        silences: input.silences,
        reason: 'Claude unavailable',
      }),
    );
  }
}

function compactTranscript(transcript: TranscriptCue[]) {
  return transcript.map((cue) => ({
    start: cue.start,
    end: cue.end,
    text: cue.text,
    speaker: cue.speaker,
  }));
}

function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function requireArray(value: unknown, name: string) {
  if (!Array.isArray(value)) throw new Error(`Ollama response missing ${name}`);
  return value;
}

function requireObject(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Ollama response missing ${name}`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, fallback: string[]) {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : fallback;
}

function normalizeOllamaResult(raw: unknown, input: AiProviderInput): PipelineResult {
  const obj = requireObject(raw, 'root object');
  const transcriptText = input.transcript.map((cue) => cue.text).join(' ').trim();
  const operations = requireArray(obj.timelineOperations, 'timelineOperations').map((item, index) => {
    const op = requireObject(item, 'timeline operation');
    return {
      index: typeof op.index === 'number' ? op.index : index,
      start: typeof op.start === 'number' ? op.start : 0,
      end: typeof op.end === 'number' ? op.end : 0,
      label: typeof op.label === 'string' ? op.label : 'Ollama segment',
      keep: typeof op.keep === 'boolean' ? op.keep : true,
      zoom: typeof op.zoom === 'number' ? op.zoom : 1.08,
    };
  });

  const effects = requireObject(obj.effects, 'effects');
  const socialCopy = obj.socialCopy && typeof obj.socialCopy === 'object' ? (obj.socialCopy as Record<string, unknown>) : {};
  const hook = obj.hook && typeof obj.hook === 'object' ? (obj.hook as Record<string, unknown>) : {};
  const hookObj = hook.hook && typeof hook.hook === 'object' ? (hook.hook as Record<string, unknown>) : {};
  const thumbnail = obj.thumbnail && typeof obj.thumbnail === 'object' ? (obj.thumbnail as Record<string, unknown>) : {};
  const firstOperation = operations[0];
  const defaultTitle = transcriptText.split(/[.!?]/)[0]?.trim().slice(0, 70) || 'Auto-generated edit';
  const defaultCaptions = input.transcript.map((cue) => ({ start: cue.start, end: cue.end, text: cue.text }));

  return {
    summary: typeof obj.summary === 'string' ? obj.summary : transcriptText.slice(0, 500),
    strategy: typeof obj.strategy === 'string' ? obj.strategy : 'Local Ollama edit',
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : 'Generated locally with Ollama.',
    highlights: (Array.isArray(obj.highlights) ? obj.highlights : operations).map((item) => {
      const highlight = requireObject(item, 'highlight');
      return {
        start: typeof highlight.start === 'number' ? highlight.start : 0,
        end: typeof highlight.end === 'number' ? highlight.end : 0,
        label: typeof highlight.label === 'string' ? highlight.label : 'Highlight',
        score: typeof highlight.score === 'number' ? highlight.score : 0.6,
      };
    }),
    speakers: Array.isArray(obj.speakers)
      ? (obj.speakers as PipelineResult['speakers'])
      : [{ id: 'spk_1', label: 'Speaker 1', segments: operations.map((op) => ({ start: op.start, end: op.end })) }],
    captions: (Array.isArray(obj.captions) ? obj.captions : defaultCaptions).map((item) => {
      const caption = requireObject(item, 'caption');
      return {
        start: typeof caption.start === 'number' ? caption.start : 0,
        end: typeof caption.end === 'number' ? caption.end : 0,
        text: typeof caption.text === 'string' ? caption.text : '',
      };
    }),
    suggestedTitles: stringArray(obj.suggestedTitles, [defaultTitle]),
    socialCopy: {
      instagram: typeof socialCopy.instagram === 'string' ? socialCopy.instagram : defaultTitle,
      tiktok: typeof socialCopy.tiktok === 'string' ? socialCopy.tiktok : defaultTitle,
      youtube: typeof socialCopy.youtube === 'string' ? socialCopy.youtube : defaultTitle,
      linkedin: typeof socialCopy.linkedin === 'string' ? socialCopy.linkedin : defaultTitle,
    },
    hook: {
      hook: {
        start: typeof hookObj.start === 'number' ? hookObj.start : firstOperation?.start ?? 0,
        end: typeof hookObj.end === 'number' ? hookObj.end : firstOperation?.end ?? Math.min(input.meta.durationSec, 5),
        text: typeof hookObj.text === 'string' ? hookObj.text : firstOperation?.label ?? defaultTitle,
      },
      alternatives: stringArray((hook as Record<string, unknown>).alternatives, ['Auto-generated edit']),
    },
    thumbnail: {
      concept: typeof thumbnail.concept === 'string' ? thumbnail.concept : 'Use the opening frame',
      overlayText: typeof thumbnail.overlayText === 'string' ? thumbnail.overlayText : defaultTitle.slice(0, 24),
      bestFrameSec: typeof thumbnail.bestFrameSec === 'number' ? thumbnail.bestFrameSec : firstOperation?.start ?? 0,
    },
    operations,
    effects: {
      subtitles: typeof effects.subtitles === 'boolean' ? effects.subtitles : true,
      zooms: typeof effects.zooms === 'boolean' ? effects.zooms : true,
      transitions: effects.transitions === 'fade' ? 'fade' : 'none',
      music: typeof effects.music === 'boolean' ? effects.music : false,
      metadata: { aiProvider: 'ollama', model: env.OLLAMA_MODEL },
    } as PipelineResult['effects'],
    agentLog: [{ agent: 'Ollama', ms: 0, summary: `Generated locally with ${env.OLLAMA_MODEL}` }],
    model: `ollama:${env.OLLAMA_MODEL}`,
  };
}

export class OllamaProvider extends BaseProvider {
  name: AiProviderName = 'ollama';

  async analyzeTranscript(input: AiProviderInput) {
    const prompt = [
      'You are AutoEdit AI. Return strict JSON only, with no markdown.',
      'Create a compact edit plan using the real transcript and silence spans.',
      'Required JSON fields: summary, strategy, suggestedTitles, timelineOperations, effects.',
      'timelineOperations items must include index, start, end, label, keep, zoom.',
      'effects must include subtitles, zooms, transitions ("fade" or "none"), music.',
      'Keep the JSON short. Do not include explanations outside JSON.',
      '',
      JSON.stringify({
        project: { goal: input.goal, creatorProfile: input.creatorProfile },
        meta: input.meta,
        transcript: compactTranscript(input.transcript),
        silences: input.silences,
        targetFormats: ['shorts', 'reels', 'youtube'],
      }),
    ].join('\n');

    const started = Date.now();
    const res = await fetch(`${env.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_predict: 450 },
      }),
    });

    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    if (!data.response) throw new Error('Ollama response missing response text');
    const result = normalizeOllamaResult(parseJsonResponse(data.response), input);
    result.agentLog = [{ agent: 'Ollama', ms: Date.now() - started, summary: `Generated locally with ${env.OLLAMA_MODEL}` }];
    return result;
  }
}

export async function runAiProvider(input: AiProviderInput): Promise<AiProviderResult> {
  const selected: AiProvider =
    env.AI_PROVIDER === 'ollama' ? new OllamaProvider() : env.AI_PROVIDER === 'fallback' ? new FallbackProvider() : new ClaudeProvider();

  if (selected.name === 'fallback') {
    return { provider: 'fallback', result: await selected.analyzeTranscript(input), fallback: true, reason: 'AI_PROVIDER=fallback' };
  }

  try {
    return { provider: selected.name, result: await selected.analyzeTranscript(input), fallback: false };
  } catch (err) {
    const selectedName = selected.name === 'ollama' ? 'Ollama' : 'Claude';
    if (selected.name !== 'ollama' && !isExternalAiUnavailable(err)) throw err;
    const reason = `${selectedName} unavailable: ${errorMessage(err)}`;
    const result = buildFallbackPipelineResult({
      meta: input.meta,
      transcript: input.transcript,
      silences: input.silences,
      reason,
    });
    return { provider: 'fallback', result, fallback: true, reason };
  }
}
