import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
  MillisecondTimestampSchema,
  MediaTimeRangeSchema,
} from './common.js';

export const HighlightSignalTypeSchema = z.enum([
  'CHAT_VELOCITY',
  'AUDIO_LOUDNESS',
  'SPEECH_PACING',
  'SEMANTIC_HOOK',
  'CREATOR_BOOKMARK',
]);

export type HighlightSignalType = z.infer<typeof HighlightSignalTypeSchema>;

export const HighlightScoreSchema = z
  .number()
  .min(0, 'Score cannot be less than 0')
  .max(100, 'Score cannot exceed 100');

export type HighlightScore = z.infer<typeof HighlightScoreSchema>;

export const AlgorithmVersionSchema = z.enum([
  'v1.0-heuristic',
  'v1.1-multimodal',
  'v2.0-custom',
]);

export type AlgorithmVersion = z.infer<typeof AlgorithmVersionSchema>;

export const HighlightCandidateStatusSchema = z.enum([
  'PROPOSED',
  'PINNED',
  'REJECTED',
  'ACCEPTED',
]);

export type HighlightCandidateStatus = z.infer<typeof HighlightCandidateStatusSchema>;

export const HighlightSignalSchema = z.object({
  id: ResourceIdSchema,
  sourceId: ResourceIdSchema,
  signalType: HighlightSignalTypeSchema,
  timestampMs: MillisecondTimestampSchema,
  value: z.number(),
  normalizedScore: z.number().min(0).max(1),
  metadata: z.record(z.unknown()).optional(),
});

export type HighlightSignal = z.infer<typeof HighlightSignalSchema>;

export const HighlightReasonSchema = z.object({
  editorialStrategy: z.string().min(1),
  hookMechanism: z.string().optional(),
  viralityRationale: z.string().optional(),
});

export type HighlightReason = z.infer<typeof HighlightReasonSchema>;

export const HighlightEvidenceSchema = z.object({
  chatSurgeMultiplier: z.number().positive().optional(),
  peakLufs: z.number().max(0).optional(),
  speechWpm: z.number().nonnegative().optional(),
  hookText: z.string().optional(),
  silenceEliminatedSec: z.number().nonnegative().optional(),
  topEmotes: z.array(z.string()).default([]),
});

export type HighlightEvidence = z.infer<typeof HighlightEvidenceSchema>;

export const HighlightCandidateSchema = z.object({
  id: ResourceIdSchema,
  sourceId: ResourceIdSchema,
  tenantId: TenantIdSchema,
  timeRange: MediaTimeRangeSchema,
  compositeScore: HighlightScoreSchema,
  hook: z
    .object({
      quote: z.string(),
      startMs: MillisecondTimestampSchema,
      endMs: MillisecondTimestampSchema,
      mechanism: z.string().optional(),
    })
    .optional(),
  reason: HighlightReasonSchema,
  signals: z.array(HighlightSignalSchema).default([]),
  evidence: HighlightEvidenceSchema.default({}),
  status: HighlightCandidateStatusSchema.default('PROPOSED'),
  algorithmVersion: AlgorithmVersionSchema.default('v1.0-heuristic'),
  createdAt: z.string().datetime(),
});

export type HighlightCandidate = z.infer<typeof HighlightCandidateSchema>;
