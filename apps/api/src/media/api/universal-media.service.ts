import crypto from 'node:crypto';
import path from 'node:path';
import type {
  ApplyPrivateProjectEditRequest,
  ApplyPrivateProjectEditResponse,
  CacheRenderSettings,
  CacheRightsScope,
  CacheableSourceId,
  CancelPrivateRenderResponse,
  CreatePrivateRenderRequest,
  CreateProjectFromSourceRequest,
  CreateProjectFromSourceResponse,
  HighlightWindowCandidate,
  MediaApiJobStatus,
  MediaHighlightItem,
  MediaJobHighlightsResponse,
  MediaJobProcessingOptions,
  MediaJobResponse,
  MediaProcessJobPayload,
  MediaSourceProvider,
  MediaSourceType,
  PrivateRenderJobResponse,
  PrivateRenderQueuePayload,
  ResolveMediaSourceResponse,
  SourceCapabilityStatus,
  SubmitMediaJobRequest,
  UniversalMediaInput,
} from '@autoedit/contracts';
import type { MediaSourceProviderEnum, MediaSourceTypeEnum, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { connection as defaultRedis } from '../../lib/redis.js';
import { getStorageProvider } from '../../storage/index.js';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import { enqueueMediaProcess } from '../../queue/queues.js';
import { MediaSourceError } from '../errors.js';
import { PlatformSourceResolverService } from '../providers/platform-resolver.service.js';
import type { PlatformProviderConfig } from '../providers/types.js';
import {
  RedisCoordinationStore,
  SharedIngestionCoordinator,
  type RedisLikeClient,
} from '../ingestion-coordinator.js';
import { DurableMediaRegistryService } from '../durable-media-registry.js';
import { DurableArtifactPublisher } from '../durable-artifact-publisher.js';
import { UnifiedVodProcessingService } from '../vod/unified-vod-pipeline.js';
import {
  areControlledFixturesEnabled,
  getControlledTestFixture,
} from './controlled-fixture-registry.js';
import {
  SharedWorkCoordinator,
  buildGenerationBullJobId,
  type ReconcileStrandedResult,
} from './shared-work-coordinator.js';
import {
  PrivateRenderService,
  type PrivateRenderPolicyConfig,
} from './private-render.service.js';
import type { CacheArtifactDescriptor } from '../shared-cache.js';

export interface MediaApiQuotaConfig {
  /** Max simultaneous QUEUED/RUNNING user jobs per user; defaults to 5. */
  maxActiveJobsPerUser: number;
  /** Max media job submissions per user per day; defaults to 50. */
  maxDailyJobSubmissionsPerUser: number;
  /** Signed download URL TTL in seconds; defaults to 300s (5 minutes). */
  downloadUrlTtlSec: number;
  /** Max new uncached clip renders per user per day; defaults to 20. */
  maxClipsPerUserPerDay: number;
}

export const DEFAULT_MEDIA_API_QUOTAS: MediaApiQuotaConfig = {
  maxActiveJobsPerUser: 5,
  maxDailyJobSubmissionsPerUser: 50,
  downloadUrlTtlSec: 300,
  maxClipsPerUserPerDay: 20,
};

export interface UniversalMediaServiceDeps {
  db?: PrismaClient;
  storage?: MediaStorageProvider;
  redis?: RedisLikeClient;
  workRootDir?: string;
  keyPrefix?: string;
  quotas?: Partial<MediaApiQuotaConfig>;
  /** Optional durable worker lease duration in ms (defaults to 30_000). */
  leaseMs?: number;
  /** Optional max outbox enqueue retry attempts (defaults to 5). */
  maxEnqueueAttempts?: number;
  /** Optional max worker crash recovery generations (defaults to 5). */
  maxRecoveryGenerations?: number;
  /** Injectable clock for deterministic lease/recovery tests. */
  now?: () => Date;
  /** Optional test hook: if true, persists DB outbox row and skips immediate enqueue (simulates API crash before enqueue!). */
  skipImmediateEnqueue?: boolean;
  enqueueJob?: (
    payload: MediaProcessJobPayload,
    opts?: { jobId?: string },
  ) => Promise<{ id?: string }>;
  /** Optional policy override for durable background private rendering. */
  privateRenderPolicy?: Partial<PrivateRenderPolicyConfig>;
  /** Optional custom enqueue hook for private background renders (used in tests). */
  enqueuePrivateRenderJob?: (
    payload: PrivateRenderQueuePayload,
    opts?: { jobId?: string },
  ) => Promise<{ id?: string }>;
  /** Optional platform metadata & direct-media provider config (defaults to env-backed fail-closed config). */
  platformConfig?: PlatformProviderConfig;
}

/**
 * Active shared-work AbortControllers inside this process, strictly scoped by
 * `(sharedWorkKey, generation)` so cancelling generation N NEVER aborts a brand-new generation N+1!
 */
const localSharedWorkAborts = new Map<string, AbortController>();

function abortMapKey(sharedWorkKey: string, generation: number): string {
  return `${sharedWorkKey}::g${generation}`;
}

export function registerLocalSharedWorkAbort(
  sharedWorkKey: string,
  generation: number,
  ctrl: AbortController,
): void {
  localSharedWorkAborts.set(abortMapKey(sharedWorkKey, generation), ctrl);
}

export function unregisterLocalSharedWorkAbort(
  sharedWorkKey: string,
  generation: number,
): void {
  localSharedWorkAborts.delete(abortMapKey(sharedWorkKey, generation));
}

export function abortLocalSharedWorkGeneration(
  sharedWorkKey: string,
  generation: number,
  reason = 'All subscribers cancelled.',
): boolean {
  const ctrl = localSharedWorkAborts.get(abortMapKey(sharedWorkKey, generation));
  if (ctrl && !ctrl.signal.aborted) {
    ctrl.abort(new MediaSourceError({ code: 'REQUEST_CANCELLED', message: reason }));
    return true;
  }
  return false;
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

function stableHash(value: unknown, len = 24): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, len);
}

const DEFAULT_BASE_RENDER: CacheRenderSettings = {
  format: 'reel',
  width: 1280,
  height: 720,
  fps: 30,
  subtitles: false,
  zooms: false,
  transitions: 'none',
  music: false,
};

interface ResolvedInternalSource {
  response: ResolveMediaSourceResponse;
  mediaSourceId?: string;
  canonicalSourceId?: CacheableSourceId;
  rightsScope?: CacheRightsScope;
  controlledFixtureKey?: string;
  uploadProjectId?: string;
  directMediaUrl?: string;
}

/**
 * Authenticated Universal Media API Service (Step 3B.9).
 *
 * Bridges HTTP routes + BullMQ background workers to DurableMediaRegistryService,
 * DurableArtifactPublisher, UnifiedVodProcessingService, ContinuousLiveSessionService,
 * and private per-user Project/EditTimeline/EditVersion workflows.
 */
export class UniversalMediaApiService {
  readonly db: PrismaClient;
  readonly storage: MediaStorageProvider;
  readonly redis: RedisLikeClient;
  readonly registry: DurableMediaRegistryService;
  readonly publisher: DurableArtifactPublisher;
  readonly coordinator: SharedIngestionCoordinator;
  readonly sharedWork: SharedWorkCoordinator;
  readonly privateRenders: PrivateRenderService;
  readonly platformResolver: PlatformSourceResolverService;
  readonly vodService: UnifiedVodProcessingService;
  readonly quotas: MediaApiQuotaConfig;
  readonly keyPrefix: string;
  private readonly skipImmediateEnqueue: boolean;
  private readonly enqueueFn: (
    payload: MediaProcessJobPayload,
    opts: { jobId: string },
  ) => Promise<{ id?: string }>;
  private readonly localDailySubmissions = new Map<string, number>();

  constructor(deps: UniversalMediaServiceDeps = {}) {
    this.db = deps.db ?? defaultPrisma;
    this.storage = deps.storage ?? getStorageProvider();
    this.redis = deps.redis ?? (defaultRedis as unknown as RedisLikeClient);
    this.keyPrefix = deps.keyPrefix ?? 'autoedit:media:api:';
    this.quotas = { ...DEFAULT_MEDIA_API_QUOTAS, ...(deps.quotas ?? {}) };
    this.skipImmediateEnqueue = Boolean(deps.skipImmediateEnqueue);
    const workRootDir = deps.workRootDir ?? path.resolve(process.cwd(), 'tmp', 'media-api-work');

    const store = new RedisCoordinationStore(this.redis, {
      keyPrefix: `${this.keyPrefix}coord:`,
      recordTtlMs: 24 * 60 * 60 * 1000,
    });
    this.coordinator = new SharedIngestionCoordinator(store);
    this.sharedWork = new SharedWorkCoordinator(this.db, this.redis, {
      keyPrefix: this.keyPrefix,
      defaultLeaseMs: deps.leaseMs ?? 30_000,
      maxEnqueueAttempts: deps.maxEnqueueAttempts ?? 5,
      maxRecoveryGenerations: deps.maxRecoveryGenerations ?? 5,
      now: deps.now,
    });
    this.privateRenders = new PrivateRenderService({
      db: this.db,
      storage: this.storage,
      redis: this.redis,
      keyPrefix: `${this.keyPrefix}priv_render:`,
      policy: {
        downloadUrlTtlSec: this.quotas.downloadUrlTtlSec,
        ...(deps.privateRenderPolicy ?? {}),
      },
      now: deps.now,
      skipImmediateEnqueue: this.skipImmediateEnqueue,
      enqueueJob: deps.enqueuePrivateRenderJob,
    });
    this.platformResolver = new PlatformSourceResolverService(deps.platformConfig);
    this.registry = new DurableMediaRegistryService(this.db);
    this.publisher = new DurableArtifactPublisher(
      this.db,
      this.registry,
      this.storage,
      path.join(workRootDir, 'probe'),
    );
    this.vodService = new UnifiedVodProcessingService(
      this.db,
      this.coordinator,
      this.storage,
      workRootDir,
      {
        resourcePolicy: {
          maxClipsPerUserPerDay: this.quotas.maxClipsPerUserPerDay,
        },
        quotaRedis: this.redis,
        quotaPrefix: `${this.keyPrefix}quota:`,
      },
    );
    this.enqueueFn = deps.enqueueJob
      ? (payload, opts) => deps.enqueueJob!(payload, opts)
      : (payload, opts) =>
          enqueueMediaProcess(payload, {
            jobId: opts.jobId || buildGenerationBullJobId(payload.sharedWorkKey, payload.generation ?? 1),
          });
  }

  /**
   * Bounded crash reconciliation for stranded outbox PENDING_ENQUEUE rows and expired RUNNING leases.
   */
  async reconcileStrandedWork(batchSize = 20): Promise<ReconcileStrandedResult> {
    return this.sharedWork.reconcileStrandedWork({
      enqueueFn: this.enqueueFn,
      batchSize,
    });
  }

  /**
   * Resolves a universal media input (external URL, existing owned upload, or dev/test controlled fixture)
   * strictly on the backend and returns a truthful capability status without leaking raw storage keys.
   */
  async resolveUniversalSource(
    userId: string,
    input: UniversalMediaInput,
  ): Promise<ResolvedInternalSource> {
    if (!userId?.trim()) {
      throw new MediaSourceError({ code: 'ACCESS_DENIED', message: 'Authentication required.' });
    }

    // 1. Existing uploaded video asset belonging to the authenticated user
    if (input.inputType === 'upload') {
      const project = await this.db.project.findFirst({
        where: { id: input.projectId, userId },
        include: { sourceAsset: true },
      });
      if (!project || !project.sourceAsset) {
        return {
          response: {
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            provider: 'upload',
            sourceType: 'uploaded',
            identityScope: 'IMMUTABLE_UPLOAD',
            canSubmitJob: false,
            reason: 'Uploaded project or source video was not found for your account.',
            supportedActions: ['upload_video'],
          },
        };
      }

      const canonicalId = `upload:uploaded:${project.sourceAsset.id}` as CacheableSourceId;
      const ms = await this.registry.registerOrGetMediaSource({
        canonicalId,
        provider: 'upload',
        sourceType: 'uploaded',
        identityScope: 'IMMUTABLE_UPLOAD',
        externalId: project.sourceAsset.id,
        ownerUserId: userId,
        availability: 'AVAILABLE',
        metadata: {
          title: project.title,
          durationSec: project.sourceAsset.durationSec ?? undefined,
          width: project.sourceAsset.width ?? undefined,
          height: project.sourceAsset.height ?? undefined,
        },
      });

      return {
        response: {
          capabilityStatus: 'READY_TO_PROCESS',
          provider: 'upload',
          sourceType: 'uploaded',
          identityScope: 'IMMUTABLE_UPLOAD',
          mediaSourceId: ms.id,
          title: project.title,
          canSubmitJob: true,
          reason: 'Your uploaded video is ready for private analysis and clipping.',
          supportedActions: ['submit_job', 'create_project'],
        },
        mediaSourceId: ms.id,
        canonicalSourceId: canonicalId,
        rightsScope: 'PRIVATE_USER',
        uploadProjectId: project.id,
      };
    }

    // 2. Opt-in controlled test fixture (strictly disabled in production!)
    if (input.inputType === 'controlled_fixture') {
      if (!areControlledFixturesEnabled()) {
        throw new MediaSourceError({
          code: 'UNSUPPORTED_ACQUISITION',
          message: 'Controlled test media fixtures are disabled in production.',
          statusCode: 403,
        });
      }

      const fixture = getControlledTestFixture(input.fixtureKey);
      if (!fixture) {
        return {
          response: {
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            provider: 'direct_media',
            sourceType: 'vod',
            identityScope: 'IMMUTABLE_VOD',
            canSubmitJob: false,
            reason: `Controlled fixture "${input.fixtureKey}" is not registered.`,
            supportedActions: [],
          },
        };
      }

      const ms = await this.registry.getMediaSourceByCanonicalId(fixture.canonicalSourceId);
      if (!ms) {
        return {
          response: {
            capabilityStatus: 'SOURCE_UNAVAILABLE',
            provider: 'direct_media',
            sourceType: fixture.kind === 'live' ? 'live' : 'vod',
            identityScope: fixture.kind === 'live' ? 'IMMUTABLE_BROADCAST' : 'IMMUTABLE_VOD',
            canSubmitJob: false,
            reason: 'Controlled fixture source is not registered in the durable registry.',
            supportedActions: [],
          },
        };
      }

      const provider = fromPrismaProvider(ms.provider);
      const sourceType = fromPrismaSourceType(ms.sourceType);
      const scope: CacheRightsScope =
        ms.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';

      try {
        await this.registry.resolveServerTrustedAuth({
          requesterUserId: userId,
          canonicalSourceId: ms.canonicalId,
          requireAcquisition: true,
          requireSharedReuse: scope === 'SHARED_PERMITTED',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Rights unverified or revoked.';
        return {
          response: {
            capabilityStatus: 'REQUIRES_PERMISSION',
            provider,
            sourceType,
            identityScope: ms.identityScope,
            mediaSourceId: ms.id,
            title: ((ms.metadata as Record<string, unknown> | null)?.title as string | undefined) ?? undefined,
            canSubmitJob: false,
            reason: msg,
            supportedActions: [],
          },
          mediaSourceId: ms.id,
        };
      }

      return {
        response: {
          capabilityStatus: 'READY_TO_PROCESS',
          provider,
          sourceType,
          identityScope: ms.identityScope,
          mediaSourceId: ms.id,
          title: ((ms.metadata as Record<string, unknown> | null)?.title as string | undefined) ?? undefined,
          canSubmitJob: true,
          reason: `Authorized controlled ${fixture.kind} source is ready to process.`,
          supportedActions: ['submit_job', 'create_project'],
        },
        mediaSourceId: ms.id,
        canonicalSourceId: ms.canonicalId as CacheableSourceId,
        rightsScope: scope,
        controlledFixtureKey: fixture.fixtureKey,
      };
    }

    // 3. External URL submission (strict SSRF + DNS + redirect + official platform metadata resolver!)
    const platformRes = await this.platformResolver.resolveUrl(input.url, {
      hasServerVerifiedGrant: async (canonicalId) => {
        try {
          await this.registry.resolveServerTrustedAuth({
            requesterUserId: userId,
            canonicalSourceId: canonicalId,
            requireAcquisition: true,
            requireSharedReuse: true,
          });
          return true;
        } catch {
          return false;
        }
      },
    });
    const resolvedUrl = platformRes.source;

    // Check if an authoritative server MediaSource already exists for this canonical ID
    const existingMs =
      resolvedUrl.identityScope !== 'CHANNEL_DISCOVERY'
        ? await this.registry.getMediaSourceByCanonicalId(resolvedUrl.canonicalId)
        : null;

    if (existingMs) {
      if (existingMs.rightsStatus === 'DENIED' || existingMs.rightsStatus === 'RESTRICTED_DRM') {
        return {
          response: {
            capabilityStatus: 'REQUIRES_PERMISSION',
            provider: resolvedUrl.provider,
            sourceType: resolvedUrl.sourceType,
            identityScope: resolvedUrl.identityScope,
            availability: platformRes.availability,
            normalizedUrl: resolvedUrl.normalizedUrl,
            mediaSourceId: existingMs.id,
            broadcastId: platformRes.metadata.broadcastId ?? resolvedUrl.broadcastId,
            title: platformRes.metadata.title,
            channelName: platformRes.metadata.channelName,
            durationSec: platformRes.metadata.durationSec,
            thumbnailUrl: platformRes.metadata.thumbnailUrl,
            isLive: platformRes.metadata.isLive,
            isClip: platformRes.metadata.isClip,
            platformClipSupported: platformRes.metadata.platformClipSupported,
            canSubmitJob: false,
            reason: 'Acquisition or sharing permission for this source is denied or restricted.',
            supportedActions: [],
          },
          mediaSourceId: existingMs.id,
        };
      }
    }

    // 3b. Real non-fixture Authorized Direct Media URL (VOD MP4/MOV or Live/Recorded HLS .m3u8)
    if (
      resolvedUrl.provider === 'direct_media' &&
      platformRes.canSubmitJob &&
      platformRes.directMediaFinalUrl &&
      resolvedUrl.identityScope !== 'CHANNEL_DISCOVERY'
    ) {
      const canonicalId = resolvedUrl.canonicalId as CacheableSourceId;
      const ms = await this.registry.registerOrGetMediaSource({
        canonicalId,
        provider: 'direct_media',
        sourceType: resolvedUrl.sourceType,
        identityScope: resolvedUrl.identityScope,
        externalId: resolvedUrl.externalId,
        broadcastId: resolvedUrl.broadcastId,
        normalizedUrl: platformRes.directMediaFinalUrl,
        availability: platformRes.availability,
        metadata: {
          title: platformRes.metadata.title,
          durationSec: platformRes.metadata.durationSec,
          isLive: platformRes.metadata.isLive,
        },
      });

      // Ensure active server-authoritative grant exists when host is in server-configured
      // DIRECT_MEDIA_PERMITTED_PUBLIC_HOSTS, WITHOUT ever overriding a revoked or denied source!
      let authorized = false;
      try {
        await this.registry.resolveServerTrustedAuth({
          requesterUserId: userId,
          canonicalSourceId: canonicalId,
          requireAcquisition: true,
          requireSharedReuse: true,
        });
        authorized = true;
      } catch {
        const host = new URL(platformRes.directMediaFinalUrl).hostname.toLowerCase().replace(/\.$/, '');
        const hasRevoked = await this.db.mediaRightsGrant.count({
          where: { mediaSourceId: ms.id, revokedAt: { not: null } },
        });
        if (
          hasRevoked === 0 &&
          ms.rightsStatus !== 'DENIED' &&
          ms.rightsStatus !== 'RESTRICTED_DRM' &&
          this.platformResolver.config.directMediaPermittedPublicHosts?.has(host)
        ) {
          await this.registry.grantSourceRights({
            canonicalSourceId: canonicalId,
            grantScope: 'SHARED_REUSE',
            allowAcquisition: true,
            allowSharedReuse: true,
            rightsStatus: 'PERMITTED_PUBLIC',
            acquisitionCapability: 'PERMITTED_DIRECT_URL',
            provenance: 'ADMIN_VERIFIED_GRANT',
            grantedBy: 'system:direct-media-policy',
            reason: `Server-authorized direct media host (${host})`,
          });
          authorized = true;
        }
      }

      if (!authorized) {
        return {
          response: {
            capabilityStatus: 'REQUIRES_PERMISSION',
            provider: 'direct_media',
            sourceType: resolvedUrl.sourceType,
            identityScope: resolvedUrl.identityScope,
            availability: platformRes.availability,
            normalizedUrl: platformRes.directMediaFinalUrl,
            mediaSourceId: ms.id,
            title: platformRes.metadata.title,
            durationSec: platformRes.metadata.durationSec,
            isLive: platformRes.metadata.isLive,
            canSubmitJob: false,
            reason: 'Rights for this direct media source are unverified or have been revoked.',
            supportedActions: ['upload_video'],
          },
          mediaSourceId: ms.id,
        };
      }

      return {
        response: {
          capabilityStatus: 'READY_TO_PROCESS',
          provider: 'direct_media',
          sourceType: resolvedUrl.sourceType,
          identityScope: resolvedUrl.identityScope,
          availability: platformRes.availability,
          normalizedUrl: platformRes.directMediaFinalUrl,
          mediaSourceId: ms.id,
          broadcastId: platformRes.metadata.broadcastId ?? resolvedUrl.broadcastId,
          title: platformRes.metadata.title,
          durationSec: platformRes.metadata.durationSec,
          isLive: platformRes.metadata.isLive,
          canSubmitJob: true,
          reason: platformRes.reason,
          supportedActions: ['submit_job', 'create_project'],
        },
        mediaSourceId: ms.id,
        canonicalSourceId: canonicalId,
        rightsScope: 'SHARED_PERMITTED',
        directMediaUrl: platformRes.directMediaFinalUrl,
      };
    }

    // 3c. Truthful official metadata result for YouTube / Twitch / Kick (never fakes downloads!)
    return {
      response: {
        capabilityStatus: platformRes.capabilityStatus,
        provider: resolvedUrl.provider,
        sourceType: resolvedUrl.sourceType,
        identityScope: resolvedUrl.identityScope,
        availability: platformRes.availability,
        normalizedUrl: resolvedUrl.normalizedUrl,
        mediaSourceId: existingMs?.id,
        broadcastId: platformRes.metadata.broadcastId ?? resolvedUrl.broadcastId,
        title: platformRes.metadata.title,
        channelName: platformRes.metadata.channelName,
        durationSec: platformRes.metadata.durationSec,
        thumbnailUrl: platformRes.metadata.thumbnailUrl,
        isLive: platformRes.metadata.isLive,
        isClip: platformRes.metadata.isClip,
        platformClipSupported: platformRes.metadata.platformClipSupported,
        providerNotice: platformRes.providerNotice,
        canSubmitJob: false,
        reason: platformRes.reason,
        supportedActions: platformRes.supportedActions,
      },
      mediaSourceId: existingMs?.id,
    };
  }

  private async checkAndConsumeDailySubmissionQuota(userId: string, now = new Date()): Promise<void> {
    const dayKey = now.toISOString().slice(0, 10);
    const fullKey = `${this.keyPrefix}daily_sub:${userId}:${dayKey}`;
    const limit = this.quotas.maxDailyJobSubmissionsPerUser;

    try {
      const currentRaw = await this.redis.get(fullKey);
      const current = currentRaw ? Number(currentRaw) : 0;
      if (current >= limit) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          message: `Daily free-tier job submission limit reached (${limit}/day).`,
          statusCode: 429,
        });
      }
      await this.redis.eval(
        `local v = redis.call('INCR', KEYS[1]); if v == 1 then redis.call('EXPIRE', KEYS[1], 86400) end; return v`,
        1,
        fullKey,
      );
      return;
    } catch (err) {
      if (err instanceof MediaSourceError) throw err;
      const cur = this.localDailySubmissions.get(fullKey) ?? 0;
      if (cur >= limit) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          message: `Daily free-tier job submission limit reached (${limit}/day).`,
          statusCode: 429,
        });
      }
      this.localDailySubmissions.set(fullKey, cur + 1);
    }
  }

  private formatJobResponse(
    job: {
      id: string;
      status: string;
      sourceType: MediaSourceTypeEnum;
      idempotencyKey: string;
      mediaSourceId: string;
      projectId: string | null;
      stage: string;
      progressPercent: number;
      resultSummary: Prisma.JsonValue;
      errorCode: string | null;
      errorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
      mediaSource: { provider: MediaSourceProviderEnum };
    },
    deduplicatedSharedWork = false,
  ): MediaJobResponse {
    const summary = (job.resultSummary as Record<string, unknown> | null) ?? {};
    const highlightsCount =
      typeof summary.highlightsCount === 'number'
        ? summary.highlightsCount
        : Array.isArray(summary.highlights)
          ? summary.highlights.length
          : 0;
    return {
      jobId: job.id,
      status: job.status as MediaApiJobStatus,
      provider: fromPrismaProvider(job.mediaSource.provider),
      sourceType: fromPrismaSourceType(job.sourceType),
      capabilityStatus: 'READY_TO_PROCESS',
      idempotencyKey: job.idempotencyKey,
      mediaSourceId: job.mediaSourceId,
      projectId: job.projectId,
      stage: job.stage,
      progressPercent: job.progressPercent,
      highlightsCount,
      deduplicatedSharedWork: Boolean(summary.deduplicatedSharedWork ?? deduplicatedSharedWork),
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  /**
   * Submits an idempotent, authenticated media processing job backed by BullMQ.
   * Separates per-user MediaProcessingJob rows from sharedWorkKey deduplication so
   * 1,000 clippers attach to ONE shared BullMQ job and ONE FFmpeg pipeline!
   */
  async submitMediaJob(
    userId: string,
    req: SubmitMediaJobRequest,
  ): Promise<{ job: MediaJobResponse; httpStatus: 200 | 202; sharedWorkKey: string }> {
    // 1. Fast idempotency check BEFORE quota or resolution overhead
    const existingIdem = await this.db.mediaProcessingJob.findUnique({
      where: {
        userId_idempotencyKey: { userId, idempotencyKey: req.idempotencyKey },
      },
      include: { mediaSource: { select: { provider: true } } },
    });
    if (existingIdem) {
      return {
        job: this.formatJobResponse(existingIdem, true),
        httpStatus: 200,
        sharedWorkKey: existingIdem.sharedWorkKey,
      };
    }

    // 2. Resolve & verify authoritative rights BEFORE admitting job to queue!
    const resolved = await this.resolveUniversalSource(userId, req.input);
    if (!resolved.response.canSubmitJob || !resolved.mediaSourceId || !resolved.canonicalSourceId) {
      const cap = resolved.response.capabilityStatus;
      const statusCode =
        cap === 'REQUIRES_PERMISSION'
          ? 403
          : cap === 'BROADCAST_UNRESOLVED'
            ? 409
            : cap === 'SOURCE_UNAVAILABLE'
              ? 404
              : 422;
      throw new MediaSourceError({
        code:
          cap === 'REQUIRES_PERMISSION'
            ? 'ACCESS_DENIED'
            : cap === 'BROADCAST_UNRESOLVED'
              ? 'BROADCAST_UNRESOLVED'
              : cap === 'SOURCE_UNAVAILABLE'
                ? 'SOURCE_UNAVAILABLE'
                : 'UNSUPPORTED_ACQUISITION',
        message: resolved.response.reason,
        statusCode,
      });
    }

    // 3. Enforce per-user concurrent active-job cap & daily submission quota
    const activeCount = await this.db.mediaProcessingJob.count({
      where: { userId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (activeCount >= this.quotas.maxActiveJobsPerUser) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: `Maximum concurrent active jobs (${this.quotas.maxActiveJobsPerUser}) reached for your account.`,
        statusCode: 429,
      });
    }
    await this.checkAndConsumeDailySubmissionQuota(userId);

    const options: MediaJobProcessingOptions = req.options ?? {};
    const scope = resolved.rightsScope ?? 'SHARED_PERMITTED';
    const sharedWorkKey = `mwk_${stableHash(
      {
        canonicalSourceId: resolved.canonicalSourceId,
        sourceType: resolved.response.sourceType,
        scope,
        ownerScope: scope === 'PRIVATE_USER' ? userId : 'shared',
        options,
      },
      28,
    )}`;

    // 4. Atomically attach subscriber & reserve/reuse SharedMediaWork under ONE PostgreSQL row lock
    //    (eliminates late-subscriber races, fixed 300s Redis TTL expiry, and crash-before-enqueue gaps!)
    const attached = await this.sharedWork.attachSubscriberAndReserveWork({
      userId,
      mediaSourceId: resolved.mediaSourceId,
      canonicalSourceId: resolved.canonicalSourceId,
      projectId: resolved.uploadProjectId ?? null,
      idempotencyKey: req.idempotencyKey,
      sharedWorkKey,
      sourceType: toPrismaSourceType(resolved.response.sourceType),
      options,
      allowSharedReuse: scope === 'SHARED_PERMITTED',
      baseEnqueuePayload: {
        sharedWorkKey,
        mediaSourceId: resolved.mediaSourceId,
        canonicalSourceId: resolved.canonicalSourceId,
        sourceType: resolved.response.sourceType,
        initiatedByUserId: userId,
        controlledFixtureKey: resolved.controlledFixtureKey,
        uploadProjectId: resolved.uploadProjectId,
        directMediaUrl: resolved.directMediaUrl,
        options,
      },
    });

    // 5. Crash-safe outbox dispatch: if this call opened/restarted PENDING_ENQUEUE, dispatch to BullMQ
    //    using generation-scoped jobId. If enqueue fails or API crashes before enqueue, PostgreSQL
    //    retains PENDING_ENQUEUE + payload for bounded reconciliation recovery!
    if (attached.needsEnqueue && attached.enqueuePayload && !this.skipImmediateEnqueue) {
      await this.sharedWork.dispatchPendingEnqueue({
        sharedWorkKey,
        generation: attached.work.generation,
        payload: attached.enqueuePayload,
        enqueueFn: this.enqueueFn,
      });
    }

    return {
      job: this.formatJobResponse(attached.job, attached.deduplicatedSharedWork),
      httpStatus: attached.httpStatus,
      sharedWorkKey,
    };
  }

  /**
   * Returns job status strictly to the owning user (returns 404 to other users — no enumeration).
   * Performs idempotent read-side sync against durable SharedMediaWork if needed.
   */
  async getUserJobStatus(userId: string, jobId: string): Promise<MediaJobResponse> {
    const job = await this.db.mediaProcessingJob.findFirst({
      where: { id: jobId, userId },
      include: { mediaSource: { select: { provider: true } } },
    });
    if (!job) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: 'Media job not found.',
        statusCode: 404,
      });
    }
    const synced = await this.sharedWork.syncSubscriberFromWorkIfNeeded(job);
    return this.formatJobResponse(synced);
  }

  /**
   * Cancels ONLY the authenticated user's job, serialized under SharedMediaWork FOR UPDATE:
   * - Never regresses READY -> CANCELLED or FAILED -> CANCELLED.
   * - Leaves shared processing running while any other eligible subscriber remains.
   * - When the final subscriber detaches, cancels pending work or aborts strictly the
   *   current generation's worker so concurrent new subscribers on generation+1 are unaffected.
   */
  async cancelUserJob(
    userId: string,
    jobId: string,
  ): Promise<{
    jobId: string;
    status: 'CANCELLED' | 'READY' | 'FAILED';
    alreadyCompleted?: boolean;
    detachedFromSharedWork: boolean;
    sharedWorkStillActive: boolean;
  }> {
    const res = await this.sharedWork.detachSubscriberAndEvaluateCancel({
      userId,
      jobId,
    });

    if (res.generationToAbort !== undefined) {
      abortLocalSharedWorkGeneration(
        res.sharedWorkKey,
        res.generationToAbort,
        'All subscribers cancelled.',
      );
    }

    return {
      jobId: res.jobId,
      status: res.status,
      ...(res.alreadyCompleted !== undefined ? { alreadyCompleted: res.alreadyCompleted } : {}),
      detachedFromSharedWork: res.detachedFromSharedWork,
      sharedWorkStillActive: res.sharedWorkStillActive,
    };
  }

  /**
   * Loads verified highlights for an owned job, re-checking authoritative PostgreSQL rights
   * and revocation on every request and issuing short-lived (300s) signed download URLs
   * without exposing raw storage keys.
   */
  async getUserJobHighlights(userId: string, jobId: string): Promise<MediaJobHighlightsResponse> {
    const job = await this.db.mediaProcessingJob.findFirst({
      where: { id: jobId, userId },
      include: { mediaSource: true },
    });
    if (!job) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: 'Media job not found.',
        statusCode: 404,
      });
    }

    const scope: CacheRightsScope =
      job.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';

    // Live PostgreSQL rights & revocation re-check before issuing ANY download URLs!
    const resolvedAuth = await this.registry.resolveServerTrustedAuth({
      requesterUserId: userId,
      canonicalSourceId: job.mediaSource.canonicalId,
      requireSharedReuse: scope === 'SHARED_PERMITTED',
    });

    const highlights = await this.loadSanitizedHighlightsForSource({
      userId,
      canonicalSourceId: job.mediaSource.canonicalId as CacheableSourceId,
      mediaSourceId: job.mediaSource.id,
      rightsScope: scope,
      jobSummary: (job.resultSummary as Record<string, unknown> | null) ?? null,
      auth: resolvedAuth.auth,
    });

    return {
      jobId: job.id,
      status: job.status as MediaApiJobStatus,
      sourceType: fromPrismaSourceType(job.sourceType),
      streamActive: job.sourceType === 'LIVE' && job.status === 'RUNNING',
      highlights,
    };
  }

  private async loadSanitizedHighlightsForSource(params: {
    userId: string;
    canonicalSourceId: CacheableSourceId;
    mediaSourceId: string;
    rightsScope: CacheRightsScope;
    jobSummary: Record<string, unknown> | null;
    auth: Awaited<ReturnType<DurableMediaRegistryService['resolveServerTrustedAuth']>>['auth'];
  }): Promise<MediaHighlightItem[]> {
    const items: MediaHighlightItem[] = [];
    const seenCacheKeys = new Set<string>();

    // 1. Check live-published highlights attached to job summary (enables LIVE streaming highlights while RUNNING!)
    const summaryHighlights = Array.isArray(params.jobSummary?.highlights)
      ? (params.jobSummary!.highlights as Array<{
          candidate: HighlightWindowCandidate;
          cacheKey: string;
          objectKey: string;
          descriptor: CacheArtifactDescriptor;
          clipMeta: {
            durationSec: number;
            width: number;
            height: number;
            videoCodec: string;
            audioCodec: string | null;
            sizeBytes: number;
          };
          reusedFromCache?: boolean;
        }>)
      : [];

    for (const h of summaryHighlights) {
      if (!h?.cacheKey || !h?.objectKey || !h?.descriptor || seenCacheKeys.has(h.cacheKey)) continue;
      try {
        const head = await this.publisher.cache.checkObjectAtKey(params.auth, h.descriptor, h.objectKey);
        if (!head.hit || !head.sizeBytes) continue;
        const downloadUrl = await this.publisher.cache.createAuthorizedDownloadUrlForObject(
          params.auth,
          h.descriptor,
          h.objectKey,
          { expiresIn: this.quotas.downloadUrlTtlSec },
        );
        seenCacheKeys.add(h.cacheKey);
        items.push({
          highlightId: h.candidate.candidateId,
          cacheKey: h.cacheKey,
          eventTimestampSec: h.candidate.eventTimestampSec,
          windowStartSec: h.candidate.windowStartSec,
          windowEndSec: h.candidate.windowEndSec,
          compositeScore: h.candidate.compositeScore,
          contributingSignals: h.candidate.contributingSignals,
          durationSec: h.clipMeta.durationSec,
          width: h.clipMeta.width,
          height: h.clipMeta.height,
          videoCodec: h.clipMeta.videoCodec,
          audioCodec: h.clipMeta.audioCodec,
          sizeBytes: h.clipMeta.sizeBytes,
          downloadUrl,
          downloadUrlExpiresInSec: this.quotas.downloadUrlTtlSec,
          reusedFromCache: h.reusedFromCache,
        });
      } catch {
        // Skip invalid/corrupt entries rather than serving broken or unauthorized links
      }
    }

    // 2. Load authoritative PostgreSQL PUBLISHED BASE_CLIP artifacts for this source & scope
    const whereClause: Prisma.SharedCacheArtifactWhereInput =
      params.rightsScope === 'PRIVATE_USER'
        ? {
            mediaSourceId: params.mediaSourceId,
            artifactKind: 'BASE_CLIP',
            rightsScope: 'PRIVATE_USER',
            ownerUserId: params.userId,
            state: 'PUBLISHED',
          }
        : {
            mediaSourceId: params.mediaSourceId,
            artifactKind: 'BASE_CLIP',
            rightsScope: 'SHARED_PERMITTED',
            state: 'PUBLISHED',
          };

    const dbClips = await this.db.sharedCacheArtifact.findMany({
      where: whereClause,
      orderBy: { windowStartSec: 'asc' },
      take: 25,
    });

    for (const art of dbClips) {
      if (seenCacheKeys.has(art.cacheKey) || !art.publishedObjectKey || !art.sizeBytes) continue;
      if (art.expiresAt && art.expiresAt.getTime() <= Date.now()) continue;

      const meta = (art.mediaMetadata as {
        candidate?: HighlightWindowCandidate;
        clipMeta?: {
          durationSec?: number;
          width?: number;
          height?: number;
          videoCodec?: string;
          audioCodec?: string | null;
          sizeBytes?: number;
        };
      } | null) ?? {};

      const cand = meta.candidate;
      if (!cand) continue;

      const descriptor: CacheArtifactDescriptor = {
        artifactKind: 'BASE_CLIP',
        sourceRevision: art.sourceRevision,
        timeRangeSec:
          art.windowStartSec !== null && art.windowEndSec !== null
            ? { start: art.windowStartSec, end: art.windowEndSec }
            : undefined,
        algorithmVersion: art.algorithmVersion,
        renderSettings: DEFAULT_BASE_RENDER,
        rightsScope: params.rightsScope,
      };

      try {
        const verified = await this.publisher.cache.checkObjectAtKey(
          params.auth,
          descriptor,
          art.publishedObjectKey,
        );
        if (!verified.hit || verified.sizeBytes !== Number(art.sizeBytes)) continue;
        if (art.etag && verified.etag && art.etag !== verified.etag) continue;

        const downloadUrl = await this.publisher.cache.createAuthorizedDownloadUrlForObject(
          params.auth,
          descriptor,
          art.publishedObjectKey,
          { expiresIn: this.quotas.downloadUrlTtlSec },
        );
        seenCacheKeys.add(art.cacheKey);
        items.push({
          highlightId: cand.candidateId,
          cacheKey: art.cacheKey,
          eventTimestampSec: cand.eventTimestampSec,
          windowStartSec: cand.windowStartSec,
          windowEndSec: cand.windowEndSec,
          compositeScore: cand.compositeScore,
          contributingSignals: cand.contributingSignals,
          durationSec: meta.clipMeta?.durationSec,
          width: meta.clipMeta?.width,
          height: meta.clipMeta?.height,
          videoCodec: meta.clipMeta?.videoCodec,
          audioCodec: meta.clipMeta?.audioCodec ?? null,
          sizeBytes: Number(art.sizeBytes),
          downloadUrl,
          downloadUrlExpiresInSec: this.quotas.downloadUrlTtlSec,
          reusedFromCache: true,
        });
      } catch {
        // Non-matching render settings (e.g. variant clip) or invalid prefix skipped cleanly
      }
    }

    return items.sort((a, b) => a.eventTimestampSec - b.eventTimestampSec);
  }

  /**
   * Creates an independent private Project + EditTimeline + root EditVersion seeded
   * from an owned MediaProcessingJob's verified shared highlights.
   */
  async createPrivateProjectFromJob(
    userId: string,
    req: CreateProjectFromSourceRequest,
  ): Promise<CreateProjectFromSourceResponse> {
    const job = await this.db.mediaProcessingJob.findFirst({
      where: { id: req.jobId, userId },
      include: { mediaSource: true },
    });
    if (!job) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: 'Media job not found.',
        statusCode: 404,
      });
    }

    const hlResp = await this.getUserJobHighlights(userId, job.id);
    const candidates: HighlightWindowCandidate[] = hlResp.highlights.map((h) => ({
      candidateId: h.highlightId,
      canonicalSourceId: job.mediaSource.canonicalId as CacheableSourceId,
      eventTimestampSec: h.eventTimestampSec,
      windowStartSec: h.windowStartSec,
      windowEndSec: h.windowEndSec,
      compositeScore: h.compositeScore,
      contributingSignals: h.contributingSignals,
      pinnedSegmentIndices: [],
      algorithmVersion: 'v1.0-heuristic',
    }));

    const session = await this.vodService.createPrivateEditingSessionFromVod({
      requesterUserId: userId,
      canonicalSourceId: job.mediaSource.canonicalId as CacheableSourceId,
      title:
        req.title ??
        (((job.mediaSource.metadata as Record<string, unknown> | null)?.title as string | undefined) ||
          'Clip Project'),
      candidates,
    });

    await this.db.mediaProcessingJob.update({
      where: { id: job.id },
      data: { projectId: session.projectId },
    });

    return {
      projectId: session.projectId,
      mediaSourceId: session.mediaSourceId,
      timelineId: session.timelineId,
      rootVersionId: session.rootVersionId,
      highlightsCount: candidates.length,
    };
  }

  /**
   * Returns authorized highlights for a private Project owned by the authenticated user.
   * Returns 404 for another user's Project (never leaks existence).
   */
  async getPrivateProjectHighlights(
    userId: string,
    projectId: string,
  ): Promise<{ projectId: string; mediaSourceId: string; highlights: MediaHighlightItem[] }> {
    const project = await this.db.project.findFirst({
      where: { id: projectId, userId },
      include: {
        mediaSource: true,
        mediaJobs: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!project || !project.mediaSource) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: 'Project or linked media source not found.',
        statusCode: 404,
      });
    }

    const scope: CacheRightsScope =
      project.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';
    const resolvedAuth = await this.registry.resolveServerTrustedAuth({
      requesterUserId: userId,
      canonicalSourceId: project.mediaSource.canonicalId,
      requireSharedReuse: scope === 'SHARED_PERMITTED',
    });

    const highlights = await this.loadSanitizedHighlightsForSource({
      userId,
      canonicalSourceId: project.mediaSource.canonicalId as CacheableSourceId,
      mediaSourceId: project.mediaSource.id,
      rightsScope: scope,
      jobSummary: (project.mediaJobs[0]?.resultSummary as Record<string, unknown> | null) ?? null,
      auth: resolvedAuth.auth,
    });

    return {
      projectId: project.id,
      mediaSourceId: project.mediaSource.id,
      highlights,
    };
  }

  /**
   * Applies a private Auto/Prompt/Reference/Manual timeline edit on an owned Project,
   * creating ONE immutable EditVersion and—when `renderOutput: true`—enqueuing a durable
   * background PrivateRenderJob without blocking the HTTP request on FFmpeg.
   */
  async applyPrivateProjectEdit(
    userId: string,
    projectId: string,
    req: ApplyPrivateProjectEditRequest,
  ): Promise<{ response: ApplyPrivateProjectEditResponse; httpStatus: 200 | 201 | 202 }> {
    return this.privateRenders.applyPrivateEditAndMaybeEnqueueRender(userId, projectId, req);
  }

  async enqueuePrivateRenderForVersion(
    userId: string,
    projectId: string,
    req: CreatePrivateRenderRequest,
  ): Promise<{ renderJob: PrivateRenderJobResponse; httpStatus: 200 | 202 }> {
    return this.privateRenders.enqueueRenderForExistingVersion(userId, projectId, req);
  }

  async listPrivateProjectRenders(
    userId: string,
    projectId: string,
  ): Promise<{ projectId: string; renders: PrivateRenderJobResponse[] }> {
    return this.privateRenders.listProjectPrivateRenders(userId, projectId);
  }

  async getPrivateRenderStatus(
    userId: string,
    projectId: string,
    renderJobId: string,
  ): Promise<PrivateRenderJobResponse> {
    return this.privateRenders.getPrivateRenderStatus(userId, projectId, renderJobId);
  }

  async cancelPrivateRender(
    userId: string,
    projectId: string,
    renderJobId: string,
  ): Promise<CancelPrivateRenderResponse> {
    return this.privateRenders.cancelPrivateRender(userId, projectId, renderJobId);
  }
}
