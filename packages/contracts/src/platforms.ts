import { z } from 'zod';
import {
  ResourceIdSchema,
  MillisecondTimestampSchema,
} from './common.js';

export const PlatformProviderSchema = z.enum(['TWITCH', 'YOUTUBE', 'KICK']);

export type PlatformProvider = z.infer<typeof PlatformProviderSchema>;

export const PlatformConnectionCapabilitySchema = z.enum([
  'CHAT_READ',
  'STREAM_STATUS',
  'VOD_IMPORT',
  'DIRECT_PUBLISH',
]);

export type PlatformConnectionCapability = z.infer<typeof PlatformConnectionCapabilitySchema>;

export const PlatformAuthorizationStatusSchema = z.enum([
  'CONNECTED',
  'DISCONNECTED',
  'EXPIRED',
  'REVOKED',
  'ERROR',
]);

export type PlatformAuthorizationStatus = z.infer<typeof PlatformAuthorizationStatusSchema>;

export const PlatformStreamReferenceSchema = z.object({
  platform: PlatformProviderSchema,
  channelId: z.string().min(1),
  channelName: z.string().min(1).optional(),
  streamId: z.string().optional(),
  broadcastTitle: z.string().optional(),
  gameOrCategory: z.string().optional(),
  startedAt: z.string().datetime().optional(),
});

export type PlatformStreamReference = z.infer<typeof PlatformStreamReferenceSchema>;

export const NormalizedChatEventSchema = z.object({
  id: ResourceIdSchema,
  sourceId: ResourceIdSchema,
  platform: PlatformProviderSchema,
  timestampMs: MillisecondTimestampSchema,
  senderId: z.string().min(1),
  senderName: z.string().min(1),
  message: z.string(),
  emotes: z.array(z.string()).default([]),
  badges: z.array(z.string()).default([]),
  isSubscriber: z.boolean().default(false),
  isModerator: z.boolean().default(false),
  rawPayload: z.record(z.unknown()).optional(),
});

export type NormalizedChatEvent = z.infer<typeof NormalizedChatEventSchema>;
