import crypto from 'node:crypto';
import type {
  Prisma,
  PrismaClient,
  SharedArtifactKindEnum,
  SharedCacheArtifact,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../lib/prisma.js';
import type { MediaStorageProvider } from '../storage/storage.types.js';
import { MediaSourceError } from './errors.js';
import { DurableMediaRegistryService } from './durable-media-registry.js';
import {
  SharedArtifactCacheService,
  resolveAuthorizedCacheIdentity,
  type CacheArtifactDescriptor,
} from './shared-cache.js';
import {
  probeAndValidateClipMp4FromBuffer,
  type ProbedClipMetadata,
} from './live/highlight-clip-extractor.js';

export interface ReserveGenerationInput {
  requesterUserId: string;
  canonicalSourceId: string;
  descriptor: CacheArtifactDescriptor;
  workerId: string;
  leaseMs?: number;
  /** When true (missing/corrupt repair), conditionally reserves a new generation while keeping the prior published pointer intact until commit. */
  forceRepair?: boolean;
  /** Required for conditional repair so concurrent repair callers cannot double-reserve. */
  expectedPublishedGeneration?: number;
  /** Delayed cleanup grace window in ms for superseded attempts; defaults to 300_000 (5 min). */
  cleanupGraceMs?: number;
  now?: Date;
}

export type ReserveGenerationResult =
  | {
      action: 'ALREADY_PUBLISHED';
      artifact: SharedCacheArtifact;
      cacheKey: string;
      storageKeyPrefix: string;
    }
  | {
      action: 'ALREADY_IN_PROGRESS';
      artifact: SharedCacheArtifact;
      cacheKey: string;
      activeGeneration: number;
      activeAttemptId: string | null;
    }
  | {
      action: 'RESERVED';
      artifactId: string;
      attemptId: string;
      generation: number;
      cacheKey: string;
      storageKeyPrefix: string;
      leaseExpiresAt: Date;
    };

export interface CommitPublishedArtifactInput {
  requesterUserId: string;
  canonicalSourceId: string;
  descriptor: CacheArtifactDescriptor;
  artifactId: string;
  attemptId: string;
  generation: number;
  workerId: string;
  objectKey: string;
  contentSha256: string;
  etag?: string;
  sizeBytes: number;
  mimeType: string;
  mediaMetadata: Record<string, unknown>;
  cleanupGraceMs?: number;
  expiresAt?: Date;
  /** Optional test hook invoked inside the PostgreSQL transaction right before commit (for rollback tests). */
  onBeforeCommitInsideTx?: () => Promise<void>;
  now?: Date;
}

export interface AuthorizedPublishedArtifactResult {
  artifact: SharedCacheArtifact;
  cacheKey: string;
  objectKey: string;
  publishedGeneration: number;
  contentSha256: string;
  sizeBytes: number;
  mediaMetadata: Record<string, unknown> | null;
  downloadUrl: string;
}

export type PublishedArtifactCheckOutcome =
  | { status: 'PUBLISHED_VALID'; result: AuthorizedPublishedArtifactResult }
  | { status: 'NOT_PUBLISHED'; cacheKey: string }
  | { status: 'MISSING_OR_CORRUPT'; cacheKey: string; publishedGeneration: number; corrupt: boolean; reason: string };

function stableHashShort(val: unknown): string | null {
  if (!val) return null;
  return crypto.createHash('sha256').update(JSON.stringify(val)).digest('hex').slice(0, 16);
}

const TX_OPTS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * PostgreSQL Transactional Compare-and-Swap (CAS) Artifact Publisher & Authorized Cache Reader.
 *
 * Guarantees (independent of Redis availability):
 * - Durable monotonic generation numbers per logical cacheKey (never reset on Redis loss/eviction).
 * - Exclusive PostgreSQL row locking (`SELECT ... FOR UPDATE`) on reservation and promotion prevents
 *   two concurrent workers or simultaneous repair workers from overwriting each other.
 * - Stale workers are rejected atomically even if Redis was flushed/restarted between acquisition and commit.
 * - Failed replacements, cancellations, and rolled-back DB transactions preserve any previously valid
 *   published object intact.
 * - Uncommitted or partially validated objects are never served.
 * - Delayed orphan cleanup never deletes an object still referenced by a published artifact.
 */
export class DurableArtifactPublisher {
  readonly cache: SharedArtifactCacheService;

  constructor(
    private readonly db: PrismaClient = defaultPrisma,
    private readonly registry: DurableMediaRegistryService = new DurableMediaRegistryService(db),
    private readonly storage: MediaStorageProvider,
    private readonly probeWorkDir?: string,
  ) {
    this.cache = new SharedArtifactCacheService(storage);
  }

  /**
   * Atomically reserves the next monotonic publication generation in PostgreSQL using
   * `INSERT ... ON CONFLICT DO NOTHING` + `SELECT ... FOR UPDATE`.
   */
  async reservePublicationGeneration(
    input: ReserveGenerationInput,
  ): Promise<ReserveGenerationResult> {
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? 30_000;
    const graceMs = input.cleanupGraceMs ?? 300_000;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const cleanupEligibleAfter = new Date(now.getTime() + graceMs);

    // 1. Server-authoritative rights & identity verification BEFORE touching DB publication state
    const resolved = await this.registry.resolveServerTrustedAuth({
      requesterUserId: input.requesterUserId,
      canonicalSourceId: input.canonicalSourceId,
      requireSharedReuse: input.descriptor.rightsScope === 'SHARED_PERMITTED',
      requireAcquisition: true,
      now,
    });
    const identity = resolveAuthorizedCacheIdentity(resolved.auth, input.descriptor);
    const renderHash = stableHashShort(input.descriptor.renderSettings);

    return await this.db.$transaction(async (tx) => {
      const generatedId = `art_${crypto.randomBytes(10).toString('hex')}`;

      // Concurrency-safe insert-if-absent (avoids unique constraint abort on simultaneous first-time callers)
      await tx.$executeRaw`
        INSERT INTO "SharedCacheArtifact" (
          "id", "cacheKey", "mediaSourceId", "artifactKind", "rightsScope", "ownerUserId",
          "sourceRevision", "algorithmVersion", "renderSettingsHash",
          "windowStartSec", "windowEndSec", "state",
          "latestReservedGen", "publishedGeneration", "storageKeyPrefix",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${generatedId},
          ${identity.cacheKey},
          ${resolved.mediaSource.id},
          ${input.descriptor.artifactKind}::"SharedArtifactKindEnum",
          ${identity.rightsScope},
          ${identity.ownerUserId ?? null},
          ${input.descriptor.sourceRevision ?? 'v1'},
          ${input.descriptor.algorithmVersion ?? 'v1'},
          ${renderHash},
          ${input.descriptor.timeRangeSec?.start ?? null},
          ${input.descriptor.timeRangeSec?.end ?? null},
          'PENDING'::"SharedArtifactStateEnum",
          0,
          0,
          ${identity.storageKey},
          ${now},
          ${now}
        )
        ON CONFLICT ("cacheKey") DO NOTHING
      `;

      // Lock the logical artifact row exclusively for atomic CAS state inspection & generation reservation
      await tx.$queryRaw`
        SELECT "id" FROM "SharedCacheArtifact"
        WHERE "cacheKey" = ${identity.cacheKey}
        FOR UPDATE
      `;

      const artifact = await tx.sharedCacheArtifact.findUniqueOrThrow({
        where: { cacheKey: identity.cacheKey },
      });

      // Check already-published path
      if (artifact.state === 'PUBLISHED' && !input.forceRepair) {
        return {
          action: 'ALREADY_PUBLISHED' as const,
          artifact,
          cacheKey: identity.cacheKey,
          storageKeyPrefix: artifact.storageKeyPrefix,
        };
      }

      // Conditional repair check: if another repair worker already promoted a newer generation, reuse it!
      if (
        input.forceRepair &&
        input.expectedPublishedGeneration !== undefined &&
        artifact.publishedGeneration > input.expectedPublishedGeneration
      ) {
        return {
          action: 'ALREADY_PUBLISHED' as const,
          artifact,
          cacheKey: identity.cacheKey,
          storageKeyPrefix: artifact.storageKeyPrefix,
        };
      }

      // Check if an active, non-expired worker attempt already holds reservation
      if (artifact.activeAttemptId) {
        const activeAttempt = await tx.sharedArtifactAttempt.findUnique({
          where: { id: artifact.activeAttemptId },
        });
        if (
          activeAttempt &&
          (activeAttempt.state === 'RESERVED' || activeAttempt.state === 'UPLOADED') &&
          activeAttempt.leaseExpiresAt.getTime() > now.getTime()
        ) {
          return {
            action: 'ALREADY_IN_PROGRESS' as const,
            artifact,
            cacheKey: identity.cacheKey,
            activeGeneration: artifact.latestReservedGen,
            activeAttemptId: artifact.activeAttemptId,
          };
        }

        // Expired prior active attempt -> mark SUPERSEDED for delayed orphan cleanup
        if (
          activeAttempt &&
          (activeAttempt.state === 'RESERVED' || activeAttempt.state === 'UPLOADED')
        ) {
          await tx.sharedArtifactAttempt.update({
            where: { id: activeAttempt.id },
            data: {
              state: 'SUPERSEDED',
              errorMessage: 'Superseded after lease expiration',
              cleanupEligibleAfter,
              updatedAt: now,
            },
          });
        }
      }

      // Advance durable monotonic generation counter (never resets on Redis wipe!)
      const nextGen = artifact.latestReservedGen + 1;
      const attempt = await tx.sharedArtifactAttempt.create({
        data: {
          artifactId: artifact.id,
          generation: nextGen,
          workerId: input.workerId,
          leaseExpiresAt,
          state: 'RESERVED',
          createdAt: now,
          updatedAt: now,
        },
      });

      // Note: during repair of an already-published artifact, keep publishedObjectKey & publishedGeneration intact!
      const nextState = artifact.publishedGeneration > 0 ? 'REPAIRING' : 'PENDING';
      await tx.sharedCacheArtifact.update({
        where: { id: artifact.id },
        data: {
          latestReservedGen: nextGen,
          activeAttemptId: attempt.id,
          state: nextState,
          updatedAt: now,
        },
      });

      return {
        action: 'RESERVED' as const,
        artifactId: artifact.id,
        attemptId: attempt.id,
        generation: nextGen,
        cacheKey: identity.cacheKey,
        storageKeyPrefix: artifact.storageKeyPrefix,
        leaseExpiresAt,
      };
    }, TX_OPTS);
  }

  /**
   * Renews a reserved attempt's PostgreSQL lease conditionally if still authoritative.
   */
  async renewAttemptLease(input: {
    artifactId: string;
    attemptId: string;
    workerId: string;
    leaseMs?: number;
    now?: Date;
  }): Promise<Date> {
    const now = input.now ?? new Date();
    const nextExpiry = new Date(now.getTime() + (input.leaseMs ?? 30_000));

    return await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "SharedCacheArtifact" WHERE "id" = ${input.artifactId} FOR UPDATE
      `;
      const artifact = await tx.sharedCacheArtifact.findUnique({ where: { id: input.artifactId } });
      if (!artifact || artifact.activeAttemptId !== input.attemptId) {
        throw new MediaSourceError({
          code: 'LEASE_EXPIRED',
          message: `Attempt ${input.attemptId} is no longer active on artifact ${input.artifactId}.`,
        });
      }
      const updated = await tx.sharedArtifactAttempt.updateMany({
        where: {
          id: input.attemptId,
          artifactId: input.artifactId,
          workerId: input.workerId,
          state: { in: ['RESERVED', 'UPLOADED'] },
        },
        data: { leaseExpiresAt: nextExpiry, updatedAt: now },
      });
      if (updated.count === 0) {
        throw new MediaSourceError({
          code: 'LEASE_EXPIRED',
          message: `Worker "${input.workerId}" cannot renew superseded attempt ${input.attemptId}.`,
        });
      }
      return nextExpiry;
    }, TX_OPTS);
  }

  /**
   * Uploads immutable bytes to versioned object storage (`<prefix>/v/gen-<gen>-<sha12>.<ext>`)
   * and records the object key on the attempt row so orphan cleanup tracks it even on crash.
   */
  async uploadImmutableAttemptObject(input: {
    requesterUserId: string;
    canonicalSourceId: string;
    descriptor: CacheArtifactDescriptor;
    artifactId: string;
    attemptId: string;
    generation: number;
    workerId: string;
    body: Buffer;
    contentType: string;
    fileExt?: string;
    now?: Date;
  }): Promise<{
    objectKey: string;
    contentSha256: string;
    etag?: string;
    sizeBytes: number;
  }> {
    if (!input.body || input.body.length === 0) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        message: 'Refusing to upload empty artifact body.',
      });
    }

    const now = input.now ?? new Date();
    const resolved = await this.registry.resolveServerTrustedAuth({
      requesterUserId: input.requesterUserId,
      canonicalSourceId: input.canonicalSourceId,
      requireSharedReuse: input.descriptor.rightsScope === 'SHARED_PERMITTED',
      requireAcquisition: true,
      now,
    });

    const contentSha256 = crypto.createHash('sha256').update(input.body).digest('hex');
    const ext = (input.fileExt ?? (input.contentType.includes('mp4') ? 'mp4' : 'json')).replace(
      /[^a-zA-Z0-9]/g,
      '',
    );
    const versionTag = `gen-${input.generation}-${contentSha256.slice(0, 12)}.${ext}`;

    const putRes = await this.cache.putVersionedArtifact(
      resolved.auth,
      input.descriptor,
      versionTag,
      input.body,
      input.contentType,
    );

    // Record objectKey on attempt so even if promotion fails or worker crashes, delayed cleanup reclaims it
    await this.db.sharedArtifactAttempt.updateMany({
      where: {
        id: input.attemptId,
        artifactId: input.artifactId,
        workerId: input.workerId,
        state: { in: ['RESERVED', 'UPLOADED'] },
      },
      data: {
        state: 'UPLOADED',
        objectKey: putRes.objectKey,
        contentSha256,
        etag: putRes.etag ?? null,
        sizeBytes: BigInt(input.body.length),
        updatedAt: now,
      },
    });

    return {
      objectKey: putRes.objectKey,
      contentSha256,
      etag: putRes.etag,
      sizeBytes: input.body.length,
    };
  }

  /**
   * Atomically promotes a validated immutable artifact in PostgreSQL using row-locked CAS.
   * Rejects stale workers even if Redis restarted or lost all coordination keys.
   */
  async commitPublishedArtifact(
    input: CommitPublishedArtifactInput,
  ): Promise<SharedCacheArtifact> {
    const now = input.now ?? new Date();
    const graceMs = input.cleanupGraceMs ?? 300_000;
    const cleanupEligibleAfter = new Date(now.getTime() + graceMs);

    if (!/^[a-f0-9]{64}$/i.test(input.contentSha256)) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        message: 'commitPublishedArtifact requires a valid 64-character content SHA-256.',
      });
    }
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        message: 'commitPublishedArtifact requires positive sizeBytes.',
      });
    }

    // Re-verify server rights before opening promotion lock
    const resolved = await this.registry.resolveServerTrustedAuth({
      requesterUserId: input.requesterUserId,
      canonicalSourceId: input.canonicalSourceId,
      requireSharedReuse: input.descriptor.rightsScope === 'SHARED_PERMITTED',
      requireAcquisition: true,
      now,
    });
    const identity = resolveAuthorizedCacheIdentity(resolved.auth, input.descriptor);

    if (input.contentSha256 === identity.cacheKey) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        message: 'Refusing to commit fabricated contentSha256 equal to cacheKey.',
      });
    }
    if (!input.objectKey.startsWith(`${identity.storageKey}/v/`)) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: `Object key "${input.objectKey}" is outside authorized versioned prefix.`,
      });
    }

    const txOutcome = await this.db.$transaction(async (tx) => {
      // Exclusive row lock on SharedCacheArtifact
      await tx.$queryRaw`
        SELECT "id" FROM "SharedCacheArtifact" WHERE "id" = ${input.artifactId} FOR UPDATE
      `;

      const artifact = await tx.sharedCacheArtifact.findUnique({
        where: { id: input.artifactId },
      });
      if (!artifact || artifact.cacheKey !== identity.cacheKey) {
        return { committed: false as const, reason: 'Artifact row missing or cacheKey mismatch.' };
      }

      const attempt = await tx.sharedArtifactAttempt.findUnique({
        where: { id: input.attemptId },
      });

      const isAuthoritative =
        attempt !== null &&
        attempt.artifactId === artifact.id &&
        attempt.workerId === input.workerId &&
        attempt.generation === input.generation &&
        (attempt.state === 'RESERVED' || attempt.state === 'UPLOADED') &&
        artifact.activeAttemptId === input.attemptId &&
        artifact.latestReservedGen === input.generation &&
        artifact.publishedGeneration < input.generation;

      if (!isAuthoritative) {
        if (attempt && (attempt.state === 'RESERVED' || attempt.state === 'UPLOADED')) {
          await tx.sharedArtifactAttempt.update({
            where: { id: attempt.id },
            data: {
              state: 'SUPERSEDED',
              objectKey: attempt.objectKey ?? input.objectKey,
              errorMessage: `CAS rejected: expected active gen ${input.generation} (${input.attemptId}), current latestReservedGen=${artifact.latestReservedGen}, publishedGen=${artifact.publishedGeneration}`,
              cleanupEligibleAfter,
              updatedAt: now,
            },
          });
        }
        return {
          committed: false as const,
          reason: `Stale worker "${input.workerId}" (gen ${input.generation}) rejected by PostgreSQL CAS (latestReservedGen=${artifact.latestReservedGen}, publishedGeneration=${artifact.publishedGeneration}).`,
        };
      }

      // Optional test hook inside DB transaction (throwing here rolls back the entire transaction!)
      if (input.onBeforeCommitInsideTx) {
        await input.onBeforeCommitInsideTx();
      }

      // Mark any prior COMMITTED attempt as SUPERSEDED with delayed cleanup grace window
      await tx.sharedArtifactAttempt.updateMany({
        where: {
          artifactId: artifact.id,
          state: 'COMMITTED',
          id: { not: input.attemptId },
        },
        data: {
          state: 'SUPERSEDED',
          cleanupEligibleAfter,
          updatedAt: now,
        },
      });

      // Mark winning attempt COMMITTED
      await tx.sharedArtifactAttempt.update({
        where: { id: input.attemptId },
        data: {
          state: 'COMMITTED',
          objectKey: input.objectKey,
          contentSha256: input.contentSha256,
          etag: input.etag ?? null,
          sizeBytes: BigInt(input.sizeBytes),
          cleanupEligibleAfter: null,
          updatedAt: now,
        },
      });

      // Atomically promote authoritative published pointer!
      const promoted = await tx.sharedCacheArtifact.update({
        where: { id: artifact.id },
        data: {
          state: 'PUBLISHED',
          publishedGeneration: input.generation,
          activeAttemptId: null,
          publishedObjectKey: input.objectKey,
          contentSha256: input.contentSha256,
          etag: input.etag ?? null,
          sizeBytes: BigInt(input.sizeBytes),
          mimeType: input.mimeType,
          mediaMetadata: input.mediaMetadata as Prisma.InputJsonValue,
          expiresAt: input.expiresAt ?? artifact.expiresAt,
          updatedAt: now,
        },
      });

      return { committed: true as const, artifact: promoted };
    }, TX_OPTS);

    if (!txOutcome.committed) {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: txOutcome.reason,
      });
    }

    return txOutcome.artifact;
  }

  /**
   * Aborts a failed or cancelled publication attempt cleanly, marking its unpromoted object
   * for delayed cleanup while preserving any previously published valid version intact!
   */
  async abortPublicationAttempt(input: {
    artifactId: string;
    attemptId: string;
    workerId: string;
    reason: string;
    cancelled?: boolean;
    cleanupGraceMs?: number;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const graceMs = input.cleanupGraceMs ?? 300_000;
    const cleanupEligibleAfter = new Date(now.getTime() + graceMs);

    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "SharedCacheArtifact" WHERE "id" = ${input.artifactId} FOR UPDATE
      `;
      const artifact = await tx.sharedCacheArtifact.findUnique({
        where: { id: input.artifactId },
      });
      if (!artifact) return;

      await tx.sharedArtifactAttempt.updateMany({
        where: {
          id: input.attemptId,
          artifactId: input.artifactId,
          workerId: input.workerId,
          state: { in: ['RESERVED', 'UPLOADED'] },
        },
        data: {
          state: input.cancelled ? 'ABANDONED' : 'FAILED',
          errorMessage: input.reason,
          cleanupEligibleAfter,
          updatedAt: now,
        },
      });

      if (artifact.activeAttemptId === input.attemptId) {
        // CRITICAL: Preserve previously published valid version if one exists!
        const restoredState =
          artifact.publishedGeneration > 0 && artifact.publishedObjectKey
            ? 'PUBLISHED'
            : 'PENDING';
        await tx.sharedCacheArtifact.update({
          where: { id: artifact.id },
          data: {
            activeAttemptId: null,
            state: restoredState,
            updatedAt: now,
          },
        });
      }
    }, TX_OPTS);
  }

  /**
   * Authorizes requester against PostgreSQL MediaSource + active MediaRightsGrant,
   * loads the authoritative published SharedCacheArtifact from PostgreSQL, verifies
   * object integrity in MinIO, and issues a short-lived signed private-object download URL.
   *
   * Never trusts user-supplied storage keys or client-claimed rights.
   * Never serves uncommitted, revoked, missing, or corrupt artifacts.
   */
  async getAuthorizedPublishedArtifact(input: {
    requesterUserId: string;
    canonicalSourceId: string;
    descriptor: CacheArtifactDescriptor;
    /** Verify object HEAD + size + ETag in MinIO; defaults to true. */
    verifyInStorage?: boolean;
    /** When true, also downloads bytes and runs SHA-256 + ffprobe validation (for BASE_CLIP MP4s). */
    verifyMediaIntegrity?: boolean;
    /** Signed URL TTL in seconds; defaults to 300s (5 minutes — kept short due to signed URL revocation limits). */
    expiresIn?: number;
    now?: Date;
  }): Promise<AuthorizedPublishedArtifactResult> {
    const now = input.now ?? new Date();

    // 1–2. Authenticate requester & load authoritative server rights + grants from PostgreSQL
    const resolved = await this.registry.resolveServerTrustedAuth({
      requesterUserId: input.requesterUserId,
      canonicalSourceId: input.canonicalSourceId,
      requireSharedReuse: input.descriptor.rightsScope === 'SHARED_PERMITTED',
      now,
    });

    // 3. Reconstruct deterministic authorized cache identity (no caller-supplied keys!)
    const identity = resolveAuthorizedCacheIdentity(resolved.auth, input.descriptor);

    // 4. Load authoritative published pointer from PostgreSQL
    const artifact = await this.db.sharedCacheArtifact.findUnique({
      where: { cacheKey: identity.cacheKey },
    });

    if (
      !artifact ||
      artifact.publishedGeneration < 1 ||
      !artifact.publishedObjectKey ||
      !artifact.contentSha256 ||
      artifact.sizeBytes === null ||
      artifact.sizeBytes <= 0n ||
      (artifact.state !== 'PUBLISHED' && artifact.state !== 'REPAIRING')
    ) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `No published artifact available for cacheKey ${identity.cacheKey}.`,
      });
    }

    if (artifact.expiresAt && artifact.expiresAt.getTime() <= now.getTime()) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `Published artifact ${identity.cacheKey} has expired.`,
      });
    }

    // Strict defense-in-depth scope check
    if (
      artifact.rightsScope === 'PRIVATE_USER' &&
      artifact.ownerUserId !== resolved.auth.requesterUserId
    ) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: 'Cross-user access to PRIVATE_USER published artifact is prohibited.',
      });
    }

    const expectedSize = Number(artifact.sizeBytes);

    // 5. Verify durable object metadata & optional deep media integrity
    if (input.verifyInStorage !== false) {
      const head = await this.cache.checkObjectAtKey(
        resolved.auth,
        input.descriptor,
        artifact.publishedObjectKey,
      );
      if (!head.hit || !head.sizeBytes || head.sizeBytes <= 0) {
        throw new MediaSourceError({
          code: 'SOURCE_UNAVAILABLE',
          message: `Published object missing in storage (${artifact.publishedObjectKey}).`,
        });
      }
      if (head.sizeBytes !== expectedSize) {
        throw new MediaSourceError({
          code: 'ARTIFACT_CORRUPT',
          message: `Published object size mismatch (expected ${expectedSize}, got ${head.sizeBytes}).`,
        });
      }
      if (artifact.etag && head.etag && artifact.etag !== head.etag) {
        throw new MediaSourceError({
          code: 'ARTIFACT_CORRUPT',
          message: `Published object ETag mismatch (expected ${artifact.etag}, got ${head.etag}).`,
        });
      }

      if (input.verifyMediaIntegrity) {
        const bytes = await this.cache.getObjectBytesAtKey(
          resolved.auth,
          input.descriptor,
          artifact.publishedObjectKey,
        );
        if (!bytes || bytes.length !== expectedSize) {
          throw new MediaSourceError({
            code: 'ARTIFACT_CORRUPT',
            message: 'Published object bytes missing or truncated.',
          });
        }
        const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actualSha !== artifact.contentSha256) {
          throw new MediaSourceError({
            code: 'ARTIFACT_CORRUPT',
            message: `Published object SHA-256 mismatch (expected ${artifact.contentSha256}, got ${actualSha}).`,
          });
        }
        if (artifact.mimeType === 'video/mp4' && this.probeWorkDir) {
          try {
            const probed: ProbedClipMetadata = await probeAndValidateClipMp4FromBuffer(
              bytes,
              this.probeWorkDir,
              { requireAudio: true },
            );
            if (probed.sha256 !== artifact.contentSha256) {
              throw new Error('Probed SHA mismatch');
            }
          } catch (err) {
            throw new MediaSourceError({
              code: 'ARTIFACT_CORRUPT',
              message: `Published MP4 failed ffprobe validation: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    }

    // 6. Issue short-lived signed private-object download URL (default 300s)
    const downloadUrl = await this.cache.createAuthorizedDownloadUrlForObject(
      resolved.auth,
      input.descriptor,
      artifact.publishedObjectKey,
      { expiresIn: input.expiresIn ?? 300 },
    );

    return {
      artifact,
      cacheKey: identity.cacheKey,
      objectKey: artifact.publishedObjectKey,
      publishedGeneration: artifact.publishedGeneration,
      contentSha256: artifact.contentSha256,
      sizeBytes: expectedSize,
      mediaMetadata: (artifact.mediaMetadata as Record<string, unknown> | null) ?? null,
      downloadUrl,
    };
  }

  /**
   * Checks the authoritative PostgreSQL artifact status and MinIO integrity in one call,
   * returning the exact observed `publishedGeneration` when missing or corrupt so callers
   * can pass it directly into conditional `reservePublicationGeneration({ forceRepair: true })`
   * without any check-then-requery race window.
   */
  async inspectAuthorizedPublishedArtifact(input: {
    requesterUserId: string;
    canonicalSourceId: string;
    descriptor: CacheArtifactDescriptor;
    verifyInStorage?: boolean;
    verifyMediaIntegrity?: boolean;
    expiresIn?: number;
    now?: Date;
  }): Promise<PublishedArtifactCheckOutcome> {
    const now = input.now ?? new Date();
    // Always enforce server-authoritative rights first (throws ACCESS_DENIED / RIGHTS_UNVERIFIED / DRM_RESTRICTED)
    const resolved = await this.registry.resolveServerTrustedAuth({
      requesterUserId: input.requesterUserId,
      canonicalSourceId: input.canonicalSourceId,
      requireSharedReuse: input.descriptor.rightsScope === 'SHARED_PERMITTED',
      now,
    });
    const identity = resolveAuthorizedCacheIdentity(resolved.auth, input.descriptor);
    const artifact = await this.db.sharedCacheArtifact.findUnique({
      where: { cacheKey: identity.cacheKey },
    });

    if (
      !artifact ||
      artifact.publishedGeneration < 1 ||
      !artifact.publishedObjectKey ||
      !artifact.contentSha256 ||
      artifact.sizeBytes === null ||
      artifact.sizeBytes <= 0n ||
      (artifact.state !== 'PUBLISHED' && artifact.state !== 'REPAIRING')
    ) {
      return { status: 'NOT_PUBLISHED', cacheKey: identity.cacheKey };
    }

    try {
      const result = await this.getAuthorizedPublishedArtifact(input);
      return { status: 'PUBLISHED_VALID', result };
    } catch (err) {
      if (err instanceof MediaSourceError) {
        if (err.code === 'ARTIFACT_CORRUPT' || err.code === 'SOURCE_UNAVAILABLE') {
          return {
            status: 'MISSING_OR_CORRUPT',
            cacheKey: identity.cacheKey,
            publishedGeneration: artifact.publishedGeneration,
            corrupt: err.code === 'ARTIFACT_CORRUPT',
            reason: err.message,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Safe delayed cleanup of abandoned, failed, or superseded immutable generations.
   * NEVER deletes any object still referenced as an artifact's publishedObjectKey
   * or referenced by any COMMITTED attempt.
   */
  async cleanupAbandonedGenerations(opts?: {
    now?: Date;
    limit?: number;
  }): Promise<{ deletedKeys: string[]; skippedReferencedKeys: string[] }> {
    const now = opts?.now ?? new Date();
    const limit = opts?.limit ?? 100;

    const candidates = await this.db.sharedArtifactAttempt.findMany({
      where: {
        state: { in: ['ABANDONED', 'SUPERSEDED', 'FAILED'] },
        cleanedUpAt: null,
        objectKey: { not: null },
        cleanupEligibleAfter: { lte: now },
      },
      include: { artifact: true },
      take: limit,
      orderBy: { cleanupEligibleAfter: 'asc' },
    });

    const deletedKeys: string[] = [];
    const skippedReferencedKeys: string[] = [];

    for (const attempt of candidates) {
      const objKey = attempt.objectKey!;

      // Safety check 1: never delete current authoritative publishedObjectKey
      if (attempt.artifact.publishedObjectKey === objKey) {
        skippedReferencedKeys.push(objKey);
        continue;
      }

      // Safety check 2: never delete if any COMMITTED attempt still references this exact objectKey
      const liveRefCount = await this.db.sharedArtifactAttempt.count({
        where: {
          artifactId: attempt.artifactId,
          objectKey: objKey,
          state: 'COMMITTED',
        },
      });
      if (liveRefCount > 0) {
        skippedReferencedKeys.push(objKey);
        continue;
      }

      await this.storage.deleteObject({ key: objKey }).catch(() => {});
      await this.db.sharedArtifactAttempt.update({
        where: { id: attempt.id },
        data: { cleanedUpAt: now, updatedAt: now },
      });
      deletedKeys.push(objKey);
    }

    return { deletedKeys, skippedReferencedKeys };
  }

  async getArtifactByCacheKey(cacheKey: string): Promise<SharedCacheArtifact | null> {
    return this.db.sharedCacheArtifact.findUnique({ where: { cacheKey } });
  }
}
