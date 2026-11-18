import { z } from 'zod';
import { ResourceIdSchema } from './common.js';
import {
  CacheRenderSettingsSchema,
  CpuSignalKindSchema,
  IdentityScopeSchema,
  MediaSourceProviderSchema,
  MediaSourceTypeSchema,
} from './media-source.js';
import { IdempotencyKeySchema } from './processing.js';

/**
 * Capability status returned when resolving a universal media input.
 * Recognized platform URLs without an approved acquisition adapter return
 * UNSUPPORTED_ACQUISITION truthfully rather than claiming download support.
 */
export const SourceCapabilityStatusSchema = z.enum([
  'READY_TO_PROCESS',
  'REQUIRES_PERMISSION',
  'UNSUPPORTED_ACQUISITION',
  'BROADCAST_UNRESOLVED',
  'SOURCE_UNAVAILABLE',
]);

export type SourceCapabilityStatus = z.infer<typeof SourceCapabilityStatusSchema>;

/**
 * Universal media input accepted by authenticated media APIs.
 * Uses `.strict()` so clients cannot smuggle privileged fields such as
 * canonicalSourceId, rightsStatus, ownerUserId, storageKey, or workerId.
 */
export const UniversalMediaUrlInputSchema = z
  .object({
    inputType: z.literal('url'),
    url: z.string().min(1).max(2048),
  })
  .strict();

export const UniversalMediaUploadInputSchema = z
  .object({
    inputType: z.literal('upload'),
    projectId: ResourceIdSchema,
  })
  .strict();

export const UniversalMediaControlledFixtureInputSchema = z
  .object({
    inputType: z.literal('controlled_fixture'),
    fixtureKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/, 'fixtureKey must contain only safe identifier characters'),
  })
  .strict();

export const UniversalMediaInputSchema = z.discriminatedUnion('inputType', [
  UniversalMediaUrlInputSchema,
  UniversalMediaUploadInputSchema,
  UniversalMediaControlledFixtureInputSchema,
]);

export type UniversalMediaInput = z.infer<typeof UniversalMediaInputSchema>;

/**
 * POST /api/media/sources/resolve
 */
export const ResolveMediaSourceRequestSchema = z
  .object({
    input: UniversalMediaInputSchema,
  })
  .strict();

export type ResolveMediaSourceRequest = z.infer<typeof ResolveMediaSourceRequestSchema>;

export const ResolveMediaSourceResponseSchema = z.object({
  capabilityStatus: SourceCapabilityStatusSchema,
  provider: MediaSourceProviderSchema,
  sourceType: MediaSourceTypeSchema,
  identityScope: IdentityScopeSchema,
  normalizedUrl: z.string().optional(),
  mediaSourceId: ResourceIdSchema.optional(),
  title: z.string().optional(),
  canSubmitJob: z.boolean(),
  reason: z.string().min(1),
  supportedActions: z.array(z.string()),
});

export type ResolveMediaSourceResponse = z.infer<typeof ResolveMediaSourceResponseSchema>;

/**
 * User-scoped durable media job lifecycle states
 */
export const MediaApiJobStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'READY',
  'FAILED',
  'CANCELLED',
]);

export type MediaApiJobStatus = z.infer<typeof MediaApiJobStatusSchema>;

export const MediaJobProcessingOptionsSchema = z
  .object({
    sourceRevision: z.string().min(1).max(64).optional(),
    preRollSec: z.number().finite().min(1).max(120).optional(),
    postRollSec: z.number().finite().min(1).max(120).optional(),
    cooldownSec: z.number().finite().min(1).max(120).optional(),
    scoreThreshold: z.number().finite().min(10).max(100).optional(),
    enableLocalWhisper: z.boolean().optional(),
    renderSettings: CacheRenderSettingsSchema.omit({ customEditHash: true }).partial().optional(),
  })
  .strict();

export type MediaJobProcessingOptions = z.infer<typeof MediaJobProcessingOptionsSchema>;

/**
 * POST /api/media/jobs
 */
export const SubmitMediaJobRequestSchema = z
  .object({
    input: UniversalMediaInputSchema,
    idempotencyKey: IdempotencyKeySchema,
    options: MediaJobProcessingOptionsSchema.optional(),
  })
  .strict();

export type SubmitMediaJobRequest = z.infer<typeof SubmitMediaJobRequestSchema>;

export const MediaJobResponseSchema = z.object({
  jobId: ResourceIdSchema,
  status: MediaApiJobStatusSchema,
  provider: MediaSourceProviderSchema,
  sourceType: MediaSourceTypeSchema,
  capabilityStatus: SourceCapabilityStatusSchema,
  idempotencyKey: IdempotencyKeySchema,
  mediaSourceId: ResourceIdSchema,
  projectId: ResourceIdSchema.nullable().optional(),
  stage: z.string().min(1),
  progressPercent: z.number().min(0).max(100),
  highlightsCount: z.number().int().nonnegative(),
  deduplicatedSharedWork: z.boolean(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type MediaJobResponse = z.infer<typeof MediaJobResponseSchema>;

/**
 * GET /api/media/jobs/:jobId/highlights & GET /api/media/projects/:projectId/highlights
 * Never exposes raw MinIO/S3 storage keys or internal object keys.
 */
export const MediaHighlightItemSchema = z.object({
  highlightId: z.string().min(1),
  cacheKey: z.string().min(1),
  eventTimestampSec: z.number().finite().nonnegative(),
  windowStartSec: z.number().finite().nonnegative(),
  windowEndSec: z.number().finite().positive(),
  compositeScore: z.number().finite().min(0).max(100),
  contributingSignals: z.array(CpuSignalKindSchema).min(1),
  durationSec: z.number().finite().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  downloadUrl: z.string().url().optional(),
  downloadUrlExpiresInSec: z.number().int().positive().optional(),
  reusedFromCache: z.boolean().optional(),
});

export type MediaHighlightItem = z.infer<typeof MediaHighlightItemSchema>;

export const MediaJobHighlightsResponseSchema = z.object({
  jobId: ResourceIdSchema,
  status: MediaApiJobStatusSchema,
  sourceType: MediaSourceTypeSchema,
  streamActive: z.boolean(),
  highlights: z.array(MediaHighlightItemSchema),
});

export type MediaJobHighlightsResponse = z.infer<typeof MediaJobHighlightsResponseSchema>;

/**
 * POST /api/media/projects/from-source
 */
export const CreateProjectFromSourceRequestSchema = z
  .object({
    jobId: ResourceIdSchema,
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateProjectFromSourceRequest = z.infer<typeof CreateProjectFromSourceRequestSchema>;

export const CreateProjectFromSourceResponseSchema = z.object({
  projectId: ResourceIdSchema,
  mediaSourceId: ResourceIdSchema,
  timelineId: ResourceIdSchema,
  rootVersionId: ResourceIdSchema,
  highlightsCount: z.number().int().nonnegative(),
});

export type CreateProjectFromSourceResponse = z.infer<typeof CreateProjectFromSourceResponseSchema>;

/**
 * POST /api/media/projects/:projectId/edits
 */
export const ApplyPrivateProjectEditRequestSchema = z
  .object({
    mode: z.enum(['auto', 'prompt', 'reference', 'manual']),
    versionName: z.string().min(1).max(160),
    userPrompt: z.string().max(2000).optional(),
    windowStartSec: z.number().finite().nonnegative(),
    windowEndSec: z.number().finite().positive(),
    effects: z
      .object({
        subtitles: z.boolean().optional(),
        zooms: z.boolean().optional(),
        transitions: z.enum(['fade', 'none']).optional(),
        music: z.boolean().optional(),
      })
      .strict()
      .optional(),
    renderOutput: z.boolean().optional(),
    format: z.enum(['reel', 'short', 'landscape']).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .refine((d) => d.windowEndSec > d.windowStartSec, {
    message: 'windowEndSec must be greater than windowStartSec',
    path: ['windowEndSec'],
  });

export type ApplyPrivateProjectEditRequest = z.infer<typeof ApplyPrivateProjectEditRequestSchema>;

/**
 * POST /api/media/projects/:projectId/renders
 * Enqueue a durable background private render for an existing owned EditVersion.
 */
export const CreatePrivateRenderRequestSchema = z
  .object({
    editVersionId: ResourceIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    format: z.enum(['reel', 'short', 'landscape']).optional(),
  })
  .strict();

export type CreatePrivateRenderRequest = z.infer<typeof CreatePrivateRenderRequestSchema>;

/**
 * Private background render job response (never leaks raw storage keys).
 * Signed downloadUrl is minted dynamically on GET only when status === READY and rights + storage verify.
 */
export const PrivateRenderJobResponseSchema = z.object({
  renderJobId: ResourceIdSchema,
  projectId: ResourceIdSchema,
  editVersionId: ResourceIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  customEditHash: z.string().min(1),
  mode: z.enum(['auto', 'prompt', 'reference', 'manual']),
  windowStartSec: z.number().finite().nonnegative(),
  windowEndSec: z.number().finite().positive(),
  status: MediaApiJobStatusSchema,
  stage: z.string().min(1),
  progressPercent: z.number().min(0).max(100),
  durationSec: z.number().finite().positive().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  downloadUrl: z.string().url().optional(),
  downloadUrlExpiresInSec: z.number().int().positive().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
});

export type PrivateRenderJobResponse = z.infer<typeof PrivateRenderJobResponseSchema>;

export const ApplyPrivateProjectEditResponseSchema = z.object({
  projectId: ResourceIdSchema,
  versionId: ResourceIdSchema,
  parentVersionId: ResourceIdSchema.nullable(),
  customEditHash: z.string().min(1),
  renderJob: PrivateRenderJobResponseSchema.optional(),
});

export type ApplyPrivateProjectEditResponse = z.infer<typeof ApplyPrivateProjectEditResponseSchema>;

export const CancelPrivateRenderResponseSchema = z.object({
  renderJobId: ResourceIdSchema,
  status: z.enum(['CANCELLED', 'READY', 'FAILED']),
  alreadyCompleted: z.boolean().optional(),
});

export type CancelPrivateRenderResponse = z.infer<typeof CancelPrivateRenderResponseSchema>;

/**
 * BullMQ private-render queue payload (internal server queue contract)
 */
export const PrivateRenderQueuePayloadSchema = z.object({
  renderJobId: ResourceIdSchema,
  projectId: ResourceIdSchema,
  userId: ResourceIdSchema,
  generation: z.number().int().positive(),
});

export type PrivateRenderQueuePayload = z.infer<typeof PrivateRenderQueuePayloadSchema>;

/**
 * Verified source preview response (GET /api/projects/:id/source-url)
 */
export const ProjectSourcePreviewResponseSchema = z.object({
  url: z.string().url(),
  expiresInSec: z.number().int().positive(),
  sourceKind: z.enum(['PRIVATE_UPLOAD', 'SOURCE_MEDIA']),
  sourceRevision: z.string().min(1).optional(),
  publishedGeneration: z.number().int().positive().optional(),
});

export type ProjectSourcePreviewResponse = z.infer<typeof ProjectSourcePreviewResponseSchema>;

/**
 * BullMQ media-process queue payload (internal server queue contract)
 */
export const MediaProcessJobPayloadSchema = z.object({
  sharedWorkKey: z.string().min(1),
  generation: z.number().int().positive().optional(),
  mediaSourceId: ResourceIdSchema,
  canonicalSourceId: z.string().min(1),
  sourceType: MediaSourceTypeSchema,
  initiatedByUserId: ResourceIdSchema,
  userJobId: ResourceIdSchema,
  controlledFixtureKey: z.string().optional(),
  uploadProjectId: ResourceIdSchema.optional(),
  options: MediaJobProcessingOptionsSchema.optional(),
});

export type MediaProcessJobPayload = z.infer<typeof MediaProcessJobPayloadSchema>;
