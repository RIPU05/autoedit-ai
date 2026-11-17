import crypto from 'node:crypto';
import {
  SharedCacheIdentitySchema,
  SharedCacheKeyInputSchema,
  type RightsAccessStatus,
  type SharedCacheIdentity,
  type SharedCacheKeyInput,
} from '@autoedit/contracts';
import type { MediaStorageProvider } from '../storage/storage.types.js';
import { MediaSourceError } from './errors.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/**
 * Builds a deterministic, collision-resistant cache identity and private storage key.
 *
 * Strict isolation rules:
 * - Direct user uploads (`upload:uploaded:...`) cannot be placed in SHARED_PERMITTED scope.
 * - Personalized edits (`renderSettings.customEditHash`) cannot be placed in SHARED_PERMITTED scope.
 * - Different time ranges, render settings, model versions, or revisions always produce distinct keys.
 */
export function buildSharedCacheIdentity(rawInput: SharedCacheKeyInput): SharedCacheIdentity {
  const input = SharedCacheKeyInputSchema.parse(rawInput);

  // Enforce strict SHARED vs PRIVATE boundaries
  if (input.rightsScope === 'SHARED_PERMITTED') {
    if (input.canonicalSourceId.startsWith('upload:')) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Private user uploads cannot be stored in SHARED_PERMITTED cache scope.',
      });
    }
    if (input.renderSettings?.customEditHash) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Personalized user edits (customEditHash) must remain in PRIVATE_USER scope.',
      });
    }
  }

  const normalizedPayload = {
    artifactKind: input.artifactKind,
    canonicalSourceId: input.canonicalSourceId,
    sourceRevision: input.sourceRevision,
    timeRangeSec: input.timeRangeSec
      ? {
          start: roundMs(input.timeRangeSec.start),
          end: roundMs(input.timeRangeSec.end),
        }
      : null,
    algorithmVersion: input.algorithmVersion,
    renderSettings: input.renderSettings ?? null,
    rightsScope: input.rightsScope,
    ownerUserId: input.rightsScope === 'PRIVATE_USER' ? input.ownerUserId : null,
  };

  const cacheKey = crypto
    .createHash('sha256')
    .update(stableStringify(normalizedPayload))
    .digest('hex');

  const sourceHash = crypto
    .createHash('sha256')
    .update(input.canonicalSourceId)
    .digest('hex')
    .slice(0, 16);

  const kindSlug = input.artifactKind.toLowerCase();
  const storageKey =
    input.rightsScope === 'PRIVATE_USER'
      ? `cache/private/${input.ownerUserId}/${kindSlug}/${sourceHash}/${cacheKey}`
      : `cache/shared/${kindSlug}/${sourceHash}/${cacheKey}`;

  return SharedCacheIdentitySchema.parse({
    cacheKey,
    storageKey,
    artifactKind: input.artifactKind,
    canonicalSourceId: input.canonicalSourceId,
    rightsScope: input.rightsScope,
    ownerUserId: input.rightsScope === 'PRIVATE_USER' ? input.ownerUserId : undefined,
  });
}

export interface CacheAccessRequest {
  identity: SharedCacheIdentity;
  requesterUserId: string;
  sourceRightsStatus: RightsAccessStatus;
}

/**
 * Enforces ownership and copying/reuse rights BEFORE reading, reusing, or serving
 * any cached source artifact, analysis result, or base clip.
 */
export function assertCacheAccessAllowed(req: CacheAccessRequest): void {
  if (!req.requesterUserId || !req.requesterUserId.trim()) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: 'Authenticated requesterUserId is required to access cached artifacts.',
    });
  }

  if (req.sourceRightsStatus === 'RESTRICTED_DRM') {
    throw new MediaSourceError({
      code: 'DRM_RESTRICTED',
      message: `Cache access denied: source ${req.identity.canonicalSourceId} is DRM-restricted.`,
    });
  }

  if (req.sourceRightsStatus === 'DENIED' || req.sourceRightsStatus === 'REQUIRES_AUTHORIZATION') {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: `Cache access denied: insufficient rights for ${req.identity.canonicalSourceId}.`,
    });
  }

  if (req.identity.rightsScope === 'PRIVATE_USER') {
    if (!req.identity.ownerUserId || req.identity.ownerUserId !== req.requesterUserId) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Cross-user access to PRIVATE_USER cached artifacts is prohibited.',
      });
    }
    return;
  }

  // SHARED_PERMITTED scope requires explicitly verified public-reuse permission
  if (req.sourceRightsStatus !== 'PERMITTED_PUBLIC') {
    throw new MediaSourceError({
      code: 'RIGHTS_UNVERIFIED',
      message: `Shared cache reuse blocked: source rights status "${req.sourceRightsStatus}" is not PERMITTED_PUBLIC.`,
    });
  }
}

/**
 * Thin cache storage adapter reusing the existing MediaStorageProvider.
 * All cached artifacts remain private in object storage and are only accessed
 * via short-lived presigned URLs after rights and ownership checks pass.
 */
export class SharedArtifactCacheService {
  constructor(private readonly storage: MediaStorageProvider) {}

  async checkCachedArtifact(req: CacheAccessRequest): Promise<{ hit: boolean; sizeBytes?: number }> {
    assertCacheAccessAllowed(req);
    try {
      const meta = await this.storage.getObjectMetadata({ key: req.identity.storageKey });
      return { hit: true, sizeBytes: meta.contentLength };
    } catch {
      return { hit: false };
    }
  }

  async putCachedArtifact(
    req: CacheAccessRequest,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<SharedCacheIdentity> {
    assertCacheAccessAllowed(req);
    const normalizedBody = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
    await this.storage.putObject({
      key: req.identity.storageKey,
      body: normalizedBody,
      contentType,
    });
    return req.identity;
  }

  async createAuthorizedDownloadUrl(
    req: CacheAccessRequest,
    opts?: { expiresIn?: number },
  ): Promise<string> {
    assertCacheAccessAllowed(req);
    return this.storage.createDownloadUrl({
      key: req.identity.storageKey,
      expiresIn: opts?.expiresIn ?? 900,
    });
  }
}
