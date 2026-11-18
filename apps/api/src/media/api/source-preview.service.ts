import type { PrismaClient } from '@prisma/client';
import type { CacheRightsScope, ProjectSourcePreviewResponse } from '@autoedit/contracts';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { getStorageProvider } from '../../storage/index.js';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import { DurableMediaRegistryService } from '../durable-media-registry.js';
import { DurableArtifactPublisher } from '../durable-artifact-publisher.js';
import type { CacheArtifactDescriptor } from '../shared-cache.js';
import { MediaSourceError } from '../errors.js';

export const SOURCE_PREVIEW_MAX_TTL_SEC = 300;

export interface VerifiedProjectSourcePreviewInput {
  userId: string;
  projectId: string;
  db?: PrismaClient;
  storage?: MediaStorageProvider;
  expiresInSec?: number;
  now?: Date;
}

/**
 * Authoritative server-side full-source preview URL resolver (Step 3C.1.1).
 *
 * Guarantees:
 * - Authenticates & verifies private Project ownership (returns 404 to non-owners).
 * - Never accepts or trusts client-supplied object keys.
 * - For MediaSource-backed projects:
 *   - Re-verifies live PostgreSQL rights & grants via DurableMediaRegistryService.
 *   - Resolves strictly `SOURCE_MEDIA` via `DurableArtifactPublisher.getAuthorizedPublishedArtifact`
 *     matching exact `project.mediaSource.sourceRevision`.
 *   - NEVER silently substitutes a `BASE_CLIP` as full project source.
 *   - Validates `publishedGeneration >= 1`, state, expiration, and MinIO HEAD size/ETag integrity.
 * - For private upload (`sourceAsset`) projects:
 *   - Verifies object existence and size integrity in MinIO before signing.
 * - Issues short-lived (<= 300s) signed URLs and sanitizes all errors so raw storage keys never leak.
 */
export async function getVerifiedProjectSourcePreview(
  input: VerifiedProjectSourcePreviewInput,
): Promise<ProjectSourcePreviewResponse> {
  const db = input.db ?? defaultPrisma;
  const storage = input.storage ?? getStorageProvider();
  const now = input.now ?? new Date();
  const ttl = Math.max(60, Math.min(SOURCE_PREVIEW_MAX_TTL_SEC, input.expiresInSec ?? SOURCE_PREVIEW_MAX_TTL_SEC));

  const project = await db.project.findFirst({
    where: { id: input.projectId, userId: input.userId },
    include: { sourceAsset: true, mediaSource: true },
  });

  if (!project) {
    throw new MediaSourceError({
      code: 'SOURCE_UNAVAILABLE',
      statusCode: 404,
      message: 'Project not found.',
    });
  }

  // 1. Direct private upload project (`sourceAsset`)
  if (project.sourceAsset) {
    const asset = project.sourceAsset;
    if (!asset.s3Key || asset.s3Key.includes('..') || asset.s3Key.startsWith('/')) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        statusCode: 502,
        message: 'Uploaded source metadata is invalid.',
      });
    }

    let meta;
    try {
      meta = await storage.getObjectMetadata({
        key: asset.s3Key,
        bucket: asset.bucket,
      });
    } catch {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Uploaded source video is currently unavailable in storage.',
      });
    }

    const actualSize = meta.contentLength ?? 0;
    if (!Number.isFinite(actualSize) || actualSize <= 0) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        statusCode: 502,
        message: 'Uploaded source video failed storage integrity verification.',
      });
    }
    if (asset.sizeBytes > 0n && actualSize !== Number(asset.sizeBytes)) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        statusCode: 502,
        message: 'Uploaded source video failed size integrity verification.',
      });
    }

    const url = await storage.createDownloadUrl({
      key: asset.s3Key,
      bucket: asset.bucket,
      expiresIn: ttl,
    });

    return {
      url,
      expiresInSec: ttl,
      sourceKind: 'PRIVATE_UPLOAD',
    };
  }

  // 2. Shared VOD or durable MediaSource-backed project (`mediaSource`)
  if (project.mediaSource) {
    const registry = new DurableMediaRegistryService(db);
    const publisher = new DurableArtifactPublisher(db, registry, storage);
    const scope: CacheRightsScope =
      project.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';

    // Strictly SOURCE_MEDIA matching authoritative sourceRevision — NEVER substitute BASE_CLIP!
    const descriptor: CacheArtifactDescriptor = {
      artifactKind: 'SOURCE_MEDIA',
      sourceRevision: project.mediaSource.sourceRevision,
      algorithmVersion: 'vod-import-v1',
      rightsScope: scope,
    };

    try {
      const verified = await publisher.getAuthorizedPublishedArtifact({
        requesterUserId: input.userId,
        canonicalSourceId: project.mediaSource.canonicalId,
        descriptor,
        verifyInStorage: true,
        expiresIn: ttl,
        now,
      });

      // Defense-in-depth invariants: strictly SOURCE_MEDIA, matching revision, active generation & non-expired
      if (
        verified.artifact.artifactKind !== 'SOURCE_MEDIA' ||
        verified.artifact.sourceRevision !== project.mediaSource.sourceRevision ||
        verified.publishedGeneration < 1 ||
        (verified.artifact.state !== 'PUBLISHED' && verified.artifact.state !== 'REPAIRING') ||
        (verified.artifact.expiresAt && verified.artifact.expiresAt.getTime() <= now.getTime())
      ) {
        throw new MediaSourceError({
          code: 'SOURCE_UNAVAILABLE',
          statusCode: 404,
          message: 'Full source media is not retained or has expired for this project.',
        });
      }

      return {
        url: verified.downloadUrl,
        expiresInSec: ttl,
        sourceKind: 'SOURCE_MEDIA',
        sourceRevision: project.mediaSource.sourceRevision,
        publishedGeneration: verified.publishedGeneration,
      };
    } catch (err) {
      if (err instanceof MediaSourceError) {
        if (
          err.code === 'ACCESS_DENIED' ||
          err.code === 'RIGHTS_UNVERIFIED' ||
          err.code === 'DRM_RESTRICTED'
        ) {
          throw new MediaSourceError({
            code: err.code,
            statusCode: 403,
            message: 'Source access is not authorized or has been revoked.',
          });
        }
        if (err.code === 'ARTIFACT_CORRUPT') {
          throw new MediaSourceError({
            code: 'ARTIFACT_CORRUPT',
            statusCode: 502,
            message: 'Source media failed integrity verification and cannot be previewed.',
          });
        }
        if (err.code === 'SOURCE_UNAVAILABLE') {
          throw new MediaSourceError({
            code: 'SOURCE_UNAVAILABLE',
            statusCode: 404,
            message:
              'Full source video is not retained or has expired for this project. Highlight clip previews remain available when published.',
          });
        }
      }
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Full source video is currently unavailable for this project.',
      });
    }
  }

  throw new MediaSourceError({
    code: 'SOURCE_UNAVAILABLE',
    statusCode: 404,
    message: 'No source video is attached to this project.',
  });
}
