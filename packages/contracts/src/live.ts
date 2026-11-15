import { z } from 'zod';
import {
  TenantIdSchema,
  ResourceIdSchema,
  MillisecondTimestampSchema,
} from './common.js';

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
