import crypto from 'node:crypto';
import type {
  ApplyPrivateProjectEditRequest,
  ApplyPrivateProjectEditResponse,
  CacheRenderSettings,
  CacheRightsScope,
  CancelPrivateRenderResponse,
  CreatePrivateRenderRequest,
  MediaApiJobStatus,
  PrivateRenderJobResponse,
  PrivateRenderQueuePayload,
} from '@autoedit/contracts';
import type { Prisma, PrismaClient, PrivateRenderJob } from '@prisma/client';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { connection as defaultRedis } from '../../lib/redis.js';
import { getStorageProvider } from '../../storage/index.js';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import { enqueuePrivateRender } from '../../queue/queues.js';
import type { RedisLikeClient } from '../ingestion-coordinator.js';
import { DurableMediaRegistryService } from '../durable-media-registry.js';
import { MediaSourceError } from '../errors.js';

export interface PrivateRenderPolicyConfig {
  /** Max concurrent QUEUED/RUNNING private renders per user; defaults to 2. */
  maxActiveRendersPerUser: number;
  /** Max private renders submitted per user per day; defaults to 20. */
  maxDailyRendersPerUser: number;
  /** Global backpressure cap on QUEUED private renders; defaults to 50. */
  maxQueuedGlobalRenders: number;
  /** Free-beta maximum clip output duration in seconds; defaults to 180 (3 min). */
  maxOutputDurationSec: number;
  /** Signed download URL TTL in seconds; defaults to 300 (5 min). */
  downloadUrlTtlSec: number;
  /** Retention window for private render outputs in ms; defaults to 24h. */
  outputRetentionMs: number;
  /** Durable PostgreSQL lease duration for worker execution; defaults to 30_000 ms. */
  leaseMs: number;
  /** Maximum execution/recovery attempts; defaults to 3. */
  maxAttempts: number;
}

export const DEFAULT_PRIVATE_RENDER_POLICY: PrivateRenderPolicyConfig = {
  maxActiveRendersPerUser: 2,
  maxDailyRendersPerUser: 20,
  maxQueuedGlobalRenders: 50,
  maxOutputDurationSec: 180,
  downloadUrlTtlSec: 300,
  outputRetentionMs: 24 * 60 * 60 * 1000,
  leaseMs: 30_000,
  maxAttempts: 3,
};

export interface PrivateRenderServiceDeps {
  db?: PrismaClient;
  storage?: MediaStorageProvider;
  redis?: RedisLikeClient;
  keyPrefix?: string;
  policy?: Partial<PrivateRenderPolicyConfig>;
  now?: () => Date;
  /** Optional test hook: skip immediate BullMQ dispatch so stranded-outbox reconciliation can be tested. */
  skipImmediateEnqueue?: boolean;
  enqueueJob?: (
    payload: PrivateRenderQueuePayload,
    opts?: { jobId?: string },
  ) => Promise<{ id?: string }>;
}

/**
 * In-process AbortControllers for active private renders keyed by `(renderJobId, generation)`
 * so cancelling generation N immediately SIGKILLs FFmpeg without affecting generation N+1.
 */
const localPrivateRenderAborts = new Map<string, AbortController>();

function renderAbortKey(renderJobId: string, generation: number): string {
  return `${renderJobId}::g${generation}`;
}

export function registerLocalPrivateRenderAbort(
  renderJobId: string,
  generation: number,
  ctrl: AbortController,
): void {
  localPrivateRenderAborts.set(renderAbortKey(renderJobId, generation), ctrl);
}

export function unregisterLocalPrivateRenderAbort(
  renderJobId: string,
  generation: number,
): void {
  localPrivateRenderAborts.delete(renderAbortKey(renderJobId, generation));
}

export function abortLocalPrivateRender(
  renderJobId: string,
  generation: number,
  reason = 'Private render cancelled by owner.',
): boolean {
  const ctrl = localPrivateRenderAborts.get(renderAbortKey(renderJobId, generation));
  if (ctrl && !ctrl.signal.aborted) {
    ctrl.abort(new MediaSourceError({ code: 'REQUEST_CANCELLED', message: reason }));
    return true;
  }
  return false;
}

export function buildPrivateRenderBullJobId(renderJobId: string, generation: number): string {
  const safeId = renderJobId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `priv_${safeId}__g${generation}`;
}

function stableShortHash(value: unknown, len = 24): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, len);
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002',
  );
}

function resolveFreeBetaRenderSettings(
  format: 'reel' | 'short' | 'landscape' | undefined,
  effects: {
    subtitles: boolean;
    zooms: boolean;
    transitions: 'fade' | 'none';
    music: boolean;
  },
  customEditHash: string,
): CacheRenderSettings {
  const resolvedFormat = format ?? 'reel';
  // CPU-first free-beta bounded resolution ceiling (1280x720 landscape / 720x1280 vertical -> kept <= 1280)
  const width = resolvedFormat === 'landscape' ? 1280 : 1280;
  const height = resolvedFormat === 'landscape' ? 720 : 720;
  return {
    format: resolvedFormat,
    width,
    height,
    fps: 30,
    subtitles: effects.subtitles,
    zooms: effects.zooms,
    transitions: effects.transitions,
    music: effects.music,
    customEditHash,
  };
}

export type ClaimPrivateRenderResult =
  | {
      action: 'CLAIMED';
      job: PrivateRenderJob;
      generation: number;
      ownerToken: string;
    }
  | { action: 'SKIP_TERMINAL'; status: MediaApiJobStatus }
  | { action: 'SKIP_STALE_GENERATION'; currentGeneration: number }
  | { action: 'SKIP_ALREADY_RUNNING'; ownerWorkerId: string | null }
  | { action: 'SKIP_NOT_FOUND' };

export interface ReconcilePrivateRendersResult {
  dispatchedQueued: number;
  recoveredExpiredLeases: number;
  failedMaxAttempts: number;
}

const TX_OPTS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * Durable Background Private Rendering Coordinator (Step 3C.1.1).
 *
 * Separates fast, non-destructive EditVersion creation from asynchronous CPU-bounded
 * FFmpeg rendering. Enforces owner-scoped authorization, idempotency, free-beta quotas,
 * backpressure, lease-fenced execution, real storage verification, and short-lived
 * dynamically minted download URLs without exposing raw storage keys.
 */
export class PrivateRenderService {
  readonly db: PrismaClient;
  readonly storage: MediaStorageProvider;
  readonly redis: RedisLikeClient;
  readonly registry: DurableMediaRegistryService;
  readonly policy: PrivateRenderPolicyConfig;
  readonly keyPrefix: string;
  private readonly nowFn: () => Date;
  private readonly skipImmediateEnqueue: boolean;
  private readonly enqueueFn: (
    payload: PrivateRenderQueuePayload,
    opts: { jobId: string },
  ) => Promise<{ id?: string }>;
  private readonly localDailyQuota = new Map<string, number>();

  constructor(deps: PrivateRenderServiceDeps = {}) {
    this.db = deps.db ?? defaultPrisma;
    this.storage = deps.storage ?? getStorageProvider();
    this.redis = deps.redis ?? (defaultRedis as unknown as RedisLikeClient);
    this.registry = new DurableMediaRegistryService(this.db);
    this.policy = { ...DEFAULT_PRIVATE_RENDER_POLICY, ...(deps.policy ?? {}) };
    this.keyPrefix = deps.keyPrefix ?? 'autoedit:priv_render:';
    this.nowFn = deps.now ?? (() => new Date());
    this.skipImmediateEnqueue = Boolean(deps.skipImmediateEnqueue);
    this.enqueueFn = deps.enqueueJob
      ? (payload, opts) => deps.enqueueJob!(payload, opts)
      : (payload, opts) => enqueuePrivateRender(payload, { jobId: opts.jobId });
  }

  private formatJob(
    row: PrivateRenderJob,
    extras?: {
      downloadUrl?: string;
      downloadUrlExpiresInSec?: number;
      overrideErrorCode?: string | null;
      overrideErrorMessage?: string | null;
    },
  ): PrivateRenderJobResponse {
    return {
      renderJobId: row.id,
      projectId: row.projectId,
      editVersionId: row.editVersionId,
      idempotencyKey: row.idempotencyKey,
      customEditHash: row.customEditHash,
      mode: row.mode as 'auto' | 'prompt' | 'reference' | 'manual',
      windowStartSec: row.windowStartSec,
      windowEndSec: row.windowEndSec,
      status: row.status as MediaApiJobStatus,
      stage: row.stage,
      progressPercent: row.progressPercent,
      durationSec: row.outputDurationSec ?? null,
      width: row.outputWidth ?? null,
      height: row.outputHeight ?? null,
      sizeBytes: row.outputSizeBytes !== null ? Number(row.outputSizeBytes) : null,
      ...(extras?.downloadUrl ? { downloadUrl: extras.downloadUrl } : {}),
      ...(extras?.downloadUrlExpiresInSec
        ? { downloadUrlExpiresInSec: extras.downloadUrlExpiresInSec }
        : {}),
      errorCode:
        extras?.overrideErrorCode !== undefined ? extras.overrideErrorCode : row.errorCode,
      errorMessage:
        extras?.overrideErrorMessage !== undefined
          ? extras.overrideErrorMessage
          : row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }

  private async checkAndConsumeDailyRenderQuota(userId: string): Promise<void> {
    const now = this.nowFn();
    const dayKey = now.toISOString().slice(0, 10);
    const fullKey = `${this.keyPrefix}daily:${userId}:${dayKey}`;
    const limit = this.policy.maxDailyRendersPerUser;

    try {
      const currentRaw = await this.redis.get(fullKey);
      const current = currentRaw ? Number(currentRaw) : 0;
      if (current >= limit) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          statusCode: 429,
          message: `Daily free-beta private render limit reached (${limit}/day).`,
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
      const cur = this.localDailyQuota.get(fullKey) ?? 0;
      if (cur >= limit) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          statusCode: 429,
          message: `Daily free-beta private render limit reached (${limit}/day).`,
        });
      }
      this.localDailyQuota.set(fullKey, cur + 1);
    }
  }

  private async enforceRenderAdmissionControls(params: {
    userId: string;
    windowStartSec: number;
    windowEndSec: number;
    mediaSource: { canonicalId: string; provider: string } | null;
    sourceAsset: { id: string } | null;
  }): Promise<void> {
    const clipDuration = params.windowEndSec - params.windowStartSec;
    if (!Number.isFinite(clipDuration) || clipDuration <= 0) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        statusCode: 400,
        message: 'End time must be greater than start time.',
      });
    }
    if (clipDuration > this.policy.maxOutputDurationSec) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        statusCode: 400,
        message: `Free beta clips are limited to ${this.policy.maxOutputDurationSec} seconds per render.`,
      });
    }

    if (!params.mediaSource && !params.sourceAsset) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'No renderable source media is attached to this project.',
      });
    }

    // Verify live server-authoritative PostgreSQL rights BEFORE admitting to queue
    if (params.mediaSource) {
      const scope: CacheRightsScope =
        params.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';
      await this.registry.resolveServerTrustedAuth({
        requesterUserId: params.userId,
        canonicalSourceId: params.mediaSource.canonicalId,
        requireSharedReuse: scope === 'SHARED_PERMITTED',
        now: this.nowFn(),
      });
    }

    // Per-user active render cap (queue fairness)
    const activeForUser = await this.db.privateRenderJob.count({
      where: { userId: params.userId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (activeForUser >= this.policy.maxActiveRendersPerUser) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        statusCode: 429,
        message: `You already have ${this.policy.maxActiveRendersPerUser} active private renders in progress. Wait for one to finish or cancel it before starting another.`,
      });
    }

    // Global backpressure check
    const queuedGlobal = await this.db.privateRenderJob.count({
      where: { status: 'QUEUED' },
    });
    if (queuedGlobal >= this.policy.maxQueuedGlobalRenders) {
      throw new MediaSourceError({
        code: 'MAX_RETRIES_EXCEEDED',
        statusCode: 503,
        retryable: true,
        message: 'Private render queue is temporarily busy. Please retry in a few moments.',
      });
    }

    // Per-user daily private render quota
    await this.checkAndConsumeDailyRenderQuota(params.userId);
  }

  private async dispatchRenderJobToQueue(row: PrivateRenderJob): Promise<void> {
    if (this.skipImmediateEnqueue) return;
    const jobId = buildPrivateRenderBullJobId(row.id, row.generation);
    try {
      const enq = await this.enqueueFn(
        {
          renderJobId: row.id,
          projectId: row.projectId,
          userId: row.userId,
          generation: row.generation,
        },
        { jobId },
      );
      await this.db.privateRenderJob.updateMany({
        where: { id: row.id, generation: row.generation, status: 'QUEUED' },
        data: { bullJobId: enq?.id ? String(enq.id) : jobId, updatedAt: this.nowFn() },
      });
    } catch {
      // Leave bullJobId null in QUEUED state so bounded reconciler retries dispatch safely!
    }
  }

  /**
   * Applies an owner-authorized private timeline edit (creating ONE immutable EditVersion)
   * and, when `renderOutput: true`, enqueues a durable background PrivateRenderJob without
   * blocking the HTTP connection for FFmpeg.
   */
  async applyPrivateEditAndMaybeEnqueueRender(
    userId: string,
    projectId: string,
    req: ApplyPrivateProjectEditRequest,
  ): Promise<{ response: ApplyPrivateProjectEditResponse; httpStatus: 200 | 201 | 202 }> {
    const project = await this.db.project.findFirst({
      where: { id: projectId, userId },
      include: {
        mediaSource: true,
        sourceAsset: { select: { id: true } },
        timeline: true,
        versions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!project) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Project not found.',
      });
    }

    const wantsRender = Boolean(req.renderOutput);
    const idempotencyKey =
      req.idempotencyKey ??
      `edit_${project.id}_${crypto.randomBytes(8).toString('hex')}`;

    // 1. Fast idempotency hit BEFORE creating another EditVersion or consuming quota!
    if (wantsRender && req.idempotencyKey) {
      const existing = await this.db.privateRenderJob.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: req.idempotencyKey } },
        include: { editVersion: { select: { id: true, parentVersionId: true } } },
      });
      if (existing) {
        if (existing.projectId !== project.id) {
          throw new MediaSourceError({
            code: 'ACCESS_DENIED',
            statusCode: 409,
            message: 'Idempotency key already used for a different project.',
          });
        }
        return {
          httpStatus: 200,
          response: {
            projectId: project.id,
            versionId: existing.editVersionId,
            parentVersionId: existing.editVersion.parentVersionId ?? null,
            customEditHash: existing.customEditHash,
            renderJob: this.formatJob(existing),
          },
        };
      }
    }

    // 2. Enforce admission controls & live rights before creating render job
    if (wantsRender) {
      await this.enforceRenderAdmissionControls({
        userId,
        windowStartSec: req.windowStartSec,
        windowEndSec: req.windowEndSec,
        mediaSource: project.mediaSource
          ? { canonicalId: project.mediaSource.canonicalId, provider: project.mediaSource.provider }
          : null,
        sourceAsset: project.sourceAsset,
      });
    }

    const parentVersionId = project.versions[0]?.id ?? null;
    const effects = {
      subtitles: req.effects?.subtitles ?? false,
      zooms: req.effects?.zooms ?? false,
      transitions: req.effects?.transitions ?? ('none' as const),
      music: req.effects?.music ?? false,
    };
    const ops = [
      {
        id: `op_${req.mode}_${Date.now()}`,
        type: 'cut',
        start: req.windowStartSec,
        end: req.windowEndSec,
        mode: req.mode,
      },
    ];
    const customEditHash = stableShortHash(
      {
        projectId: project.id,
        userId,
        mode: req.mode,
        prompt: req.userPrompt ?? '',
        start: req.windowStartSec,
        end: req.windowEndSec,
        effects,
        format: req.format ?? 'reel',
      },
      24,
    );
    const renderSettings = resolveFreeBetaRenderSettings(req.format, effects, customEditHash);

    // 3. Atomically persist immutable EditVersion (+ PrivateRenderJob if rendering) in ONE PostgreSQL tx
    try {
      const created = await this.db.$transaction(async (tx) => {
        if (project.timeline) {
          await tx.editTimeline.update({
            where: { projectId: project.id },
            data: {
              operations: ops as Prisma.InputJsonValue,
              effects: effects as Prisma.InputJsonValue,
            },
          });
        } else {
          await tx.editTimeline.create({
            data: {
              projectId: project.id,
              operations: ops as Prisma.InputJsonValue,
              effects: effects as Prisma.InputJsonValue,
              outputs: [{ format: req.format ?? 'reel', aspect: '9:16', maxDurationSec: 60 }],
              approved: false,
            },
          });
        }

        const version = await tx.editVersion.create({
          data: {
            projectId: project.id,
            parentVersionId,
            name: req.versionName,
            userPrompt: req.userPrompt ?? null,
            aiExplanation: `Applied ${req.mode} mode private edit (${req.windowStartSec}s–${req.windowEndSec}s).`,
            changes: [
              {
                action: req.mode,
                target: `${req.windowStartSec}s–${req.windowEndSec}s`,
                reasons: [
                  req.userPrompt
                    ? `${req.mode.toUpperCase()} edit: ${req.userPrompt.slice(0, 120)}`
                    : `Private ${req.mode} trim (${req.windowStartSec}s–${req.windowEndSec}s)`,
                ],
              },
            ] as Prisma.InputJsonValue,
            timelineJson: {
              mode: req.mode,
              operations: ops,
              effects,
              customEditHash,
            } as Prisma.InputJsonValue,
          },
        });

        let renderRow: PrivateRenderJob | null = null;
        if (wantsRender) {
          renderRow = await tx.privateRenderJob.create({
            data: {
              userId,
              projectId: project.id,
              editVersionId: version.id,
              mediaSourceId: project.mediaSourceId,
              idempotencyKey,
              customEditHash,
              mode: req.mode,
              windowStartSec: req.windowStartSec,
              windowEndSec: req.windowEndSec,
              effects: effects as Prisma.InputJsonValue,
              renderSettings: renderSettings as unknown as Prisma.InputJsonValue,
              status: 'QUEUED',
              stage: 'queued',
              progressPercent: 0,
              generation: 1,
              maxAttempts: this.policy.maxAttempts,
            },
          });
        }

        return { version, renderRow };
      }, TX_OPTS);

      if (created.renderRow) {
        await this.dispatchRenderJobToQueue(created.renderRow);
        return {
          httpStatus: 202,
          response: {
            projectId: project.id,
            versionId: created.version.id,
            parentVersionId,
            customEditHash,
            renderJob: this.formatJob(created.renderRow),
          },
        };
      }

      return {
        httpStatus: 201,
        response: {
          projectId: project.id,
          versionId: created.version.id,
          parentVersionId,
          customEditHash,
        },
      };
    } catch (err) {
      // Concurrent double-submit with identical (userId, idempotencyKey) -> return winner idempotently!
      if (wantsRender && isUniqueConstraintError(err)) {
        const winner = await this.db.privateRenderJob.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
          include: { editVersion: { select: { id: true, parentVersionId: true } } },
        });
        if (winner && winner.projectId === project.id) {
          return {
            httpStatus: 200,
            response: {
              projectId: project.id,
              versionId: winner.editVersionId,
              parentVersionId: winner.editVersion.parentVersionId ?? null,
              customEditHash: winner.customEditHash,
              renderJob: this.formatJob(winner),
            },
          };
        }
      }
      throw err;
    }
  }

  /**
   * Enqueues a background private render for an existing owned EditVersion without duplicating versions.
   */
  async enqueueRenderForExistingVersion(
    userId: string,
    projectId: string,
    req: CreatePrivateRenderRequest,
  ): Promise<{ renderJob: PrivateRenderJobResponse; httpStatus: 200 | 202 }> {
    const existing = await this.db.privateRenderJob.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: req.idempotencyKey } },
    });
    if (existing) {
      if (existing.projectId !== projectId) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          statusCode: 409,
          message: 'Idempotency key already used for a different project.',
        });
      }
      return { httpStatus: 200, renderJob: this.formatJob(existing) };
    }

    const project = await this.db.project.findFirst({
      where: { id: projectId, userId },
      include: {
        mediaSource: true,
        sourceAsset: { select: { id: true } },
      },
    });
    if (!project) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Project not found.',
      });
    }

    const version = await this.db.editVersion.findFirst({
      where: { id: req.editVersionId, projectId: project.id },
    });
    if (!version) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Edit version not found for this project.',
      });
    }

    const snap = (version.timelineJson as {
      mode?: string;
      operations?: Array<{ start?: number; end?: number }>;
      effects?: { subtitles?: boolean; zooms?: boolean; transitions?: 'fade' | 'none'; music?: boolean };
      customEditHash?: string;
    } | null) ?? {};

    const firstOp = Array.isArray(snap.operations) ? snap.operations[0] : undefined;
    const windowStartSec = typeof firstOp?.start === 'number' ? firstOp.start : 0;
    const windowEndSec = typeof firstOp?.end === 'number' ? firstOp.end : 10;
    const mode =
      snap.mode === 'auto' || snap.mode === 'prompt' || snap.mode === 'reference' || snap.mode === 'manual'
        ? snap.mode
        : 'manual';
    const effects = {
      subtitles: Boolean(snap.effects?.subtitles),
      zooms: Boolean(snap.effects?.zooms),
      transitions: snap.effects?.transitions === 'fade' ? ('fade' as const) : ('none' as const),
      music: Boolean(snap.effects?.music),
    };
    const customEditHash =
      typeof snap.customEditHash === 'string' && snap.customEditHash.length > 0
        ? snap.customEditHash
        : stableShortHash({ projectId: project.id, versionId: version.id, windowStartSec, windowEndSec, effects }, 24);
    const renderSettings = resolveFreeBetaRenderSettings(req.format, effects, customEditHash);

    await this.enforceRenderAdmissionControls({
      userId,
      windowStartSec,
      windowEndSec,
      mediaSource: project.mediaSource
        ? { canonicalId: project.mediaSource.canonicalId, provider: project.mediaSource.provider }
        : null,
      sourceAsset: project.sourceAsset,
    });

    try {
      const row = await this.db.privateRenderJob.create({
        data: {
          userId,
          projectId: project.id,
          editVersionId: version.id,
          mediaSourceId: project.mediaSourceId,
          idempotencyKey: req.idempotencyKey,
          customEditHash,
          mode,
          windowStartSec,
          windowEndSec,
          effects: effects as Prisma.InputJsonValue,
          renderSettings: renderSettings as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
          stage: 'queued',
          progressPercent: 0,
          generation: 1,
          maxAttempts: this.policy.maxAttempts,
        },
      });
      await this.dispatchRenderJobToQueue(row);
      return { httpStatus: 202, renderJob: this.formatJob(row) };
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const winner = await this.db.privateRenderJob.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: req.idempotencyKey } },
        });
        if (winner && winner.projectId === project.id) {
          return { httpStatus: 200, renderJob: this.formatJob(winner) };
        }
      }
      throw err;
    }
  }

  /**
   * Lists owner's recent private render jobs for a project (no raw storage keys or stored signed URLs).
   */
  async listProjectPrivateRenders(
    userId: string,
    projectId: string,
  ): Promise<{ projectId: string; renders: PrivateRenderJobResponse[] }> {
    const project = await this.db.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });
    if (!project) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Project not found.',
      });
    }

    const rows = await this.db.privateRenderJob.findMany({
      where: { projectId: project.id, userId },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    return {
      projectId: project.id,
      renders: rows.map((r) => this.formatJob(r)),
    };
  }

  /**
   * Polls an owned private render job. When `READY`, re-verifies live PostgreSQL rights,
   * retention expiration, and MinIO object integrity before minting a fresh 300s signed URL.
   * Returns 404 for non-owners.
   */
  async getPrivateRenderStatus(
    userId: string,
    projectId: string,
    renderJobId: string,
  ): Promise<PrivateRenderJobResponse> {
    const row = await this.db.privateRenderJob.findFirst({
      where: { id: renderJobId, projectId, userId },
      include: {
        project: { include: { mediaSource: true } },
      },
    });
    if (!row) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Private render job not found.',
      });
    }

    if (row.status !== 'READY') {
      return this.formatJob(row);
    }

    const now = this.nowFn();

    // 1. Re-verify live server-authoritative PostgreSQL rights before issuing ANY download URL!
    if (row.project.mediaSource) {
      const scope: CacheRightsScope =
        row.project.mediaSource.provider === 'UPLOAD' ? 'PRIVATE_USER' : 'SHARED_PERMITTED';
      await this.registry.resolveServerTrustedAuth({
        requesterUserId: userId,
        canonicalSourceId: row.project.mediaSource.canonicalId,
        requireSharedReuse: scope === 'SHARED_PERMITTED',
        now,
      });
    }

    // 2. Check object presence metadata & expiration
    if (!row.outputObjectKey || !row.outputSha256 || !row.outputSizeBytes || row.outputSizeBytes <= 0n) {
      return this.formatJob(row, {
        overrideErrorCode: 'ARTIFACT_CORRUPT',
        overrideErrorMessage: 'Rendered output metadata is incomplete. Please retry rendering.',
      });
    }

    if (row.outputExpiresAt && row.outputExpiresAt.getTime() <= now.getTime()) {
      return this.formatJob(row, {
        overrideErrorCode: 'OUTPUT_EXPIRED',
        overrideErrorMessage: 'Rendered MP4 has expired past retention window. Start a new render to regenerate it.',
      });
    }

    // 3. Enforce strict owner-scoped storage key prefix (defense-in-depth)
    const expectedOwnerPrefix = `private/users/${userId}/`;
    if (!row.outputObjectKey.startsWith(expectedOwnerPrefix)) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        statusCode: 403,
        message: 'Private render output failed owner isolation check.',
      });
    }

    // 4. Verify live object existence, exact size, and ETag in MinIO before signing!
    try {
      const meta = await this.storage.getObjectMetadata({ key: row.outputObjectKey });
      const actualSize = meta.contentLength ?? 0;
      if (actualSize !== Number(row.outputSizeBytes) || actualSize <= 0) {
        return this.formatJob(row, {
          overrideErrorCode: 'ARTIFACT_CORRUPT',
          overrideErrorMessage: 'Rendered output failed storage size verification. Please retry rendering.',
        });
      }
      if (row.outputEtag && meta.etag && row.outputEtag !== meta.etag) {
        return this.formatJob(row, {
          overrideErrorCode: 'ARTIFACT_CORRUPT',
          overrideErrorMessage: 'Rendered output failed integrity verification. Please retry rendering.',
        });
      }
    } catch {
      return this.formatJob(row, {
        overrideErrorCode: 'SOURCE_UNAVAILABLE',
        overrideErrorMessage: 'Rendered output is no longer available in storage. Please retry rendering.',
      });
    }

    const ttl = this.policy.downloadUrlTtlSec;
    const downloadUrl = await this.storage.createDownloadUrl({
      key: row.outputObjectKey,
      expiresIn: ttl,
    });

    return this.formatJob(row, {
      downloadUrl,
      downloadUrlExpiresInSec: ttl,
    });
  }

  /**
   * Cancels an owned QUEUED/RUNNING private render job atomically without regressing READY/FAILED.
   * Immediately signals any local in-flight FFmpeg worker to SIGKILL.
   */
  async cancelPrivateRender(
    userId: string,
    projectId: string,
    renderJobId: string,
  ): Promise<CancelPrivateRenderResponse> {
    const now = this.nowFn();
    const outcome = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "PrivateRenderJob"
        WHERE "id" = ${renderJobId} AND "projectId" = ${projectId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      const row = await tx.privateRenderJob.findFirst({
        where: { id: renderJobId, projectId, userId },
      });
      if (!row) return null;

      if (row.status === 'READY' || row.status === 'FAILED') {
        return {
          renderJobId: row.id,
          status: row.status as 'READY' | 'FAILED',
          alreadyCompleted: true,
          generationToAbort: undefined as number | undefined,
        };
      }
      if (row.status === 'CANCELLED') {
        return {
          renderJobId: row.id,
          status: 'CANCELLED' as const,
          alreadyCompleted: false,
          generationToAbort: undefined as number | undefined,
        };
      }

      await tx.privateRenderJob.update({
        where: { id: row.id },
        data: {
          status: 'CANCELLED',
          stage: 'cancelled',
          ownerToken: null,
          ownerWorkerId: null,
          leaseExpiresAt: null,
          cancelledAt: now,
          updatedAt: now,
        },
      });

      return {
        renderJobId: row.id,
        status: 'CANCELLED' as const,
        alreadyCompleted: false,
        generationToAbort: row.generation,
      };
    }, TX_OPTS);

    if (!outcome) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        statusCode: 404,
        message: 'Private render job not found.',
      });
    }

    if (outcome.generationToAbort !== undefined) {
      abortLocalPrivateRender(outcome.renderJobId, outcome.generationToAbort);
    }

    return {
      renderJobId: outcome.renderJobId,
      status: outcome.status,
      ...(outcome.alreadyCompleted ? { alreadyCompleted: true } : {}),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Durable Worker Coordination & Lease Fencing (PostgreSQL FOR UPDATE)
  // ─────────────────────────────────────────────────────────────────────────────

  async claimRenderExecution(params: {
    renderJobId: string;
    payloadGeneration: number;
    workerId: string;
    bullJobId?: string;
    leaseMs?: number;
  }): Promise<ClaimPrivateRenderResult> {
    const now = this.nowFn();
    const leaseMs = params.leaseMs ?? this.policy.leaseMs;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const ownerToken = `prtok_${crypto.randomBytes(12).toString('hex')}`;

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "PrivateRenderJob" WHERE "id" = ${params.renderJobId} FOR UPDATE
      `;
      const row = await tx.privateRenderJob.findUnique({ where: { id: params.renderJobId } });
      if (!row) return { action: 'SKIP_NOT_FOUND' as const };

      if (row.status === 'READY' || row.status === 'FAILED' || row.status === 'CANCELLED') {
        return { action: 'SKIP_TERMINAL' as const, status: row.status as MediaApiJobStatus };
      }

      if (row.generation !== params.payloadGeneration) {
        return { action: 'SKIP_STALE_GENERATION' as const, currentGeneration: row.generation };
      }

      if (
        row.status === 'RUNNING' &&
        row.leaseExpiresAt &&
        row.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return { action: 'SKIP_ALREADY_RUNNING' as const, ownerWorkerId: row.ownerWorkerId };
      }

      const updated = await tx.privateRenderJob.update({
        where: { id: row.id },
        data: {
          status: 'RUNNING',
          stage: 'preparing_source',
          progressPercent: 10,
          ownerWorkerId: params.workerId,
          ownerToken,
          leaseExpiresAt,
          bullJobId: params.bullJobId ?? row.bullJobId,
          attempts: row.attempts + 1,
          startedAt: row.startedAt ?? now,
          updatedAt: now,
        },
      });

      return {
        action: 'CLAIMED' as const,
        job: updated,
        generation: updated.generation,
        ownerToken,
      };
    }, TX_OPTS);
  }

  async renewRenderLease(params: {
    renderJobId: string;
    generation: number;
    ownerToken: string;
    leaseMs?: number;
  }): Promise<{ renewed: boolean }> {
    const now = this.nowFn();
    const leaseExpiresAt = new Date(now.getTime() + (params.leaseMs ?? this.policy.leaseMs));
    const res = await this.db.privateRenderJob.updateMany({
      where: {
        id: params.renderJobId,
        generation: params.generation,
        ownerToken: params.ownerToken,
        status: 'RUNNING',
      },
      data: { leaseExpiresAt, updatedAt: now },
    });
    return { renewed: res.count === 1 };
  }

  async publishRenderProgressFenced(params: {
    renderJobId: string;
    generation: number;
    ownerToken: string;
    stage: string;
    progressPercent: number;
  }): Promise<boolean> {
    const res = await this.db.privateRenderJob.updateMany({
      where: {
        id: params.renderJobId,
        generation: params.generation,
        ownerToken: params.ownerToken,
        status: 'RUNNING',
      },
      data: {
        stage: params.stage,
        progressPercent: Math.max(0, Math.min(99, Math.round(params.progressPercent))),
        updatedAt: this.nowFn(),
      },
    });
    return res.count === 1;
  }

  async commitRenderReadyFenced(params: {
    renderJobId: string;
    generation: number;
    ownerToken: string;
    artifactCacheKey?: string | null;
    outputObjectKey: string;
    outputSha256: string;
    outputEtag?: string | null;
    outputSizeBytes: number;
    outputDurationSec: number;
    outputWidth: number;
    outputHeight: number;
  }): Promise<boolean> {
    const now = this.nowFn();
    const outputExpiresAt = new Date(now.getTime() + this.policy.outputRetentionMs);
    const res = await this.db.privateRenderJob.updateMany({
      where: {
        id: params.renderJobId,
        generation: params.generation,
        ownerToken: params.ownerToken,
        status: 'RUNNING',
      },
      data: {
        status: 'READY',
        stage: 'ready',
        progressPercent: 100,
        ownerToken: null,
        leaseExpiresAt: null,
        artifactCacheKey: params.artifactCacheKey ?? null,
        outputObjectKey: params.outputObjectKey,
        outputSha256: params.outputSha256,
        outputEtag: params.outputEtag ?? null,
        outputSizeBytes: BigInt(params.outputSizeBytes),
        outputDurationSec: params.outputDurationSec,
        outputWidth: params.outputWidth,
        outputHeight: params.outputHeight,
        outputExpiresAt,
        errorCode: null,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      },
    });
    return res.count === 1;
  }

  async commitRenderFailedFenced(params: {
    renderJobId: string;
    generation: number;
    ownerToken: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<boolean> {
    const now = this.nowFn();
    const res = await this.db.privateRenderJob.updateMany({
      where: {
        id: params.renderJobId,
        generation: params.generation,
        ownerToken: params.ownerToken,
        status: 'RUNNING',
      },
      data: {
        status: 'FAILED',
        stage: 'failed',
        ownerToken: null,
        leaseExpiresAt: null,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage.slice(0, 500),
        completedAt: now,
        updatedAt: now,
      },
    });
    return res.count === 1;
  }

  async releaseRenderForRetry(params: {
    renderJobId: string;
    generation: number;
    ownerToken: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<boolean> {
    const now = this.nowFn();
    const res = await this.db.privateRenderJob.updateMany({
      where: {
        id: params.renderJobId,
        generation: params.generation,
        ownerToken: params.ownerToken,
        status: 'RUNNING',
      },
      data: {
        status: 'QUEUED',
        stage: 'retrying',
        ownerWorkerId: null,
        ownerToken: null,
        leaseExpiresAt: null,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage.slice(0, 500),
        updatedAt: now,
      },
    });
    return res.count === 1;
  }

  /**
   * Bounded crash recovery:
   * 1. Reclaims RUNNING private renders whose worker crashed (leaseExpiresAt <= now):
   *    bumps generation + enqueues a fresh generation BullMQ job up to `maxAttempts`,
   *    or commits terminal FAILED when maxAttempts is exhausted.
   * 2. Dispatches any stranded QUEUED jobs whose initial BullMQ enqueue failed (`bullJobId === null`).
   */
  async reconcileStrandedRenders(batchSize = 10): Promise<ReconcilePrivateRendersResult> {
    const now = this.nowFn();
    const result: ReconcilePrivateRendersResult = {
      dispatchedQueued: 0,
      recoveredExpiredLeases: 0,
      failedMaxAttempts: 0,
    };

    // 1. Recover expired RUNNING leases (worker crash)
    const expired = await this.db.privateRenderJob.findMany({
      where: {
        status: 'RUNNING',
        leaseExpiresAt: { lte: now },
      },
      orderBy: { leaseExpiresAt: 'asc' },
      take: batchSize,
    });

    for (const candidate of expired) {
      const recovery = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "PrivateRenderJob" WHERE "id" = ${candidate.id} FOR UPDATE
        `;
        const row = await tx.privateRenderJob.findUnique({ where: { id: candidate.id } });
        if (
          !row ||
          row.status !== 'RUNNING' ||
          !row.leaseExpiresAt ||
          row.leaseExpiresAt.getTime() > now.getTime()
        ) {
          return { kind: 'noop' as const };
        }

        if (row.attempts >= row.maxAttempts) {
          await tx.privateRenderJob.update({
            where: { id: row.id },
            data: {
              status: 'FAILED',
              stage: 'failed',
              ownerWorkerId: null,
              ownerToken: null,
              leaseExpiresAt: null,
              errorCode: 'MAX_RETRIES_EXCEEDED',
              errorMessage: 'Private render worker did not finish within maximum recovery attempts.',
              completedAt: now,
              updatedAt: now,
            },
          });
          return { kind: 'failed' as const };
        }

        const nextGen = row.generation + 1;
        const updated = await tx.privateRenderJob.update({
          where: { id: row.id },
          data: {
            status: 'QUEUED',
            stage: 'recovering_after_worker_crash',
            generation: nextGen,
            ownerWorkerId: null,
            ownerToken: null,
            leaseExpiresAt: null,
            bullJobId: null,
            updatedAt: now,
          },
        });
        return { kind: 'recovered' as const, row: updated };
      }, TX_OPTS);

      if (recovery.kind === 'failed') {
        result.failedMaxAttempts++;
      } else if (recovery.kind === 'recovered') {
        result.recoveredExpiredLeases++;
        await this.dispatchRenderJobToQueue(recovery.row);
      }
    }

    // 2. Dispatch stranded QUEUED jobs whose bullJobId is null
    const stranded = await this.db.privateRenderJob.findMany({
      where: {
        status: 'QUEUED',
        bullJobId: null,
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    for (const row of stranded) {
      await this.dispatchRenderJobToQueue(row);
      result.dispatchedQueued++;
    }

    return result;
  }
}
