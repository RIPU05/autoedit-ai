import { z } from 'zod';
import { MediaMetadataSchema } from './media.js';
import { AlgorithmVersionSchema } from './highlight.js';

/**
 * Universal Media Source Providers (Backend Capabilities)
 */
export const MediaSourceProviderSchema = z.enum([
  'upload',
  'youtube',
  'twitch',
  'kick',
  'direct_media',
]);

export type MediaSourceProvider = z.infer<typeof MediaSourceProviderSchema>;

/**
 * Source Media Kind: live broadcast/channel, recorded VOD, or direct upload
 */
export const MediaSourceTypeSchema = z.enum(['live', 'vod', 'uploaded']);

export type MediaSourceType = z.infer<typeof MediaSourceTypeSchema>;

/**
 * Distinguishes mutable live-channel discovery inputs from immutable media identities.
 * Only IMMUTABLE_* identities may coordinate ingestion or key immutable media caches.
 */
export const IdentityScopeSchema = z.enum([
  'CHANNEL_DISCOVERY',
  'IMMUTABLE_BROADCAST',
  'IMMUTABLE_VOD',
  'IMMUTABLE_UPLOAD',
]);

export type IdentityScope = z.infer<typeof IdentityScopeSchema>;

/**
 * Approved acquisition capabilities.
 * External platforms and direct-media hosts default to UNSUPPORTED unless
 * a permitted acquisition method is explicitly authorized.
 */
export const AcquisitionCapabilitySchema = z.enum([
  'DIRECT_UPLOAD',
  'APPROVED_API',
  'PERMITTED_STREAM',
  'PERMITTED_DIRECT_URL',
  'UNSUPPORTED',
]);

export type AcquisitionCapability = z.infer<typeof AcquisitionCapabilitySchema>;

/**
 * Access and copying/recording rights status (distinct from public viewing permission)
 */
export const RightsAccessStatusSchema = z.enum([
  'USER_OWNED',
  'PERMITTED_PUBLIC',
  'REQUIRES_AUTHORIZATION',
  'RESTRICTED_DRM',
  'DENIED',
  'UNKNOWN',
]);

export type RightsAccessStatus = z.infer<typeof RightsAccessStatusSchema>;

/**
 * External source availability
 */
export const SourceAvailabilitySchema = z.enum([
  'AVAILABLE',
  'LIVE_NOW',
  'ENDED_PROCESSING',
  'OFFLINE',
  'UNAVAILABLE',
  'UNKNOWN',
]);

export type SourceAvailability = z.infer<typeof SourceAvailabilitySchema>;

/**
 * Shared ingestion coordination lifecycle state
 */
export const SharedIngestionStateSchema = z.enum([
  'PENDING',
  'ACQUIRING',
  'INGESTING',
  'READY',
  'FAILED',
  'EXPIRED',
]);

export type SharedIngestionState = z.infer<typeof SharedIngestionStateSchema>;

/**
 * Structured media source & acquisition error codes
 */
export const MediaSourceErrorCodeSchema = z.enum([
  'MALFORMED_URL',
  'UNSUPPORTED_SCHEME',
  'UNSUPPORTED_PROVIDER',
  'SSRF_BLOCKED',
  'PRIVATE_NETWORK_BLOCKED',
  'UNSUPPORTED_ACQUISITION',
  'BROADCAST_UNRESOLVED',
  'ACCESS_DENIED',
  'RIGHTS_UNVERIFIED',
  'DRM_RESTRICTED',
  'SOURCE_UNAVAILABLE',
  'COORDINATION_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'LEASE_EXPIRED',
  'COORDINATION_TIMEOUT',
  'REQUEST_CANCELLED',
  'ARTIFACT_CORRUPT',
  'MAX_RETRIES_EXCEEDED',
]);

export type MediaSourceErrorCode = z.infer<typeof MediaSourceErrorCodeSchema>;

/**
 * Channel Identity (Discovery input only — NOT an immutable broadcast session):
 *   twitch:channel:shroud
 *   kick:channel:xqc
 */
export const ChannelIdentitySchema = z
  .string()
  .regex(
    /^(youtube|twitch|kick):channel:[a-zA-Z0-9._-]+$/,
    'Channel identity must follow <provider>:channel:<channelKey>',
  );

export type ChannelIdentity = z.infer<typeof ChannelIdentitySchema>;

/**
 * Immutable Broadcast Session Identity:
 *   youtube:broadcast:dQw4w9WgXcQ
 *   twitch:broadcast:shroud:41928374650
 *   kick:broadcast:xqc:ls_998877
 */
export const BroadcastIdentitySchema = z
  .string()
  .regex(
    /^(youtube|twitch|kick):broadcast:[a-zA-Z0-9._:-]+$/,
    'Broadcast identity must follow <provider>:broadcast:<verifiedSessionId>',
  );

export type BroadcastIdentity = z.infer<typeof BroadcastIdentitySchema>;

/**
 * Cacheable / Immutable Source Identity (strictly excludes channel-only discovery IDs):
 *   youtube:broadcast:<id>
 *   youtube:vod:<id>
 *   twitch:broadcast:<channel>:<sessionId>
 *   twitch:vod:<id>
 *   kick:broadcast:<channel>:<sessionId>
 *   kick:vod:<id>
 *   upload:uploaded:<assetId>
 *   direct_media:vod:<hash>
 */
export const CacheableSourceIdSchema = z
  .string()
  .regex(
    /^(upload:uploaded|youtube:(vod|broadcast)|twitch:(vod|broadcast)|kick:(vod|broadcast)|direct_media:vod):[a-zA-Z0-9._:-]+$/,
    'Cacheable source ID must be an immutable broadcast, VOD, or upload identity (channel-only IDs are forbidden)',
  );

export type CacheableSourceId = z.infer<typeof CacheableSourceIdSchema>;

/**
 * Canonical Source Identity (includes both immutable source IDs and channel discovery IDs)
 */
export const CanonicalSourceIdSchema = z
  .string()
  .regex(
    /^(upload:uploaded|youtube:(vod|broadcast|channel)|twitch:(vod|broadcast|channel)|kick:(vod|broadcast|channel)|direct_media:vod):[a-zA-Z0-9._:-]+$/,
    'Canonical source ID must follow <provider>:<kind>:<id>',
  );

export type CanonicalSourceId = z.infer<typeof CanonicalSourceIdSchema>;

export const UniversalMediaMetadataSchema = MediaMetadataSchema.extend({
  title: z.string().optional(),
  channelName: z.string().optional(),
  isLive: z.boolean().optional(),
});

export type UniversalMediaMetadata = z.infer<typeof UniversalMediaMetadataSchema>;

export const MediaSourceErrorPayloadSchema = z.object({
  code: MediaSourceErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean().default(false),
});

export type MediaSourceErrorPayload = z.infer<typeof MediaSourceErrorPayloadSchema>;

/**
 * Universal Media Source Contract
 * Separates backend source identity and capabilities from private per-user Projects.
 */
export const UniversalMediaSourceSchema = z.object({
  canonicalId: CanonicalSourceIdSchema,
  identityScope: IdentityScopeSchema,
  provider: MediaSourceProviderSchema,
  sourceType: MediaSourceTypeSchema,
  externalId: z.string().min(1),
  channelId: ChannelIdentitySchema.optional(),
  broadcastId: z.string().min(1).optional(),
  normalizedUrl: z.string().url().optional(),
  availability: SourceAvailabilitySchema.default('UNKNOWN'),
  acquisitionCapability: AcquisitionCapabilitySchema,
  rightsStatus: RightsAccessStatusSchema,
  ingestionStatus: SharedIngestionStateSchema.default('PENDING'),
  metadata: UniversalMediaMetadataSchema.optional(),
  error: MediaSourceErrorPayloadSchema.optional(),
});

export type UniversalMediaSource = z.infer<typeof UniversalMediaSourceSchema>;

/**
 * Shared vs Private Artifact Cache Contracts
 */
export const CacheArtifactKindSchema = z.enum([
  'SOURCE_MEDIA',
  'SOURCE_SEGMENT',
  'TRANSCRIPTION',
  'HIGHLIGHT_ANALYSIS',
  'BASE_CLIP',
]);

export type CacheArtifactKind = z.infer<typeof CacheArtifactKindSchema>;

export const CacheRightsScopeSchema = z.enum([
  'PRIVATE_USER',
  'SHARED_PERMITTED',
]);

export type CacheRightsScope = z.infer<typeof CacheRightsScopeSchema>;

export const CacheTimeRangeSecSchema = z
  .object({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
  })
  .refine((r) => r.end > r.start, {
    message: 'Cache time range end must be greater than start',
  });

export type CacheTimeRangeSec = z.infer<typeof CacheTimeRangeSecSchema>;

export const CacheRenderSettingsSchema = z.object({
  format: z.enum(['short', 'reel', 'tiktok', 'landscape']).default('reel'),
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  fps: z.number().positive().default(30),
  subtitles: z.boolean().default(false),
  zooms: z.boolean().default(false),
  transitions: z.enum(['fade', 'none']).default('none'),
  music: z.boolean().default(false),
  customEditHash: z.string().optional(),
});

export type CacheRenderSettings = z.infer<typeof CacheRenderSettingsSchema>;

export const SharedCacheKeyInputSchema = z
  .object({
    artifactKind: CacheArtifactKindSchema,
    canonicalSourceId: CacheableSourceIdSchema,
    sourceRevision: z.string().min(1).default('v1'),
    timeRangeSec: CacheTimeRangeSecSchema.optional(),
    algorithmVersion: z.string().min(1).default('v1'),
    renderSettings: CacheRenderSettingsSchema.optional(),
    rightsScope: CacheRightsScopeSchema,
    ownerUserId: z.string().min(1).optional(),
  })
  .refine(
    (data) => data.rightsScope !== 'PRIVATE_USER' || Boolean(data.ownerUserId),
    {
      message: 'ownerUserId is required when rightsScope is PRIVATE_USER',
      path: ['ownerUserId'],
    },
  );

export type SharedCacheKeyInput = z.infer<typeof SharedCacheKeyInputSchema>;

export const SharedCacheIdentitySchema = z.object({
  cacheKey: z.string().min(1),
  storageKey: z.string().min(1),
  artifactKind: CacheArtifactKindSchema,
  canonicalSourceId: CacheableSourceIdSchema,
  rightsScope: CacheRightsScopeSchema,
  ownerUserId: z.string().optional(),
});

export type SharedCacheIdentity = z.infer<typeof SharedCacheIdentitySchema>;

/**
 * CPU-First Live Highlight Detection Contracts & Rolling Media Buffer
 */
export const CpuSignalKindSchema = z.enum([
  'AUDIO_ENERGY',
  'SPEECH_ACTIVITY',
  'CHAT_VELOCITY',
  'CHAT_EXCITEMENT_KEYWORDS',
  'TRANSCRIPT_CONTEXT',
  'SELECTIVE_VISUAL',
]);

export type CpuSignalKind = z.infer<typeof CpuSignalKindSchema>;

export const RollingBufferConfigSchema = z.object({
  preEventSec: z.number().finite().min(1).max(300).default(45),
  postEventSec: z.number().finite().min(1).max(180).default(15),
  segmentDurationSec: z.number().finite().min(1).max(30).default(6),
  maxRetentionSec: z.number().finite().min(60).max(7200).default(600),
});

export type RollingBufferConfig = z.infer<typeof RollingBufferConfigSchema>;

export const HighlightDetectionSampleSchema = z.object({
  timestampSec: z.number().finite().nonnegative(),
  signalKind: CpuSignalKindSchema,
  normalizedIntensity: z.number().finite().min(0).max(1),
  rawValue: z.number().finite().optional(),
  keywords: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).optional(),
});

export type HighlightDetectionSample = z.infer<typeof HighlightDetectionSampleSchema>;

export const HighlightWindowCandidateSchema = z.object({
  candidateId: z.string().min(1),
  canonicalSourceId: CacheableSourceIdSchema,
  eventTimestampSec: z.number().finite().nonnegative(),
  windowStartSec: z.number().finite().nonnegative(),
  windowEndSec: z.number().finite().positive(),
  compositeScore: z.number().finite().min(0).max(100),
  contributingSignals: z.array(CpuSignalKindSchema).min(1),
  pinnedSegmentIndices: z.array(z.number().int().nonnegative()).default([]),
  algorithmVersion: AlgorithmVersionSchema.default('v1.0-heuristic'),
});

export type HighlightWindowCandidate = z.infer<typeof HighlightWindowCandidateSchema>;
