import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
  MediaTimeRangeSchema,
} from './common.js';

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
