import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
  MediaTimeRangeSchema,
} from './common.js';

export const ProjectStatusSchema = z.enum([
  'UPLOADING',
  'UPLOADED',
  'ANALYZING',
  'ANALYZED',
  'RENDERING',
  'RENDERED',
  'FAILED',
]);

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const OutputFormatSchema = z.enum(['reel', 'short', 'landscape']);

export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const CaptionStyleSchema = z.enum([
  'karaoke_bounce',
  'minimalist_clean',
  'modern_yellow',
  'classic_white',
  'bold_stroke',
]);

export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const CaptionWordSchema = z.object({
  word: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});

export type CaptionWord = z.infer<typeof CaptionWordSchema>;

export const CaptionCueSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  words: z.array(CaptionWordSchema).optional(),
});

export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const EditOperationKeepSchema = z.object({
  action: z.literal('keep'),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
});

export const EditOperationCutSchema = z.object({
  action: z.literal('cut'),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

export const EditOperationZoomSchema = z.object({
  action: z.literal('zoom'),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  scale: z.number().positive(),
  pan: z.enum(['center', 'left', 'right']).default('center'),
});

export const EditOperationSpeedSchema = z.object({
  action: z.literal('speed'),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  speedMultiplier: z.number().positive(),
});

export const EditOperationSchema = z.discriminatedUnion('action', [
  EditOperationKeepSchema,
  EditOperationCutSchema,
  EditOperationZoomSchema,
  EditOperationSpeedSchema,
]);

export type EditOperation = z.infer<typeof EditOperationSchema>;

export const TimelineEffectsSchema = z.object({
  subtitles: z
    .object({
      enabled: z.boolean().default(true),
      style: CaptionStyleSchema.default('karaoke_bounce'),
      fontSize: z.number().int().positive().default(24),
      uppercase: z.boolean().default(false),
      cues: z.array(CaptionCueSchema).optional(),
    })
    .optional(),
  audio: z
    .object({
      normalizeLoudness: z.boolean().default(true),
      targetLufs: z.number().default(-14),
      musicTrackS3Key: z.string().optional(),
      musicVolume: z.number().min(0).max(1).default(0.12),
      voiceDucking: z.boolean().default(true),
    })
    .optional(),
  video: z
    .object({
      aspectRatio: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
      reframeStrategy: z.enum(['center_crop', 'blur_pad', 'face_track']).default('center_crop'),
      dynamicZooms: z.boolean().default(false),
    })
    .optional(),
});

export type TimelineEffects = z.infer<typeof TimelineEffectsSchema>;

export const OutputSpecSchema = z.object({
  format: OutputFormatSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maxDurationSec: z.number().positive().optional(),
});

export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const EditTimelinePlanSchema = z.object({
  projectId: ResourceIdSchema,
  tenantId: TenantIdSchema,
  sourceWidth: z.number().int().positive().optional(),
  sourceHeight: z.number().int().positive().optional(),
  sourceFps: z.number().positive().optional(),
  operations: z.array(EditOperationSchema),
  effects: TimelineEffectsSchema.default({}),
  outputs: z.array(OutputSpecSchema).default([
    { format: 'reel', width: 1080, height: 1920 },
  ]),
});

export type EditTimelinePlan = z.infer<typeof EditTimelinePlanSchema>;

export const ClipReferenceSchema = z.object({
  clipId: ResourceIdSchema,
  projectId: ResourceIdSchema,
  sourceId: ResourceIdSchema,
  timeRange: MediaTimeRangeSchema,
});

export type ClipReference = z.infer<typeof ClipReferenceSchema>;

export const PreviewStateSchema = z.object({
  currentTimeSec: z.number().nonnegative(),
  isPlaying: z.boolean(),
  activeOperationIndex: z.number().int().nonnegative(),
  activeCaption: z.string().optional(),
});

export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const EditChangeActionSchema = z.enum([
  'kept',
  'removed',
  'trimmed',
  'reordered',
  'added',
  'effect',
]);

export type EditChangeAction = z.infer<typeof EditChangeActionSchema>;

export const EditChangeSchema = z.object({
  action: EditChangeActionSchema,
  target: z.string().min(1),
  reasons: z.array(z.string()).default([]),
});

export type EditChange = z.infer<typeof EditChangeSchema>;

export const VersionDiffSchema = z.object({
  clipsAdded: z.array(z.string()).default([]),
  clipsRemoved: z.array(z.string()).default([]),
  durationChangeSec: z.number(),
  effectChanges: z.array(
    z.object({
      field: z.string(),
      from: z.unknown(),
      to: z.unknown(),
    }),
  ).default([]),
  from: z.object({
    id: z.string(),
    name: z.string(),
    durationSec: z.number(),
  }),
  to: z.object({
    id: z.string(),
    name: z.string(),
    durationSec: z.number(),
  }),
});

export type VersionDiff = z.infer<typeof VersionDiffSchema>;

export const VersionReferenceSchema = z.object({
  versionId: ResourceIdSchema,
  projectId: ResourceIdSchema,
  parentVersionId: ResourceIdSchema.optional(),
  versionNumber: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

export type VersionReference = z.infer<typeof VersionReferenceSchema>;

export const RenderRequestSchema = z.object({
  renderId: ResourceIdSchema,
  projectId: ResourceIdSchema,
  tenantId: TenantIdSchema,
  format: OutputFormatSchema.default('reel'),
  timeline: EditTimelinePlanSchema,
  priority: z.enum(['normal', 'high']).default('normal'),
});

export type RenderRequest = z.infer<typeof RenderRequestSchema>;

/**
 * Legacy TimelineOp Schema & Bidirectional Conversion Adapters
 */
export const LegacyTimelineOpSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  keep: z.boolean(),
  label: z.string().optional(),
  cutReason: z.string().optional(),
  dynamicZoom: z.boolean().optional(),
  zoom: z.number().positive().optional(),
});

export type LegacyTimelineOp = z.infer<typeof LegacyTimelineOpSchema>;

export type LegacyConversionErrorCode =
  | 'UNSUPPORTED_OPERATION'
  | 'UNSUPPORTED_PROPERTY'
  | 'INVALID_TIME_RANGE';

export interface LegacyOpConversionError {
  code: LegacyConversionErrorCode;
  action: string;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}

export type LegacyOpConversionResult =
  | { success: true; op: LegacyTimelineOp }
  | { success: false; error: LegacyOpConversionError };

export class UnsupportedTimelineOperationError extends Error {
  readonly conversionError: LegacyOpConversionError;
  constructor(conversionError: LegacyOpConversionError) {
    super(`Timeline conversion error: ${conversionError.message}`);
    this.name = 'UnsupportedTimelineOperationError';
    this.conversionError = conversionError;
  }
}

/**
 * Converts a canonical EditOperation into a legacy TimelineOp.
 * If the legacy renderer cannot faithfully represent the operation or its properties,
 * returns an explicit typed unsupported-conversion error instead of silently corrupting semantics.
 */
export function editOperationToLegacyOp(
  editOp: EditOperation,
  index?: number,
): LegacyOpConversionResult {
  // Validate time range integrity: startSec must be strictly less than endSec
  if (editOp.startSec >= editOp.endSec) {
    return {
      success: false,
      error: {
        code: 'INVALID_TIME_RANGE',
        action: editOp.action,
        message: `Invalid time range: startSec (${editOp.startSec}) must be strictly less than endSec (${editOp.endSec}).`,
        details: { startSec: editOp.startSec, endSec: editOp.endSec },
      },
    };
  }

  if (editOp.action === 'keep') {
    return {
      success: true,
      op: {
        ...(typeof index === 'number' ? { index } : {}),
        start: editOp.startSec,
        end: editOp.endSec,
        keep: true,
      },
    };
  }

  if (editOp.action === 'cut') {
    return {
      success: true,
      op: {
        ...(typeof index === 'number' ? { index } : {}),
        start: editOp.startSec,
        end: editOp.endSec,
        keep: false,
        cutReason: editOp.reason,
      },
    };
  }

  if (editOp.action === 'zoom') {
    // Check if pan direction is supported: legacy renderer only supports centered cropping
    if (editOp.pan && editOp.pan !== 'center') {
      return {
        success: false,
        error: {
          code: 'UNSUPPORTED_PROPERTY',
          action: 'zoom',
          field: 'pan',
          message: `Legacy renderer does not support directional pan ("${editOp.pan}"). Only "center" pan is supported in the legacy pipeline.`,
          details: { pan: editOp.pan, scale: editOp.scale },
        },
      };
    }

    return {
      success: true,
      op: {
        ...(typeof index === 'number' ? { index } : {}),
        start: editOp.startSec,
        end: editOp.endSec,
        keep: true,
        dynamicZoom: true,
        zoom: editOp.scale,
      },
    };
  }

  if (editOp.action === 'speed') {
    // Legacy FFmpeg pipeline has no setpts/atempo filter graph support.
    // Never silently convert speed to keep, as that would discard speedMultiplier.
    return {
      success: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        action: 'speed',
        message: `Legacy renderer does not support speed adjustment (speedMultiplier=${editOp.speedMultiplier}). Speed operations require the modular timeline engine.`,
        details: { speedMultiplier: editOp.speedMultiplier },
      },
    };
  }

  return {
    success: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      action: (editOp as any).action ?? 'unknown',
      message: `Unknown or unrepresentable edit operation action.`,
    },
  };
}

/**
 * Throwing variant of editOperationToLegacyOp for callers that require a guaranteed valid LegacyTimelineOp.
 */
export function editOperationToLegacyOpOrThrow(
  editOp: EditOperation,
  index?: number,
): LegacyTimelineOp {
  const result = editOperationToLegacyOp(editOp, index);
  if (!result.success) {
    throw new UnsupportedTimelineOperationError(result.error);
  }
  return result.op;
}

/**
 * Batch-converts an entire timeline plan of operations into legacy TimelineOps.
 * Fails closed if any operation cannot be faithfully represented.
 */
export function editOperationsToLegacyOps(
  editOps: EditOperation[],
): { success: true; ops: LegacyTimelineOp[] } | { success: false; errors: LegacyOpConversionError[] } {
  const ops: LegacyTimelineOp[] = [];
  const errors: LegacyOpConversionError[] = [];

  for (let i = 0; i < editOps.length; i++) {
    const res = editOperationToLegacyOp(editOps[i], i);
    if (res.success) {
      ops.push(res.op);
    } else {
      errors.push(res.error);
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }
  return { success: true, ops };
}

/**
 * Converts a legacy TimelineOp into a canonical EditOperation.
 * Preserves exact numeric zoom scales when present.
 */
export function legacyOpToEditOperation(legacyOp: LegacyTimelineOp): EditOperation {
  const startMs = Math.round(legacyOp.start * 1000);
  const endMs = Math.round(legacyOp.end * 1000);

  if (legacyOp.dynamicZoom || (typeof legacyOp.zoom === 'number' && legacyOp.zoom > 1)) {
    return {
      action: 'zoom',
      startSec: legacyOp.start,
      endSec: legacyOp.end,
      startMs,
      endMs,
      scale: legacyOp.zoom ?? 1.15,
      pan: 'center',
    };
  }

  if (legacyOp.keep === false) {
    return {
      action: 'cut',
      startSec: legacyOp.start,
      endSec: legacyOp.end,
      startMs,
      endMs,
      reason: legacyOp.cutReason || legacyOp.label,
    };
  }

  return {
    action: 'keep',
    startSec: legacyOp.start,
    endSec: legacyOp.end,
    startMs,
    endMs,
  };
}
