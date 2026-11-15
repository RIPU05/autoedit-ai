import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
} from './common.js';

export const UsageEventTypeSchema = z.enum([
  'VIDEO_MINUTES_PROCESSED',
  'TRANSCRIPTION_SECONDS',
  'RENDER_SECONDS',
  'STORAGE_BYTES_HOURS',
  'LLM_TOKENS',
]);

export type UsageEventType = z.infer<typeof UsageEventTypeSchema>;

export const UsageEventSchema = z.object({
  id: ResourceIdSchema,
  tenantId: TenantIdSchema,
  eventType: UsageEventTypeSchema,
  quantity: z.number().nonnegative(),
  unit: z.string().min(1),
  projectId: ResourceIdSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime(),
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const RetentionPolicySchema = z.object({
  tenantId: TenantIdSchema,
  ephemeralBufferMinutes: z.number().int().min(5).max(720).default(30), // 30-minute pilot
  pinLeaseHours: z.number().int().min(1).max(8760).default(72), // 3 days default lease
  gracePeriodHours: z.number().int().min(0).max(720).default(24), // 24 hours cleanup grace
});

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const SegmentPinReferenceTypeSchema = z.enum([
  'HIGHLIGHT_CANDIDATE',
  'TIMELINE_CLIP',
  'CREATOR_BOOKMARK',
]);

export type SegmentPinReferenceType = z.infer<typeof SegmentPinReferenceTypeSchema>;

export const SegmentPinReferenceSchema = z.object({
  pinId: ResourceIdSchema,
  segmentId: ResourceIdSchema,
  tenantId: TenantIdSchema,
  referenceType: SegmentPinReferenceTypeSchema,
  referenceId: ResourceIdSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

export type SegmentPinReference = z.infer<typeof SegmentPinReferenceSchema>;
