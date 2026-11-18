import {
  CacheableSourceIdSchema,
  UniversalMediaSourceSchema,
  type AcquisitionCapability,
  type CacheRightsScope,
  type CacheableSourceId,
  type MediaSourceProvider,
  type MediaSourceType,
  type RightsAccessStatus,
  type SourceAvailability,
  type UniversalMediaSource,
} from '@autoedit/contracts';
import type {
  MediaAcquisitionCapabilityEnum,
  MediaIdentityScopeEnum,
  MediaRightsGrant,
  MediaRightsStatusEnum,
  MediaSource,
  MediaSourceAvailabilityEnum,
  MediaSourceProviderEnum,
  MediaSourceTypeEnum,
  Prisma,
  PrismaClient,
  RightsGrantScopeEnum,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../lib/prisma.js';
import { MediaSourceError } from './errors.js';
import {
  createTrustedCacheAuthContext,
  type TrustedCacheAuthContext,
} from './shared-cache.js';

function toPrismaProvider(p: MediaSourceProvider): MediaSourceProviderEnum {
  switch (p) {
    case 'upload':
      return 'UPLOAD';
    case 'youtube':
      return 'YOUTUBE';
    case 'twitch':
      return 'TWITCH';
    case 'kick':
      return 'KICK';
    case 'direct_media':
      return 'DIRECT_MEDIA';
  }
}

function fromPrismaProvider(p: MediaSourceProviderEnum): MediaSourceProvider {
  switch (p) {
    case 'UPLOAD':
      return 'upload';
    case 'YOUTUBE':
      return 'youtube';
    case 'TWITCH':
      return 'twitch';
    case 'KICK':
      return 'kick';
    case 'DIRECT_MEDIA':
      return 'direct_media';
  }
}

function toPrismaSourceType(t: MediaSourceType): MediaSourceTypeEnum {
  switch (t) {
    case 'live':
      return 'LIVE';
    case 'vod':
      return 'VOD';
    case 'uploaded':
      return 'UPLOADED';
  }
}

function fromPrismaSourceType(t: MediaSourceTypeEnum): MediaSourceType {
  switch (t) {
    case 'LIVE':
      return 'live';
    case 'VOD':
      return 'vod';
    case 'UPLOADED':
      return 'uploaded';
  }
}

function sanitizePublicMetadata(meta?: Record<string, unknown>): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  const blocked = /secret|token|password|apikey|api_key|credential|cookie|authorization/i;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (blocked.test(k)) continue;
    if (v === undefined) continue;
    clean[k] = v;
  }
  return clean as Prisma.InputJsonValue;
}

export interface RegisterMediaSourceInput {
  canonicalId: string;
  provider: MediaSourceProvider;
  sourceType: MediaSourceType;
  identityScope: 'IMMUTABLE_BROADCAST' | 'IMMUTABLE_VOD' | 'IMMUTABLE_UPLOAD';
  externalId: string;
  channelId?: string;
  broadcastId?: string;
  vodId?: string;
  /** Optional explicit link from a recorded VOD back to its original live broadcast (keeps rows distinct). */
  associatedLiveSourceId?: string;
  sourceRevision?: string;
  normalizedUrl?: string;
  availability?: SourceAvailability;
  /** Required for provider === 'upload' (owner of direct user upload). */
  ownerUserId?: string;
  retentionExpiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface GrantSourceRightsInput {
  canonicalSourceId: string;
  grantScope: RightsGrantScopeEnum;
  granteeUserId?: string;
  allowAcquisition: boolean;
  allowSharedReuse: boolean;
  acquisitionCapability?: MediaAcquisitionCapabilityEnum;
  rightsStatus?: MediaRightsStatusEnum;
  /** Auditable provenance string (e.g. 'TEST_CONTROLLED_GRANT', 'USER_DIRECT_UPLOAD', 'EXPLICIT_PLATFORM_GRANT'). */
  provenance: string;
  /** Server subsystem or admin identifier (never untrusted client JSON). */
  grantedBy: string;
  reason?: string;
  expiresAt?: Date;
}

export interface RevokeSourceRightsInput {
  canonicalSourceId: string;
  grantId?: string;
  revokedReason: string;
  /** Resulting rights status when no active grants remain; defaults to 'DENIED'. */
  fallbackRightsStatus?: 'DENIED' | 'REQUIRES_AUTHORIZATION' | 'UNKNOWN';
}

export interface ServerResolvedAuthResult {
  auth: TrustedCacheAuthContext;
  mediaSource: MediaSource;
  activeGrants: MediaRightsGrant[];
  allowAcquisition: boolean;
  allowSharedReuse: boolean;
  effectiveRightsScope: CacheRightsScope | 'NONE';
}

/**
 * Server-authoritative PostgreSQL MediaSource Registry & Rights Authorization Service.
 *
 * Security invariants:
 * - Rejects mutable channel-only IDs (`:channel:`) from durable registration.
 * - Registering a public URL defaults to rightsStatus=UNKNOWN, acquisitionCapability=UNSUPPORTED,
 *   rightsScope=NONE. A public URL NEVER implies download or cross-user reuse permission.
 * - Direct user uploads preserve strict ownerUserId isolation and NEVER enter SHARED_PERMITTED
 *   cache scope automatically.
 * - TrustedCacheAuthContext is constructed ONLY from server-verified PostgreSQL MediaSource +
 *   active (non-revoked, non-expired) MediaRightsGrant records—never from untrusted client JSON.
 */
export class DurableMediaRegistryService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * Registers an immutable media source (live broadcast, VOD, or direct upload) or returns
   * the existing shared record without duplicating it or elevating rights.
   */
  async registerOrGetMediaSource(input: RegisterMediaSourceInput): Promise<MediaSource> {
    if (input.canonicalId.includes(':channel:')) {
      throw new MediaSourceError({
        code: 'BROADCAST_UNRESOLVED',
        message: `Channel-only identity "${input.canonicalId}" cannot be registered as an immutable MediaSource.`,
        retryable: true,
      });
    }

    const parsedId = CacheableSourceIdSchema.safeParse(input.canonicalId);
    if (!parsedId.success) {
      throw new MediaSourceError({
        code: 'BROADCAST_UNRESOLVED',
        message: `Invalid immutable canonicalId "${input.canonicalId}".`,
      });
    }
    const canonicalId = parsedId.data;

    const isUpload = input.provider === 'upload' || input.identityScope === 'IMMUTABLE_UPLOAD';
    if (isUpload && !input.ownerUserId?.trim()) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Direct user uploads require a verified ownerUserId.',
      });
    }

    // Check existing record first so concurrent users referencing the same eligible broadcast/VOD
    // reuse the exact same shared MediaSource row without resetting authoritative server grants.
    const existing = await this.db.mediaSource.findUnique({ where: { canonicalId } });
    if (existing) {
      if (isUpload && existing.ownerUserId && existing.ownerUserId !== input.ownerUserId) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          message: 'Cannot register or claim another user’s private upload MediaSource.',
        });
      }
      return existing;
    }

    // Fail-closed defaults:
    // - Uploads default to USER_OWNED + PRIVATE_USER + DIRECT_UPLOAD (never SHARED_PERMITTED)
    // - External URLs/broadcasts/VODs default to UNKNOWN + NONE + UNSUPPORTED until explicitly granted
    const defaultRightsStatus: MediaRightsStatusEnum = isUpload ? 'USER_OWNED' : 'UNKNOWN';
    const defaultRightsScope = isUpload ? 'PRIVATE_USER' : 'NONE';
    const defaultCapability: MediaAcquisitionCapabilityEnum = isUpload
      ? 'DIRECT_UPLOAD'
      : 'UNSUPPORTED';
    const defaultProvenance = isUpload ? 'USER_DIRECT_UPLOAD' : 'UNVERIFIED';

    try {
      const created = await this.db.$transaction(async (tx) => {
        const ms = await tx.mediaSource.create({
          data: {
            canonicalId,
            identityScope: input.identityScope as MediaIdentityScopeEnum,
            provider: toPrismaProvider(input.provider),
            sourceType: toPrismaSourceType(input.sourceType),
            externalId: input.externalId,
            channelId: input.channelId,
            broadcastId: input.broadcastId,
            vodId: input.vodId,
            associatedLiveSourceId: input.associatedLiveSourceId,
            sourceRevision: input.sourceRevision ?? 'v1',
            normalizedUrl: input.normalizedUrl,
            availability: (input.availability ?? (isUpload ? 'AVAILABLE' : 'UNKNOWN')) as MediaSourceAvailabilityEnum,
            acquisitionCapability: defaultCapability,
            rightsStatus: defaultRightsStatus,
            rightsScope: defaultRightsScope,
            rightsProvenance: defaultProvenance,
            ownerUserId: isUpload ? input.ownerUserId!.trim() : null,
            lastVerifiedAt: isUpload ? new Date() : null,
            retentionExpiresAt: input.retentionExpiresAt,
            metadata: sanitizePublicMetadata(input.metadata),
          },
        });

        if (isUpload) {
          await tx.mediaRightsGrant.create({
            data: {
              mediaSourceId: ms.id,
              grantScope: 'PRIVATE_OWNER',
              granteeUserId: input.ownerUserId!.trim(),
              allowAcquisition: true,
              allowSharedReuse: false,
              provenance: 'USER_DIRECT_UPLOAD',
              grantedBy: 'system:upload-registry',
              reason: 'Authenticated owner uploaded source footage.',
            },
          });
        }

        return ms;
      });
      return created;
    } catch (err: any) {
      // Concurrent creation race on unique canonicalId -> return winning row cleanly
      if (err?.code === 'P2002') {
        const winner = await this.db.mediaSource.findUnique({ where: { canonicalId } });
        if (winner) {
          if (isUpload && winner.ownerUserId && winner.ownerUserId !== input.ownerUserId) {
            throw new MediaSourceError({
              code: 'ACCESS_DENIED',
              message: 'Cannot claim another user’s private upload MediaSource.',
            });
          }
          return winner;
        }
      }
      throw err;
    }
  }

  /**
   * Records a server-authoritative permission grant for a MediaSource (e.g. controlled test
   * grant or verified platform grant). Never exposed to unauthenticated or untrusted client payloads.
   */
  async grantSourceRights(input: GrantSourceRightsInput): Promise<{
    mediaSource: MediaSource;
    grant: MediaRightsGrant;
  }> {
    if (!input.grantedBy.trim() || !input.provenance.trim()) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Server provenance and grantedBy are required for rights grants.',
      });
    }

    return await this.db.$transaction(async (tx) => {
      const source = await tx.mediaSource.findUnique({
        where: { canonicalId: input.canonicalSourceId },
      });
      if (!source) {
        throw new MediaSourceError({
          code: 'SOURCE_UNAVAILABLE',
          message: `MediaSource "${input.canonicalSourceId}" not found.`,
        });
      }

      if (source.provider === 'UPLOAD' && input.allowSharedReuse) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          message: 'Private user uploads cannot be placed into SHARED_PERMITTED cross-user cache scope.',
        });
      }

      if (source.rightsStatus === 'RESTRICTED_DRM' && input.rightsStatus !== 'PERMITTED_PUBLIC') {
        throw new MediaSourceError({
          code: 'DRM_RESTRICTED',
          message: `Cannot grant acquisition on DRM-restricted source "${source.canonicalId}".`,
        });
      }

      const grant = await tx.mediaRightsGrant.create({
        data: {
          mediaSourceId: source.id,
          grantScope: input.grantScope,
          granteeUserId: input.granteeUserId ?? null,
          allowAcquisition: input.allowAcquisition,
          allowSharedReuse: source.provider === 'UPLOAD' ? false : input.allowSharedReuse,
          provenance: input.provenance.trim(),
          grantedBy: input.grantedBy.trim(),
          reason: input.reason,
          expiresAt: input.expiresAt,
        },
      });

      const nextCapability: MediaAcquisitionCapabilityEnum =
        input.acquisitionCapability ??
        (source.provider === 'UPLOAD'
          ? 'DIRECT_UPLOAD'
          : input.allowAcquisition
            ? 'PERMITTED_STREAM'
            : source.acquisitionCapability);

      const nextRightsStatus: MediaRightsStatusEnum =
        input.rightsStatus ??
        (source.provider === 'UPLOAD'
          ? 'USER_OWNED'
          : input.allowSharedReuse
            ? 'PERMITTED_PUBLIC'
            : input.allowAcquisition
              ? 'REQUIRES_AUTHORIZATION'
              : source.rightsStatus);

      const nextRightsScope =
        source.provider === 'UPLOAD'
          ? 'PRIVATE_USER'
          : input.allowSharedReuse
            ? 'SHARED_PERMITTED'
            : input.grantScope === 'PRIVATE_OWNER'
              ? 'PRIVATE_USER'
              : 'NONE';

      const updated = await tx.mediaSource.update({
        where: { id: source.id },
        data: {
          acquisitionCapability: nextCapability,
          rightsStatus: nextRightsStatus,
          rightsScope: nextRightsScope,
          rightsProvenance: input.provenance.trim(),
          lastVerifiedAt: new Date(),
        },
      });

      return { mediaSource: updated, grant };
    });
  }

  /**
   * Explicitly marks a MediaSource as RESTRICTED_DRM or DENIED (revoking any active grants).
   */
  async markSourceRestricted(input: {
    canonicalSourceId: string;
    rightsStatus: 'RESTRICTED_DRM' | 'DENIED';
    reason: string;
  }): Promise<MediaSource> {
    const now = new Date();
    return await this.db.$transaction(async (tx) => {
      const source = await tx.mediaSource.findUnique({
        where: { canonicalId: input.canonicalSourceId },
      });
      if (!source) {
        throw new MediaSourceError({
          code: 'SOURCE_UNAVAILABLE',
          message: `MediaSource "${input.canonicalSourceId}" not found.`,
        });
      }
      await tx.mediaRightsGrant.updateMany({
        where: { mediaSourceId: source.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: input.reason },
      });
      return tx.mediaSource.update({
        where: { id: source.id },
        data: {
          rightsStatus: input.rightsStatus,
          rightsScope: 'NONE',
          acquisitionCapability: 'UNSUPPORTED',
          rightsProvenance: `RESTRICTED:${input.rightsStatus}`,
          lastVerifiedAt: now,
        },
      });
    });
  }

  /**
   * Revokes active sharing/acquisition grants for a MediaSource so subsequent cache reads
   * and publications are blocked immediately.
   */
  async revokeSourceRights(input: RevokeSourceRightsInput): Promise<{
    mediaSource: MediaSource;
    revokedCount: number;
  }> {
    const now = new Date();
    return await this.db.$transaction(async (tx) => {
      const source = await tx.mediaSource.findUnique({
        where: { canonicalId: input.canonicalSourceId },
      });
      if (!source) {
        throw new MediaSourceError({
          code: 'SOURCE_UNAVAILABLE',
          message: `MediaSource "${input.canonicalSourceId}" not found.`,
        });
      }

      const where: Prisma.MediaRightsGrantWhereInput = input.grantId
        ? { id: input.grantId, mediaSourceId: source.id, revokedAt: null }
        : { mediaSourceId: source.id, revokedAt: null };

      const revoked = await tx.mediaRightsGrant.updateMany({
        where,
        data: {
          revokedAt: now,
          revokedReason: input.revokedReason,
        },
      });

      // Re-evaluate remaining active non-expired grants
      const remaining = await tx.mediaRightsGrant.findMany({
        where: {
          mediaSourceId: source.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });

      const hasShared = remaining.some((g) => g.allowSharedReuse);
      const hasAcq = remaining.some((g) => g.allowAcquisition);

      const nextRightsStatus: MediaRightsStatusEnum =
        source.provider === 'UPLOAD'
          ? 'USER_OWNED'
          : hasShared
            ? 'PERMITTED_PUBLIC'
            : (input.fallbackRightsStatus ?? 'DENIED');

      const nextRightsScope =
        source.provider === 'UPLOAD'
          ? 'PRIVATE_USER'
          : hasShared
            ? 'SHARED_PERMITTED'
            : 'NONE';

      const nextCapability: MediaAcquisitionCapabilityEnum =
        source.provider === 'UPLOAD'
          ? 'DIRECT_UPLOAD'
          : hasAcq
            ? source.acquisitionCapability
            : 'UNSUPPORTED';

      const updated = await tx.mediaSource.update({
        where: { id: source.id },
        data: {
          rightsStatus: nextRightsStatus,
          rightsScope: nextRightsScope,
          acquisitionCapability: nextCapability,
          rightsProvenance: hasShared ? source.rightsProvenance : 'REVOKED',
          lastVerifiedAt: now,
        },
      });

      return { mediaSource: updated, revokedCount: revoked.count };
    });
  }

  /**
   * Resolves a server-authoritative TrustedCacheAuthContext strictly from PostgreSQL
   * MediaSource + active MediaRightsGrant rows.
   *
   * NEVER trusts client-provided rightsStatus, allowSharedCacheReuse, or ownerUserId.
   */
  async resolveServerTrustedAuth(input: {
    requesterUserId: string;
    canonicalSourceId: string;
    requireSharedReuse?: boolean;
    requireAcquisition?: boolean;
    now?: Date;
  }): Promise<ServerResolvedAuthResult> {
    const requesterUserId = input.requesterUserId?.trim();
    if (!requesterUserId) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Authenticated requesterUserId is required.',
      });
    }

    const now = input.now ?? new Date();
    const source = await this.db.mediaSource.findUnique({
      where: { canonicalId: input.canonicalSourceId },
      include: {
        rightsGrants: true,
      },
    });

    if (!source) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `MediaSource "${input.canonicalSourceId}" is not registered.`,
      });
    }

    if (source.rightsStatus === 'RESTRICTED_DRM') {
      throw new MediaSourceError({
        code: 'DRM_RESTRICTED',
        message: `Access denied: source "${source.canonicalId}" is DRM-restricted.`,
      });
    }

    if (source.rightsStatus === 'DENIED') {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: `Access denied: rights for "${source.canonicalId}" are denied or revoked.`,
      });
    }

    const activeGrants = source.rightsGrants.filter(
      (g) => g.revokedAt === null && (g.expiresAt === null || g.expiresAt.getTime() > now.getTime()),
    );
    const hadRevokedGrant = source.rightsGrants.some((g) => g.revokedAt !== null);

    // Private direct user upload: strictly owner-only!
    if (source.provider === 'UPLOAD') {
      if (!source.ownerUserId || source.ownerUserId !== requesterUserId) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          message: 'Cross-user access to private uploaded MediaSource is prohibited.',
        });
      }
      if (input.requireSharedReuse) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          message: 'Private user uploads are not eligible for SHARED_PERMITTED cross-user cache reuse.',
        });
      }
    }

    const relevantGrants = activeGrants.filter(
      (g) => g.granteeUserId === null || g.granteeUserId === requesterUserId,
    );
    const allowAcquisition =
      source.provider === 'UPLOAD'
        ? source.ownerUserId === requesterUserId
        : relevantGrants.some((g) => g.allowAcquisition);
    const allowSharedReuse =
      source.provider !== 'UPLOAD' &&
      source.rightsStatus === 'PERMITTED_PUBLIC' &&
      relevantGrants.some((g) => g.allowSharedReuse);

    if (input.requireAcquisition && !allowAcquisition) {
      throw new MediaSourceError({
        code: hadRevokedGrant ? 'ACCESS_DENIED' : 'RIGHTS_UNVERIFIED',
        message: hadRevokedGrant
          ? `Acquisition permission for "${source.canonicalId}" has been revoked or expired.`
          : `Acquisition permission for "${source.canonicalId}" is unverified.`,
      });
    }

    if (input.requireSharedReuse && !allowSharedReuse) {
      throw new MediaSourceError({
        code: hadRevokedGrant ? 'ACCESS_DENIED' : 'RIGHTS_UNVERIFIED',
        message: hadRevokedGrant
          ? `Shared cache reuse permission for "${source.canonicalId}" has been revoked or expired.`
          : `Shared cache reuse for "${source.canonicalId}" requires an active verified server grant.`,
      });
    }

    const effectiveRightsStatus: RightsAccessStatus =
      source.provider === 'UPLOAD'
        ? 'USER_OWNED'
        : allowSharedReuse
          ? 'PERMITTED_PUBLIC'
          : (source.rightsStatus as RightsAccessStatus);

    const universalSource: UniversalMediaSource = UniversalMediaSourceSchema.parse({
      canonicalId: source.canonicalId as CacheableSourceId,
      identityScope: source.identityScope,
      provider: fromPrismaProvider(source.provider),
      sourceType: fromPrismaSourceType(source.sourceType),
      externalId: source.externalId,
      channelId: source.channelId ?? undefined,
      broadcastId: source.broadcastId ?? undefined,
      normalizedUrl: source.normalizedUrl ?? undefined,
      availability: source.availability as SourceAvailability,
      acquisitionCapability: source.acquisitionCapability as AcquisitionCapability,
      rightsStatus: effectiveRightsStatus,
      ingestionStatus: 'PENDING',
    });

    const auth = createTrustedCacheAuthContext({
      source: universalSource,
      requesterUserId,
      ownerUserId: source.ownerUserId ?? (source.provider !== 'UPLOAD' ? requesterUserId : undefined),
      allowSharedCacheReuse: allowSharedReuse,
    });

    const effectiveRightsScope: CacheRightsScope | 'NONE' =
      source.provider === 'UPLOAD'
        ? 'PRIVATE_USER'
        : allowSharedReuse
          ? 'SHARED_PERMITTED'
          : 'NONE';

    return {
      auth,
      mediaSource: source,
      activeGrants: relevantGrants,
      allowAcquisition,
      allowSharedReuse,
      effectiveRightsScope,
    };
  }

  /**
   * Links a user's private Project to an authorized MediaSource while preserving strict
   * per-user Project ownership. Many users can reference the same shared eligible MediaSource
   * while their private Projects, timelines, versions, and renders remain isolated.
   */
  async linkProjectToMediaSource(input: {
    projectId: string;
    requesterUserId: string;
    canonicalSourceId: string;
  }): Promise<{ projectId: string; mediaSourceId: string }> {
    const project = await this.db.project.findUnique({ where: { id: input.projectId } });
    if (!project) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `Project "${input.projectId}" not found.`,
      });
    }
    if (project.userId !== input.requesterUserId) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Cannot link a MediaSource to another user’s private Project.',
      });
    }

    const resolved = await this.resolveServerTrustedAuth({
      requesterUserId: input.requesterUserId,
      canonicalSourceId: input.canonicalSourceId,
    });

    if (
      resolved.mediaSource.provider !== 'UPLOAD' &&
      !resolved.allowSharedReuse &&
      !resolved.allowAcquisition
    ) {
      throw new MediaSourceError({
        code: 'RIGHTS_UNVERIFIED',
        message: `Source "${input.canonicalSourceId}" does not have verified rights for project linking.`,
      });
    }

    await this.db.project.update({
      where: { id: project.id },
      data: { mediaSourceId: resolved.mediaSource.id },
    });

    return { projectId: project.id, mediaSourceId: resolved.mediaSource.id };
  }

  async getMediaSourceByCanonicalId(canonicalId: string): Promise<MediaSource | null> {
    return this.db.mediaSource.findUnique({ where: { canonicalId } });
  }
}
