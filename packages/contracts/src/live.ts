import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
  MillisecondTimestampSchema,
} from './common.js';

/**
 * Transcription Cues and Result Contracts
 */
export const TranscriptWordSchema = z.object({
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});

export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptCueSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
  words: z.array(TranscriptWordSchema).optional(),
});

export type TranscriptCue = z.infer<typeof TranscriptCueSchema>;

export const TranscriptionResultSchema = z.object({
  cues: z.array(TranscriptCueSchema),
  text: z.string(),
  isDegraded: z.boolean().default(false),
  provider: z.enum(['whisper', 'fallback']).default('whisper'),
  model: z.string().default('base'),
  language: z.string().optional(),
});

export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;

export const LiveSessionStateSchema = z.enum([
  'INITIALIZING',
  'LIVE',
  'PAUSED',
  'DISCONNECTED',
  'SEALING',
  'ENDED',
]);

export type LiveSessionState = z.infer<typeof LiveSessionStateSchema>;

export const StreamConnectionStatusSchema = z.enum([
  'CONNECTED',
  'DISCONNECTED',
  'RECONNECTING',
  'TERMINATED',
]);

export type StreamConnectionStatus = z.infer<typeof StreamConnectionStatusSchema>;

export const StreamProtocolSchema = z.enum(['RTMP', 'RTMPS', 'SRT']);

export type StreamProtocol = z.infer<typeof StreamProtocolSchema>;

export const StreamHealthEventSchema = z.object({
  sessionId: ResourceIdSchema,
  timestampMs: MillisecondTimestampSchema,
  bitrateBps: z.number().int().nonnegative(),
  fps: z.number().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  audioLevelDb: z.number().max(0, 'Audio level cannot exceed 0 dBFS'),
  bufferLatencyMs: z.number().int().nonnegative(),
});

export type StreamHealthEvent = z.infer<typeof StreamHealthEventSchema>;

export const ReconnectionEventSchema = z
  .object({
    sessionId: ResourceIdSchema,
    disconnectedAtMs: MillisecondTimestampSchema,
    reconnectedAtMs: MillisecondTimestampSchema,
    downtimeMs: MillisecondTimestampSchema,
    sequenceDiscontinuity: z.boolean(),
  })
  .refine((data) => data.reconnectedAtMs >= data.disconnectedAtMs, {
    message: 'reconnectedAtMs cannot be before disconnectedAtMs',
    path: ['reconnectedAtMs'],
  })
  .refine((data) => data.downtimeMs === data.reconnectedAtMs - data.disconnectedAtMs, {
    message: 'downtimeMs must equal (reconnectedAtMs - disconnectedAtMs)',
    path: ['downtimeMs'],
  });

export type ReconnectionEvent = z.infer<typeof ReconnectionEventSchema>;

export const LiveSessionSchema = z.object({
  id: ResourceIdSchema,
  tenantId: TenantIdSchema,
  sourceId: ResourceIdSchema,
  streamKeyHash: z.string().length(64, 'Stream key hash must be SHA-256 (64 hex characters)'),
  state: LiveSessionStateSchema.default('INITIALIZING'),
  protocol: StreamProtocolSchema.default('RTMPS'),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  pinnedSegmentsCount: z.number().int().nonnegative().default(0),
  health: StreamHealthEventSchema.optional(),
});

export type LiveSession = z.infer<typeof LiveSessionSchema>;
