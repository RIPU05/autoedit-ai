import crypto from 'node:crypto';
import {
  CacheableSourceIdSchema,
  SharedCacheIdentitySchema,
  SharedCacheKeyInputSchema,
  UniversalMediaSourceSchema,
  type CacheArtifactKind,
  type CacheRenderSettings,
  type CacheRightsScope,
  type CacheTimeRangeSec,
  type RightsAccessStatus,
  type SharedCacheIdentity,
  type SharedCacheKeyInput,
  type UniversalMediaSource,
} from '@autoedit/contracts';
import type { MediaStorageProvider } from '../storage/storage.types.js';
import { MediaSourceError } from './errors.js';

const TRUSTED_CACHE_AUTH_BRAND = Symbol('autoedit.trustedCacheAuthContext');

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
 * Server-trusted cache authorization context.
 * Symbol-branded so untrusted callers cannot forge plain object literals claiming
 * PERMITTED_PUBLIC or another user's ownerUserId.
 */
export interface TrustedCacheAuthContext {
  readonly [TRUSTED_CACHE_AUTH_BRAND]: true;
  readonly source: UniversalMediaSource;
  readonly requesterUserId: string;
  readonly ownerUserId?: string;
  readonly verifiedRightsStatus: RightsAccessStatus;
  readonly allowSharedCacheReuse: boolean;
}

export interface CreateTrustedCacheAuthInput {
  /** Server-resolved UniversalMediaSource (must be an immutable broadcast, VOD, or upload). */
  source: UniversalMediaSource;
  /** Authenticated user ID from server JWT/session middleware. */
  requesterUserId: string;
  /** Server-verified asset/project owner user ID (required for PRIVATE_USER / USER_OWNED access). */
  ownerUserId?: string;
  /**
   * Explicit server-policy grant permitting cross-user shared cache reuse.
   * Defaults to false; even if true, shared reuse is denied unless source.rightsStatus === 'PERMITTED_PUBLIC'.
   */
  allowSharedCacheReuse?: boolean;
}

/**
 * Constructs a frozen, server-trusted authorization context from verified source metadata
 * and authenticated session identity.
 *
 * SECURITY / TRUST BOUNDARY:
 * - Symbol branding prevents in-process plain-object forgery, NOT persistent authorization.
 * - HTTP route handlers MUST NEVER pass untrusted client-supplied `source` JSON into this
 *   helper. `source` and `ownerUserId` MUST be hydrated from server-side authoritative
 *   resolution/storage (e.g. PostgreSQL `Project`/`Asset`/`MediaSource` rows in future steps).
 * - Setting `source.rightsStatus = 'PERMITTED_PUBLIC'` alone NEVER grants shared cache reuse;
 *   `allowSharedCacheReuse: true` must also be explicitly granted by server policy.
 */
export function createTrustedCacheAuthContext(
  input: CreateTrustedCacheAuthInput,
): TrustedCacheAuthContext {
  const requesterUserId = input.requesterUserId?.trim();
  if (!requesterUserId) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: 'Authenticated requesterUserId is required for cache authorization.',
    });
  }

  const parsedSource = UniversalMediaSourceSchema.safeParse(input.source);
  if (!parsedSource.success) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: 'Invalid media source metadata rejected by cache authorization.',
    });
  }
  const source = parsedSource.data;

  if (source.identityScope === 'CHANNEL_DISCOVERY') {
    throw new MediaSourceError({
      code: 'BROADCAST_UNRESOLVED',
      message: `Cannot authorize cache access for channel-only identity "${source.canonicalId}". A verified broadcast session ID is required.`,
      retryable: true,
    });
  }

  const parsedCacheable = CacheableSourceIdSchema.safeParse(source.canonicalId);
  if (!parsedCacheable.success) {
    throw new MediaSourceError({
      code: 'BROADCAST_UNRESOLVED',
      message: `Source "${source.canonicalId}" is not an immutable cacheable identity.`,
    });
  }

  const verifiedRightsStatus = source.rightsStatus;
  const allowSharedCacheReuse =
    input.allowSharedCacheReuse === true &&
    verifiedRightsStatus === 'PERMITTED_PUBLIC' &&
    source.provider !== 'upload';

  return Object.freeze({
    [TRUSTED_CACHE_AUTH_BRAND]: true as const,
    source: Object.freeze({ ...source }),
    requesterUserId,
    ownerUserId: input.ownerUserId?.trim() || undefined,
    verifiedRightsStatus,
    allowSharedCacheReuse,
  });
}

function assertTrustedAuthContext(auth: unknown): asserts auth is TrustedCacheAuthContext {
  if (
    !auth ||
    typeof auth !== 'object' ||
    (auth as Record<symbol, unknown>)[TRUSTED_CACHE_AUTH_BRAND] !== true
  ) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: 'Untrusted or forged cache authorization context rejected.',
    });
  }
}

export interface CacheArtifactDescriptor {
  artifactKind: CacheArtifactKind;
  sourceRevision?: string;
  timeRangeSec?: CacheTimeRangeSec;
  algorithmVersion?: string;
  renderSettings?: CacheRenderSettings;
  rightsScope: CacheRightsScope;
}

/**
 * Builds a deterministic, collision-resistant cache identity and private storage key.
 *
 * Strict isolation rules:
 * - Channel-only discovery IDs (`:channel:`) are rejected by CacheableSourceIdSchema.
 * - Direct user uploads (`upload:uploaded:...`) cannot be placed in SHARED_PERMITTED scope.
 * - Personalized edits (`renderSettings.customEditHash`) cannot be placed in SHARED_PERMITTED scope.
 * - Different time ranges, render settings, model versions, or revisions always produce distinct keys.
 */
export function buildSharedCacheIdentity(rawInput: SharedCacheKeyInput): SharedCacheIdentity {
  if (typeof rawInput?.canonicalSourceId === 'string' && rawInput.canonicalSourceId.includes(':channel:')) {
    throw new MediaSourceError({
      code: 'BROADCAST_UNRESOLVED',
      message: `Channel-only identity "${rawInput.canonicalSourceId}" cannot be used for immutable cache keys.`,
      retryable: true,
    });
  }

  const input = SharedCacheKeyInputSchema.parse(rawInput);

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

/**
 * Reconstructs and authorizes a SharedCacheIdentity strictly from a server-trusted
 * TrustedCacheAuthContext + artifact descriptor. Never trusts caller-supplied storage keys
 * or caller-asserted rights statuses.
 */
export function resolveAuthorizedCacheIdentity(
  auth: TrustedCacheAuthContext,
  descriptor: CacheArtifactDescriptor,
): SharedCacheIdentity {
  assertTrustedAuthContext(auth);

  if (auth.verifiedRightsStatus === 'RESTRICTED_DRM') {
    throw new MediaSourceError({
      code: 'DRM_RESTRICTED',
      message: `Cache access denied: source ${auth.source.canonicalId} is DRM-restricted.`,
    });
  }

  if (
    auth.verifiedRightsStatus === 'DENIED' ||
    auth.verifiedRightsStatus === 'REQUIRES_AUTHORIZATION'
  ) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: `Cache access denied: insufficient rights for ${auth.source.canonicalId}.`,
    });
  }

  if (descriptor.rightsScope === 'SHARED_PERMITTED') {
    if (!auth.allowSharedCacheReuse || auth.verifiedRightsStatus !== 'PERMITTED_PUBLIC') {
      throw new MediaSourceError({
        code: 'RIGHTS_UNVERIFIED',
        message: `Shared cache reuse denied for ${auth.source.canonicalId}: explicit verified shared permission is required.`,
      });
    }

    return buildSharedCacheIdentity({
      artifactKind: descriptor.artifactKind,
      canonicalSourceId: auth.source.canonicalId,
      sourceRevision: descriptor.sourceRevision ?? 'v1',
      timeRangeSec: descriptor.timeRangeSec,
      algorithmVersion: descriptor.algorithmVersion ?? 'v1',
      renderSettings: descriptor.renderSettings,
      rightsScope: 'SHARED_PERMITTED',
    });
  }

  // PRIVATE_USER scope: must have verified owner matching authenticated requester
  if (auth.verifiedRightsStatus === 'UNKNOWN') {
    throw new MediaSourceError({
      code: 'RIGHTS_UNVERIFIED',
      message: `Private cache access denied for ${auth.source.canonicalId}: source rights are UNKNOWN.`,
    });
  }

  const effectiveOwner = auth.ownerUserId;
  if (!effectiveOwner || effectiveOwner !== auth.requesterUserId) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: 'Cross-user access to PRIVATE_USER cached artifacts is prohibited.',
    });
  }

  return buildSharedCacheIdentity({
    artifactKind: descriptor.artifactKind,
    canonicalSourceId: auth.source.canonicalId,
    sourceRevision: descriptor.sourceRevision ?? 'v1',
    timeRangeSec: descriptor.timeRangeSec,
    algorithmVersion: descriptor.algorithmVersion ?? 'v1',
    renderSettings: descriptor.renderSettings,
    rightsScope: 'PRIVATE_USER',
    ownerUserId: effectiveOwner,
  });
}

/**
 * Validates a candidate/untrusted SharedCacheIdentity against the server-reconstructed
 * identity so callers cannot substitute another user's private storageKey or cacheKey.
 */
export function assertVerifiedCacheIdentity(
  auth: TrustedCacheAuthContext,
  descriptor: CacheArtifactDescriptor,
  candidateIdentity: SharedCacheIdentity,
): SharedCacheIdentity {
  const expected = resolveAuthorizedCacheIdentity(auth, descriptor);
  if (
    candidateIdentity.cacheKey !== expected.cacheKey ||
    candidateIdentity.storageKey !== expected.storageKey ||
    candidateIdentity.canonicalSourceId !== expected.canonicalSourceId ||
    candidateIdentity.rightsScope !== expected.rightsScope ||
    candidateIdentity.ownerUserId !== expected.ownerUserId
  ) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: 'Forged or substituted cache identity / storage key rejected.',
    });
  }
  return expected;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

function assertAuthorizedObjectKey(identity: SharedCacheIdentity, objectKey: string): void {
  const valid =
    objectKey === identity.storageKey ||
    objectKey === `${identity.storageKey}.manifest.json` ||
    objectKey.startsWith(`${identity.storageKey}/v/`);
  if (!valid || objectKey.includes('..')) {
    throw new MediaSourceError({
      code: 'ACCESS_DENIED',
      message: `Object key "${objectKey}" is outside authorized cache prefix for ${identity.cacheKey}.`,
    });
  }
}

/**
 * Thin cache storage adapter reusing the existing MediaStorageProvider.
 * All cache reads, writes, and signed URLs reconstruct and authorize the storage key
 * from a server-trusted TrustedCacheAuthContext before touching object storage.
 */
export class SharedArtifactCacheService {
  constructor(private readonly storage: MediaStorageProvider) {}

  async checkCachedArtifact(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
  ): Promise<{ hit: boolean; cacheKey: string; sizeBytes?: number; etag?: string }> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    try {
      const meta = await this.storage.getObjectMetadata({ key: identity.storageKey });
      return {
        hit: true,
        cacheKey: identity.cacheKey,
        sizeBytes: meta.contentLength,
        etag: meta.etag,
      };
    } catch {
      return { hit: false, cacheKey: identity.cacheKey };
    }
  }

  async putCachedArtifact(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<{ cacheKey: string; rightsScope: CacheRightsScope; etag?: string }> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    const normalizedBody = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
    const out = await this.storage.putObject({
      key: identity.storageKey,
      body: normalizedBody,
      contentType,
    });
    return {
      cacheKey: identity.cacheKey,
      rightsScope: identity.rightsScope,
      etag: out.etag,
    };
  }

  async createAuthorizedDownloadUrl(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
    opts?: { expiresIn?: number },
  ): Promise<string> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    return this.storage.createDownloadUrl({
      key: identity.storageKey,
      expiresIn: opts?.expiresIn ?? 900,
    });
  }

  /**
   * Stores an immutable versioned artifact under `<storageKey>/v/<versionTag>` so
   * stale workers or failed replacement attempts can never overwrite an existing healthy object.
   */
  async putVersionedArtifact(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
    versionTag: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<{
    cacheKey: string;
    storageKey: string;
    objectKey: string;
    rightsScope: CacheRightsScope;
    etag?: string;
  }> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    const safeTag = versionTag.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${identity.storageKey}/v/${safeTag}`;
    assertAuthorizedObjectKey(identity, objectKey);
    const out = await this.storage.putObject({
      key: objectKey,
      body,
      contentType,
    });
    return {
      cacheKey: identity.cacheKey,
      storageKey: identity.storageKey,
      objectKey,
      rightsScope: identity.rightsScope,
      etag: out.etag,
    };
  }

  async putCachedManifest(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
    manifest: unknown,
  ): Promise<{ cacheKey: string; manifestKey: string; etag?: string }> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    const manifestKey = `${identity.storageKey}.manifest.json`;
    const body = Buffer.from(JSON.stringify(manifest), 'utf-8');
    const out = await this.storage.putObject({
      key: manifestKey,
      body,
      contentType: 'application/json',
    });
    return { cacheKey: identity.cacheKey, manifestKey, etag: out.etag };
  }

  async getCachedManifest<T>(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
  ): Promise<{ cacheKey: string; manifestKey: string; data: T } | null> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    const manifestKey = `${identity.storageKey}.manifest.json`;
    try {
      const obj = await this.storage.getObject({ key: manifestKey });
      const buf = await streamToBuffer(obj.body);
      const data = JSON.parse(buf.toString('utf-8')) as T;
      return { cacheKey: identity.cacheKey, manifestKey, data };
    } catch {
      return null;
    }
  }

  async checkObjectAtKey(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
    objectKey: string,
  ): Promise<{ hit: boolean; cacheKey: string; sizeBytes?: number; etag?: string }> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    assertAuthorizedObjectKey(identity, objectKey);
    try {
      const meta = await this.storage.getObjectMetadata({ key: objectKey });
      return {
        hit: true,
        cacheKey: identity.cacheKey,
        sizeBytes: meta.contentLength,
        etag: meta.etag,
      };
    } catch {
      return { hit: false, cacheKey: identity.cacheKey };
    }
  }

  async getObjectBytesAtKey(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
    objectKey: string,
  ): Promise<Buffer | null> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    assertAuthorizedObjectKey(identity, objectKey);
    try {
      const obj = await this.storage.getObject({ key: objectKey });
      return await streamToBuffer(obj.body);
    } catch {
      return null;
    }
  }

  async createAuthorizedDownloadUrlForObject(
    auth: TrustedCacheAuthContext,
    descriptor: CacheArtifactDescriptor,
    objectKey: string,
    opts?: { expiresIn?: number },
  ): Promise<string> {
    const identity = resolveAuthorizedCacheIdentity(auth, descriptor);
    assertAuthorizedObjectKey(identity, objectKey);
    return this.storage.createDownloadUrl({
      key: objectKey,
      expiresIn: opts?.expiresIn ?? 900,
    });
  }
}
