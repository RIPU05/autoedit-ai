import { z } from 'zod';
import { env } from '../config/env.js';
import { runEditorialPipeline, type PipelineResult } from '../agents/orchestrator.js';
import type { VideoMeta, TranscriptCue, SilenceSegment } from '../services/claude.service.js';

export type AiProviderName = 'claude' | 'ollama' | 'fallback';

export type AiErrorCategory =
  | 'MISSING_CREDENTIALS'
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'CONNECTION'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'INVALID_OPERATION'
  | 'PROGRAMMING_ERROR'
  | 'INVALID_CONFIGURATION';

export class AiProviderError extends Error {
  readonly category: AiErrorCategory;
  readonly provider: AiProviderName;
  readonly status?: number;
  readonly isFallbackEligible: boolean;

  constructor(opts: {
    message: string;
    category: AiErrorCategory;
    provider: AiProviderName;
    status?: number;
    cause?: unknown;
    isFallbackEligible?: boolean;
  }) {
    super(opts.message);
    this.name = 'AiProviderError';
    this.category = opts.category;
    this.provider = opts.provider;
    this.status = opts.status;
    this.isFallbackEligible =
      opts.isFallbackEligible ??
      (opts.category !== 'PROGRAMMING_ERROR' && opts.category !== 'INVALID_CONFIGURATION');
    if (opts.cause) this.cause = opts.cause;
  }
}

export interface AiProviderInput {
  meta: VideoMeta;
  transcript: TranscriptCue[];
  silences: SilenceSegment[];
  goal?: string;
  creatorProfile?: string;
  claudeApiKey?: string;
  provider?: string;
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
  category?: AiErrorCategory;
  reason?: string;
}

export function sanitizeLogSecret(input: string): string {
  if (typeof input !== 'string') return String(input);
  return input
    .replace(/sk-ant-[a-zA-Z0-9_-]{15,}/g, 'sk-ant-***')
    .replace(/Bearer\s+[a-zA-Z0-9_.-]{15,}/gi, 'Bearer ***')
    .replace(/(?:api[_-]?key[:=]\s*)["']?[a-zA-Z0-9_.-]{15,}["']?/gi, 'apiKey=***');
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

let cachedInvalidApiKey: string | null = null;

export function markApiKeyInvalid(key?: string) {
  if (key) cachedInvalidApiKey = key;
}

export function isApiKeyMarkedInvalid(key?: string): boolean {
  if (!key) return false;
  return cachedInvalidApiKey === key;
}

export function resetInvalidApiKeyCache() {
  cachedInvalidApiKey = null;
}

export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const name = anyErr?.name ?? '';
  const code = anyErr?.code ?? anyErr?.cause?.code;
  const msg = errorMessage(err);

  return (
    name === 'TimeoutError' ||
    name === 'APIConnectionTimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /timeout|timed? ?out|ETIMEDOUT/i.test(msg)
  );
}

export function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const name = anyErr?.name ?? '';
  const code = anyErr?.code ?? anyErr?.cause?.code;
  const msg = errorMessage(err);

  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  if (
    code &&
    /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|UND_ERR_)/i.test(String(code))
  ) {
    return true;
  }
  if (name === 'TypeError' && (msg === 'fetch failed' || anyErr?.cause?.code)) {
    return true;
  }
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|connection error/i.test(msg);
}

export function isAuthenticationError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  if (anyErr.status === 401 || anyErr.name === 'AuthenticationError') return true;
  const message = errorMessage(err);
  return /(?:invalid x-api-key|authentication_error|401 unauthorized|invalid api key)/i.test(message);
}

export function isExternalAiUnavailable(err: unknown) {
  if (!err) return false;
  if (err instanceof TypeError || err instanceof ReferenceError) {
    if (!isNetworkError(err)) return false;
  }
  const anyErr = err as any;
  if (
    anyErr.status === 401 ||
    anyErr.status === 402 ||
    anyErr.status === 403 ||
    anyErr.status === 429 ||
    anyErr.status === 500 ||
    anyErr.status === 502 ||
    anyErr.status === 503 ||
    anyErr.status === 504
  ) {
    return true;
  }
  if (
    anyErr.name === 'AuthenticationError' ||
    anyErr.name === 'RateLimitError' ||
    anyErr.name === 'APIConnectionError' ||
    anyErr.name === 'APIConnectionTimeoutError'
  ) {
    return true;
  }
  if (isNetworkError(err)) {
    return true;
  }
  const message = errorMessage(err);
  return /(?:invalid x-api-key|authentication|credit balance|billing|quota|rate.?limit|claude (?:401|402|403|429)|\b(?:401|402|403|429)\b)/i.test(
    message,
  );
}

export function classifyAiError(err: unknown, provider: AiProviderName = 'fallback'): AiProviderError {
  if (err instanceof AiProviderError) return err;

  const msg = errorMessage(err);
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  const name = (err as any)?.name ?? '';

  // 1. Invalid configuration errors
  if ((err as any)?.category === 'INVALID_CONFIGURATION' || /unknown (?:or unsupported )?ai provider/i.test(msg)) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'INVALID_CONFIGURATION',
      provider,
      cause: err,
      isFallbackEligible: false,
    });
  }

  // 2. ReferenceError is always a programming defect
  if (err instanceof ReferenceError) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'PROGRAMMING_ERROR',
      provider,
      cause: err,
      isFallbackEligible: false,
    });
  }

  // 3. TypeError: differentiate network TypeError (e.g. Node fetch failed) from programming TypeError
  if (err instanceof TypeError) {
    if (isNetworkError(err)) {
      const isTimeout = isTimeoutError(err);
      return new AiProviderError({
        message: sanitizeLogSecret(msg),
        category: isTimeout ? 'TIMEOUT' : 'CONNECTION',
        provider,
        status: isTimeout ? 504 : 503,
        cause: err,
        isFallbackEligible: true,
      });
    }

    // Genuine programming TypeError (e.g. Cannot read properties of undefined, x is not a function)
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'PROGRAMMING_ERROR',
      provider,
      cause: err,
      isFallbackEligible: false,
    });
  }

  // 4. Authentication errors (401)
  if (status === 401 || isAuthenticationError(err)) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'AUTHENTICATION',
      provider,
      status: 401,
      cause: err,
      isFallbackEligible: true,
    });
  }

  // 5. Rate limit errors (429)
  if (status === 429 || name === 'RateLimitError' || /rate.?limit/i.test(msg)) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'RATE_LIMIT',
      provider,
      status: 429,
      cause: err,
      isFallbackEligible: true,
    });
  }

  // 6. Timeout errors (504, TimeoutError, AbortError, ETIMEDOUT)
  if (
    status === 504 ||
    name === 'APIConnectionTimeoutError' ||
    name === 'TimeoutError' ||
    isTimeoutError(err)
  ) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'TIMEOUT',
      provider,
      status: 504,
      cause: err,
      isFallbackEligible: true,
    });
  }

  // 7. Connection errors (503, ECONNREFUSED, ENOTFOUND, network errors)
  if (
    status === 503 ||
    status === 502 ||
    name === 'APIConnectionError' ||
    isNetworkError(err)
  ) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'CONNECTION',
      provider,
      status: typeof status === 'number' ? status : 503,
      cause: err,
      isFallbackEligible: true,
    });
  }

  // 8. Output validation errors (ZodError)
  if (err instanceof z.ZodError) {
    const isOperationIssue = err.issues.some((issue) =>
      issue.path.includes('operations') ||
      issue.path.includes('highlights') ||
      issue.path.includes('captions') ||
      issue.path.includes('speakers') ||
      issue.path.includes('hook') ||
      issue.path.includes('thumbnail') ||
      issue.message.includes('exceeds video duration') ||
      issue.message.includes('greater than start')
    );
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: isOperationIssue ? 'INVALID_OPERATION' : 'MALFORMED_RESPONSE',
      provider,
      cause: err,
      isFallbackEligible: provider !== 'fallback',
    });
  }

  // 9. Malformed JSON parse errors (SyntaxError during JSON.parse)
  if (err instanceof SyntaxError && /JSON/i.test(msg)) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'MALFORMED_RESPONSE',
      provider,
      cause: err,
      isFallbackEligible: true,
    });
  }

  // 10. Explicit timeline operations bounds violation in message
  if (/operation.*exceed|invalid timeline|end <= start|negative/i.test(msg)) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'INVALID_OPERATION',
      provider,
      cause: err,
      isFallbackEligible: true,
    });
  }

  // 11. Known external HTTP error status
  if (typeof status === 'number' && [500, 502, 503, 504].includes(status)) {
    return new AiProviderError({
      message: sanitizeLogSecret(msg),
      category: 'CONNECTION',
      provider,
      status,
      cause: err,
      isFallbackEligible: true,
    });
  }

  // 12. Other unknown errors: fail closed! Do not automatically classify as recoverable malformed response.
  return new AiProviderError({
    message: sanitizeLogSecret(msg),
    category: 'PROGRAMMING_ERROR',
    provider,
    cause: err,
    isFallbackEligible: false,
  });
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

export const FP_TOLERANCE_SEC = 0.05; // 50ms explicit floating-point tolerance for frame rounding

export function buildFallbackPipelineResult(input: {
  meta: { durationSec: number };
  transcript: TranscriptCue[];
  silences: SilenceSegment[];
  reason: string;
}): PipelineResult {
  const dur = Math.max(0.1, input.meta.durationSec);

  if (input.transcript.length === 0) {
    const activeSpans =
      Array.isArray(input.silences) && input.silences.length > 0
        ? subtractSilences(0, dur, input.silences)
        : [];

    if (activeSpans.length > 0) {
      const operations = activeSpans.map((span, index) => ({
        index,
        start: span.start,
        end: span.end,
        label: `Active audio segment ${index + 1}`,
        keep: true,
        zoom: 1,
      }));
      const highlights = operations.map((op) => ({
        start: op.start,
        end: op.end,
        label: op.label,
        score: 0.5,
      }));

      const hookStart = operations[0].start;
      const hookEnd = Math.min(
        operations[0].end,
        hookStart + Math.max(0.5, Math.min(5, operations[0].end - hookStart)),
      );

      return {
        summary: 'Degraded audio analysis generated using silence detection (speech transcript unavailable).',
        strategy: 'Silence-based edit keeping active audio segments with detected pauses removed.',
        reasoning: input.reason,
        highlights,
        speakers: [{ id: 'spk_1', label: 'Speaker 1', segments: operations.map((op) => ({ start: op.start, end: op.end })) }],
        captions: [],
        suggestedTitles: ['Auto-generated edit (silence-trimmed)'],
        socialCopy: {
          instagram: 'Auto-generated edit (silence-trimmed)',
          tiktok: 'Auto-generated edit (silence-trimmed)',
          youtube: 'Auto-generated edit (silence-trimmed)',
          linkedin: 'Auto-generated edit (silence-trimmed)',
        },
        hook: {
          hook: { start: hookStart, end: hookEnd, text: operations[0].label },
          alternatives: ['Auto-generated edit'],
        },
        thumbnail: { concept: 'Use the opening frame', overlayText: 'Auto edit', bestFrameSec: operations[0]?.start ?? 0 },
        operations,
        effects: {
          subtitles: false,
          zooms: false,
          transitions: 'none',
          music: false,
          metadata: { aiProvider: 'fallback', reason: input.reason, degradedAudio: true, transcriptUnavailable: true },
        } as PipelineResult['effects'],
        agentLog: [{ agent: 'Fallback', ms: 0, summary: 'Speech transcript unavailable; performed degraded silence-based edit.' }],
        model: 'fallback',
      };
    }

    const end = dur;
    const hookEnd = Math.min(end, Math.max(0.5, Math.min(5, end)));
    return {
      summary: 'Fallback edit generated from video-only media with no audio transcript.',
      strategy: 'Fallback edit keeps the full video because no audio transcript is available.',
      reasoning: input.reason,
      highlights: [{ start: 0, end, label: 'Video-only segment', score: 0.5 }],
      speakers: [],
      captions: [],
      suggestedTitles: ['Auto-generated edit'],
      socialCopy: {
        instagram: 'Auto-generated edit',
        tiktok: 'Auto-generated edit',
        youtube: 'Auto-generated edit',
        linkedin: 'Auto-generated edit',
      },
      hook: { hook: { start: 0, end: hookEnd, text: 'Auto-generated edit' }, alternatives: ['Auto-generated edit'] },
      thumbnail: { concept: 'Use the opening frame', overlayText: 'Auto edit', bestFrameSec: 0 },
      operations: [{ index: 0, start: 0, end, label: 'Video-only segment', keep: true, zoom: 1 }],
      effects: {
        subtitles: false,
        zooms: false,
        transitions: 'none',
        music: false,
        metadata: { aiProvider: 'fallback', reason: input.reason, noAudio: true },
      } as PipelineResult['effects'],
      agentLog: [{ agent: 'Fallback', ms: 0, summary: 'No audio transcript available; kept video content.' }],
      model: 'fallback',
    };
  }

  const captions = input.transcript
    .filter((cue) => cue.end > cue.start)
    .map((cue) => ({
      start: Math.max(0, Math.min(cue.start, input.meta.durationSec)),
      end: Math.max(0, Math.min(cue.end, input.meta.durationSec)),
      text: cue.text,
    }))
    .filter((cue) => cue.end > cue.start);

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

  if (operations.length === 0) {
    operations.push({
      index: 0,
      start: 0,
      end: dur,
      label: 'Full segment',
      keep: true,
      zoom: 1,
    });
  }

  const fullText = input.transcript.map((cue) => cue.text).join(' ').trim();
  const summary = fullText || 'Fallback edit generated from transcript and silence detection.';
  const highlights = operations.map((op) => ({
    start: op.start,
    end: op.end,
    label: op.label,
    score: 0.5,
  }));

  const hookStart = operations[0] ? operations[0].start : 0;
  const hookEnd = operations[0]
    ? Math.min(operations[0].end, hookStart + Math.max(0.5, Math.min(5, operations[0].end - hookStart)))
    : Math.min(dur, Math.max(0.5, Math.min(5, dur)));

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
      hook: {
        start: hookStart,
        end: hookEnd,
        text: operations[0]?.label ?? 'Auto-generated edit',
      },
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

export function createPipelineResultValidator(durationSec: number, hasTranscript: boolean) {
  const maxDuration = Math.max(0.1, durationSec + FP_TOLERANCE_SEC);

  const OperationSchema = z
    .object({
      index: z.number().int().nonnegative(),
      start: z
        .number()
        .finite()
        .nonnegative()
        .refine((val) => val <= maxDuration, {
          message: 'operation start exceeds video duration',
        }),
      end: z
        .number()
        .finite()
        .positive()
        .refine((val) => val <= maxDuration, {
          message: 'operation end exceeds video duration',
        }),
      label: z.string().optional().default('Segment'),
      keep: z.boolean().default(true),
      zoom: z.number().finite().positive().default(1.0),
    })
    .passthrough()
    .refine((op) => op.end > op.start, {
      message: 'operation end must be strictly greater than start',
    });

  const HighlightSchema = z
    .object({
      start: z
        .number()
        .finite()
        .nonnegative()
        .refine((val) => val <= maxDuration, {
          message: 'highlight start exceeds video duration',
        }),
      end: z
        .number()
        .finite()
        .positive()
        .refine((val) => val <= maxDuration, {
          message: 'highlight end exceeds video duration',
        }),
      label: z.string().min(1),
      score: z.number().finite().min(0).max(100),
    })
    .passthrough()
    .refine((h) => h.end > h.start, {
      message: 'highlight end must be strictly greater than start',
    });

  const CaptionSchema = z
    .object({
      start: z
        .number()
        .finite()
        .nonnegative()
        .refine((val) => val <= maxDuration, {
          message: 'caption start exceeds video duration',
        }),
      end: z
        .number()
        .finite()
        .positive()
        .refine((val) => val <= maxDuration, {
          message: 'caption end exceeds video duration',
        }),
      text: z.string(),
    })
    .passthrough()
    .refine((c) => c.end > c.start, {
      message: 'caption end must be strictly greater than start',
    });

  const SpeakerSegmentSchema = z
    .object({
      start: z
        .number()
        .finite()
        .nonnegative()
        .refine((val) => val <= maxDuration, {
          message: 'speaker segment start exceeds video duration',
        }),
      end: z
        .number()
        .finite()
        .positive()
        .refine((val) => val <= maxDuration, {
          message: 'speaker segment end exceeds video duration',
        }),
    })
    .passthrough()
    .refine((s) => s.end > s.start, {
      message: 'speaker segment end must be strictly greater than start',
    });

  const SpeakerSchema = z
    .object({
      id: z.string(),
      label: z.string(),
      segments: z.array(SpeakerSegmentSchema),
    })
    .passthrough();

  const HookSchema = z
    .object({
      hook: z
        .object({
          start: z
            .number()
            .finite()
            .nonnegative()
            .refine((val) => val <= maxDuration, {
              message: 'hook start exceeds video duration',
            }),
          end: z
            .number()
            .finite()
            .positive()
            .refine((val) => val <= maxDuration, {
              message: 'hook end exceeds video duration',
            }),
          text: z.string(),
        })
        .passthrough()
        .refine((h) => h.end > h.start, {
          message: 'hook end must be strictly greater than start',
        }),
      alternatives: z.array(z.string()).default([]),
    })
    .passthrough();

  const ThumbnailSchema = z
    .object({
      concept: z.string().default('Use the opening frame'),
      overlayText: z.string().default(''),
      bestFrameSec: z
        .number()
        .finite()
        .nonnegative()
        .refine((val) => val <= maxDuration, {
          message: 'thumbnail frame position exceeds video duration',
        })
        .default(0),
    })
    .passthrough();

  return z
    .object({
      summary: z.string().min(1, 'summary is required'),
      strategy: z.string().min(1, 'strategy is required'),
      reasoning: z.string().default(''),
      highlights: z.array(HighlightSchema).default([]),
      speakers: z.array(SpeakerSchema).default([]),
      captions: z.array(CaptionSchema).superRefine((captions, ctx) => {
        if (!hasTranscript && captions.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'invented transcript or captions are not permitted when transcript is unavailable',
          });
        }
      }),
      suggestedTitles: z.array(z.string().min(1)).min(1, 'at least one title required'),
      socialCopy: z
        .object({
          instagram: z.string().default(''),
          tiktok: z.string().default(''),
          youtube: z.string().default(''),
          linkedin: z.string().default(''),
        })
        .passthrough(),
      hook: HookSchema,
      thumbnail: ThumbnailSchema,
      operations: z.array(OperationSchema).min(1, 'at least one timeline operation required'),
      effects: z
        .object({
          subtitles: z.boolean().default(false),
          zooms: z.boolean().default(false),
          transitions: z.enum(['fade', 'none']).default('none'),
          music: z.boolean().default(false),
          metadata: z.record(z.unknown()).optional(),
        })
        .passthrough(),
      agentLog: z
        .array(
          z
            .object({
              agent: z.string(),
              ms: z.number().finite().nonnegative(),
              summary: z.string(),
            })
            .passthrough(),
        )
        .default([]),
      model: z.string().min(1),
    })
    .passthrough();
}

export function validatePipelineResult(
  raw: unknown,
  durationSec: number,
  hasTranscript: boolean,
  providerName: AiProviderName = 'claude',
): PipelineResult {
  const schema = createPipelineResultValidator(durationSec, hasTranscript);
  const parseResult = schema.safeParse(raw);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    const isOperationIssue = parseResult.error.issues.some((i) =>
      i.path.includes('operations') ||
      i.path.includes('highlights') ||
      i.path.includes('captions') ||
      i.path.includes('speakers') ||
      i.path.includes('hook') ||
      i.path.includes('thumbnail') ||
      i.message.includes('exceeds video duration') ||
      i.message.includes('greater than start')
    );
    throw new AiProviderError({
      message: `Invalid AI output: ${errorDetails}`,
      category: isOperationIssue ? 'INVALID_OPERATION' : 'MALFORMED_RESPONSE',
      provider: providerName,
      cause: parseResult.error,
      isFallbackEligible: providerName !== 'fallback',
    });
  }
  return parseResult.data as PipelineResult;
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

  async analyzeTranscript(input: AiProviderInput): Promise<PipelineResult> {
    const effectiveKey = (input.claudeApiKey !== undefined ? input.claudeApiKey : env.ANTHROPIC_API_KEY) ?? '';
    if (!effectiveKey || effectiveKey.trim() === '') {
      throw new AiProviderError({
        message: 'Anthropic API key is not configured',
        category: 'MISSING_CREDENTIALS',
        provider: 'claude',
        status: 401,
      });
    }
    if (isApiKeyMarkedInvalid(effectiveKey)) {
      throw new AiProviderError({
        message: 'Anthropic API key was marked invalid by a previous request',
        category: 'AUTHENTICATION',
        provider: 'claude',
        status: 401,
      });
    }
    return runEditorialPipeline({ ...input, apiKey: effectiveKey });
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
        reason: 'AI_PROVIDER=fallback',
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
    const timeoutMs = env.NODE_ENV === 'test' ? 3000 : 30000;
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    if (!data.response) throw new Error('Ollama response missing response text');
    const result = normalizeOllamaResult(parseJsonResponse(data.response), input);
    result.agentLog = [{ agent: 'Ollama', ms: Date.now() - started, summary: `Generated locally with ${env.OLLAMA_MODEL}` }];
    return result;
  }
}

const providerRegistry = new Map<string, AiProvider>();

export function registerAiProvider(provider: AiProvider): void;
export function registerAiProvider(name: string, provider: AiProvider): void;
export function registerAiProvider(nameOrProvider: string | AiProvider, maybeProvider?: AiProvider): void {
  if (typeof nameOrProvider === 'string') {
    if (maybeProvider) {
      providerRegistry.set(nameOrProvider.toLowerCase(), maybeProvider);
    }
  } else if (nameOrProvider && typeof nameOrProvider === 'object' && nameOrProvider.name) {
    providerRegistry.set(nameOrProvider.name.toLowerCase(), nameOrProvider);
  }
}

export function resetAiProviders(): void {
  providerRegistry.clear();
}

export function resolveAiProvider(name?: string): AiProvider {
  const rawName = name ?? process.env.AI_PROVIDER ?? env.AI_PROVIDER;
  const resolvedName = (rawName ?? '').trim().toLowerCase();

  if (providerRegistry.has(resolvedName)) {
    return providerRegistry.get(resolvedName)!;
  }

  switch (resolvedName) {
    case 'ollama':
      return new OllamaProvider();
    case 'fallback':
      return new FallbackProvider();
    case 'claude':
      return new ClaudeProvider();
    default:
      throw new AiProviderError({
        message: `Unknown or unsupported AI provider: "${rawName}". Supported providers are: claude, ollama, fallback.`,
        category: 'INVALID_CONFIGURATION',
        provider: 'fallback',
        isFallbackEligible: false,
      });
  }
}

export async function runAiProvider(
  input: AiProviderInput,
  options?: { provider?: AiProviderName },
): Promise<AiProviderResult> {
  const targetProvider = options?.provider ?? input.provider;

  // 1. Fail closed on unknown/misconfigured AI provider (never silently convert to fallback)
  const selected = resolveAiProvider(targetProvider);

  // 2. Explicit fallback selection
  if (selected.name === 'fallback') {
    const result = await selected.analyzeTranscript(input);
    const validated = validatePipelineResult(
      result,
      input.meta.durationSec,
      input.transcript.length > 0,
      'fallback',
    );
    return { provider: 'fallback', result: validated, fallback: true, reason: 'AI_PROVIDER=fallback' };
  }

  // 3. Primary provider execution with strict output validation
  try {
    const rawResult = await selected.analyzeTranscript(input);
    const validatedResult = validatePipelineResult(
      rawResult,
      input.meta.durationSec,
      input.transcript.length > 0,
      selected.name,
    );
    return { provider: selected.name, result: validatedResult, fallback: false };
  } catch (err: unknown) {
    const classified = classifyAiError(err, selected.name);

    // If genuine programming error, configuration error, or non-recoverable defect, do not silently suppress it
    if (!classified.isFallbackEligible) {
      throw err;
    }

    if (classified.category === 'AUTHENTICATION') {
      const activeKey = input.claudeApiKey || env.ANTHROPIC_API_KEY;
      if (activeKey) markApiKeyInvalid(activeKey);
    }

    const selectedName = selected.name === 'ollama' ? 'Ollama' : 'Claude';
    const reason = `${selectedName} unavailable [${classified.category}]: ${classified.message}`;
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'analysis.fallback',
        provider: selected.name,
        category: classified.category,
        reason: sanitizeLogSecret(classified.message),
      }),
    );

    // 4. Validate emergency fallback output too!
    // If fallback output itself is invalid, fail closed without recursive fallback loops.
    const fallbackRaw = buildFallbackPipelineResult({
      meta: input.meta,
      transcript: input.transcript,
      silences: input.silences,
      reason,
    });
    const fallbackValidated = validatePipelineResult(
      fallbackRaw,
      input.meta.durationSec,
      input.transcript.length > 0,
      'fallback',
    );

    return { provider: 'fallback', result: fallbackValidated, fallback: true, category: classified.category, reason };
  }
}

