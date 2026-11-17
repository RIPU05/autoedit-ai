import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
  MillisecondTimestampSchema,
  MediaTimeRangeSchema,
} from './common.js';

export const MediaSourceKindSchema = z.enum([
  'DIRECT_UPLOAD',
  'PLATFORM_VOD',
  'LIVE_RTMP',
  'LIVE_SRT',
]);

export type MediaSourceKind = z.infer<typeof MediaSourceKindSchema>;

export const MediaSourceStatusSchema = z.enum([
  'INITIALIZING',
  'INGESTING',
  'READY',
  'FAILED',
]);

export type MediaSourceStatus = z.infer<typeof MediaSourceStatusSchema>;

export const MediaAssetKindSchema = z.enum([
  'SOURCE_VIDEO',
  'AUDIO',
  'RENDER_OUTPUT',
  'THUMBNAIL',
  'MUSIC',
]);

export type MediaAssetKind = z.infer<typeof MediaAssetKindSchema>;

export const MediaSegmentRetentionStateSchema = z.enum([
  'EPHEMERAL',
  'PINNED_LEASE',
  'REFERENCED',
  'EXPIRED',
  'ARCHIVED',
]);

export type MediaSegmentRetentionState = z.infer<typeof MediaSegmentRetentionStateSchema>;

export const MediaMetadataSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  bitrateBps: z.number().int().positive().optional(),
  hasAudio: z.boolean().default(true),
});

export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

/**
 * Core Media Source Contract
 */
export const MediaSourceSchema = z.object({
  id: ResourceIdSchema,
  tenantId: TenantIdSchema,
  projectId: ResourceIdSchema.optional(),
  kind: MediaSourceKindSchema,
  status: MediaSourceStatusSchema.default('INITIALIZING'),
  sourceUrl: z.string().url().or(z.string().min(1)).optional(),
  durationMs: MillisecondTimestampSchema.nullable().optional(),
  metadata: MediaMetadataSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type MediaSource = z.infer<typeof MediaSourceSchema>;

/**
 * Stored Binary Media Asset Contract
 */
export const MediaAssetSchema = z.object({
  id: ResourceIdSchema,
  tenantId: TenantIdSchema,
  sourceId: ResourceIdSchema.optional(),
  kind: MediaAssetKindSchema,
  s3Key: z.string().min(1),
  bucket: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: MillisecondTimestampSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  createdAt: z.string().datetime(),
});

export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/**
 * 6-Second Fragmented Segment for Live and Chunked Media
 */
export const MediaSegmentSchema = z.object({
  id: ResourceIdSchema,
  sourceId: ResourceIdSchema,
  tenantId: TenantIdSchema,
  sequenceNumber: z.number().int().nonnegative(),
  epochStartMs: MillisecondTimestampSchema,
  durationMs: MillisecondTimestampSchema,
  s3Key: z.string().min(1),
  pinReferenceCount: z.number().int().nonnegative().default(0),
  pinExpiresAt: z.string().datetime().optional(),
  retentionState: MediaSegmentRetentionStateSchema.default('EPHEMERAL'),
  hasDiscontinuity: z.boolean().default(false),
  createdAt: z.string().datetime(),
});

export type MediaSegment = z.infer<typeof MediaSegmentSchema>;

/**
 * Source Reference Primitive
 */
export const SourceReferenceSchema = z.object({
  sourceId: ResourceIdSchema,
  tenantId: TenantIdSchema,
  kind: MediaSourceKindSchema,
  s3Key: z.string().optional(),
});

export type SourceReference = z.infer<typeof SourceReferenceSchema>;

/**
 * Stream Discontinuity Event
 */
export const MediaDiscontinuitySchema = z.object({
  sequenceNumber: z.number().int().nonnegative(),
  epochOffsetMs: MillisecondTimestampSchema,
  reason: z.string().min(1),
  timestampMs: MillisecondTimestampSchema,
  clockDriftMs: z.number().optional(),
});

export type MediaDiscontinuity = z.infer<typeof MediaDiscontinuitySchema>;
