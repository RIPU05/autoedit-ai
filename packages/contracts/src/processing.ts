import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
  MillisecondTimestampSchema,
} from './common.js';

export const ProcessingJobQueueSchema = z.enum([
  'analysis',
  'render',
  'n8n-dispatch',
  'live-ingest',
  'dead-letter',
]);

export type ProcessingJobQueue = z.infer<typeof ProcessingJobQueueSchema>;

export const ProcessingJobStateSchema = z.enum([
  'WAITING',
  'ACTIVE',
  'COMPLETED',
  'FAILED',
  'DELAYED',
]);

export type ProcessingJobState = z.infer<typeof ProcessingJobStateSchema>;

export const JobFailureCategorySchema = z.enum([
  'MEDIA',
  'TRANSCRIPTION',
  'CLAUDE',
  'RENDER',
  'INFRA',
]);

export type JobFailureCategory = z.infer<typeof JobFailureCategorySchema>;

export const IdempotencyKeySchema = z
  .string()
  .min(1, 'Idempotency key cannot be empty')
  .max(256, 'Idempotency key exceeds maximum length');

export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const JobProgressEventSchema = z.object({
  jobId: ResourceIdSchema,
  stage: z.string().min(1),
  progressPercent: z.number().min(0).max(100),
  message: z.string().optional(),
  elapsedMs: MillisecondTimestampSchema,
});

export type JobProgressEvent = z.infer<typeof JobProgressEventSchema>;

export const JobFailureSchema = z.object({
  jobId: ResourceIdSchema,
  category: JobFailureCategorySchema,
  message: z.string().min(1),
  isRetryable: z.boolean(),
  attempt: z.number().int().positive(),
  stack: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type JobFailure = z.infer<typeof JobFailureSchema>;

export const ProcessingJobSchema = z.object({
  id: ResourceIdSchema,
  tenantId: TenantIdSchema,
  queue: ProcessingJobQueueSchema,
  type: z.string().min(1),
  payload: z.record(z.unknown()),
  state: ProcessingJobStateSchema.default('WAITING'),
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  idempotencyKey: IdempotencyKeySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProcessingJob = z.infer<typeof ProcessingJobSchema>;
