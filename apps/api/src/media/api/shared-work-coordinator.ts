import crypto from 'node:crypto';
import type { Prisma, PrismaClient, MediaSourceTypeEnum, SharedMediaWork } from '@prisma/client';
import type { MediaProcessJobPayload } from '@autoedit/contracts';
import { MediaSourceError } from '../errors.js';
import type { RedisLikeClient } from '../ingestion-coordinator.js';
import { SharedWorkRedisLock, generateWorkOwnerToken } from './shared-work-lock.js';

const TX_OPTS = { maxWait: 15_000, timeout: 20_000 };

/**
 * Generation-scoped deterministic BullMQ jobId so:
 * - Concurrent clippers on the same generation deduplicate to 1 BullMQ job.
 * - Crash recovery or restart after cancellation/failure uses a fresh generation ID
 *   and is never silently ignored by BullMQ's retained completed/failed job history.
 */
export function buildGenerationBullJobId(sharedWorkKey: string, generation: number): string {
  const safeKey = sharedWorkKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeKey}__g${generation}`;
}

export interface SharedWorkCoordinatorOptions {
  keyPrefix?: string;
  /** Default durable worker lease duration in ms (renewed via heartbeat every leaseMs / 3). */
  defaultLeaseMs?: number;
  /** Max outbox enqueue retries before failing stranded work cleanly. */
  maxEnqueueAttempts?: number;
  /** Max crash-recovery generations before failing poison work cleanly. */
  maxRecoveryGenerations?: number;
  /** Injectable clock for deterministic lease-expiry / recovery testing. */
  now?: () => Date;
}

export interface AttachSubscriberInput {
  userId: string;
  mediaSourceId: string;
  canonicalSourceId: string;
  projectId?: string | null;
  idempotencyKey: string;
  sharedWorkKey: string;
  sourceType: MediaSourceTypeEnum;
  options: Record<string, unknown>;
  baseEnqueuePayload: Omit<MediaProcessJobPayload, 'userJobId' | 'generation'>;
  allowSharedReuse: boolean;
}

export interface AttachSubscriberResult {
  job: Prisma.MediaProcessingJobGetPayload<{
    include: { mediaSource: { select: { provider: true } } };
  }>;
  work: SharedMediaWork;
  httpStatus: 200 | 202;
  deduplicatedSharedWork: boolean;
  needsEnqueue: boolean;
  enqueuePayload?: MediaProcessJobPayload;
}

export type ClaimWorkResult =
  | {
      action: 'CLAIMED';
      work: SharedMediaWork;
      generation: number;
      ownerToken: string;
      recoveredFromExpiredLease: boolean;
    }
  | {
      action: 'ALREADY_READY';
      work: SharedMediaWork;
    }
  | {
      action: 'NO_ACTIVE_SUBSCRIBERS';
      work: SharedMediaWork;
    }
  | {
      action: 'ALREADY_OWNED_BY_ACTIVE_WORKER';
      work: SharedMediaWork;
    }
  | {
      action: 'STALE_GENERATION';
      work: SharedMediaWork | null;
    };

export interface DetachCancelResult {
  jobId: string;
  status: 'CANCELLED' | 'READY' | 'FAILED';
  alreadyCompleted?: boolean;
  detachedFromSharedWork: boolean;
  sharedWorkStillActive: boolean;
  sharedWorkKey: string;
  generationToAbort?: number;
}

export interface ReconcileStrandedResult {
  requeuedPendingCount: number;
  recoveredExpiredLeaseCount: number;
  cancelledAbandonedCount: number;
  failedExhaustedCount: number;
}

/**
 * Durable PostgreSQL-authoritative coordinator for shared media work (Step 3B.9.1).
 *
 * Responsibilities:
 * - PostgreSQL (`SharedMediaWork` + `FOR UPDATE` row locks): durable source of truth for
 *   shared-work ownership, monotonic `generation`, `ownerToken`, `leaseExpiresAt`, outbox
 *   `enqueuePayload`, and atomic terminal subscriber publication (zero double sweeps!).
 * - Redis (`SharedWorkRedisLock`): fast owner-tokenized lease with atomic Lua compare-and-delete
 *   and continuous renewal; never trusted as the sole authority if Redis loses keys.
 * - BullMQ: generation-scoped job dispatch (`${sharedWorkKey}__g${generation}`).
 */
export class SharedWorkCoordinator {
  readonly lock: SharedWorkRedisLock;
  readonly defaultLeaseMs: number;
  readonly maxEnqueueAttempts: number;
  readonly maxRecoveryGenerations: number;
  private readonly clock: () => Date;
  /** In-flight-only coalescer for read-only peek lookups (cleared in finally; zero stale caching). */
  private readonly peekCoalescer = new Map<
    string,
    Promise<{ status: string; leaseExpiresAt: Date | null } | null>
  >();

  constructor(
    readonly db: PrismaClient,
    readonly redis: RedisLikeClient,
    opts: SharedWorkCoordinatorOptions = {},
  ) {
    this.lock = new SharedWorkRedisLock(redis, opts.keyPrefix ?? 'autoedit:media:api:');
    this.defaultLeaseMs = opts.defaultLeaseMs ?? 30_000;
    this.maxEnqueueAttempts = opts.maxEnqueueAttempts ?? 5;
    this.maxRecoveryGenerations = opts.maxRecoveryGenerations ?? 5;
    this.clock = opts.now ?? (() => new Date());
  }

  now(): Date {
    return this.clock();
  }

  /**
   * Atomically creates/locks `SharedMediaWork`, attaches a user's `MediaProcessingJob`,
   * and determines whether a BullMQ enqueue is needed — all under ONE row lock so
   * late joiners can NEVER slip through a terminal completion window.
   */
  async attachSubscriberAndReserveWork(
    input: AttachSubscriberInput,
  ): Promise<AttachSubscriberResult> {
    const now = this.now();
    const initialWorkId = `smw_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;

    // Fast non-blocking path for steady-state attach (ENQUEUED / healthy RUNNING / READY):
    // Takes PostgreSQL `FOR KEY SHARE` (never upgraded -> zero deadlock risk):
    // - Allows 1,000 concurrent clippers to attach in parallel.
    // - Does NOT conflict with worker heartbeat `UPDATE leaseExpiresAt` (`FOR NO KEY UPDATE`).
    // - STILL strictly conflicts with `commitWorkReady` / `commitWorkFailed` / `cancel` (`FOR UPDATE`),
    //   preserving 100% linearizable zero-missed-subscriber terminal completion!
    const peekKey = input.sharedWorkKey;
    let peekPromise = this.peekCoalescer.get(peekKey);
    if (!peekPromise) {
      peekPromise = this.db.sharedMediaWork
        .findUnique({
          where: { sharedWorkKey: input.sharedWorkKey },
          select: { status: true, leaseExpiresAt: true },
        })
        .finally(() => {
          this.peekCoalescer.delete(peekKey);
        });
      this.peekCoalescer.set(peekKey, peekPromise);
    }
    const peek = await peekPromise;
    const canTryKeyShareFastPath =
      peek !== null &&
      ((peek.status === 'READY' && input.allowSharedReuse) ||
        peek.status === 'ENQUEUED' ||
        peek.status === 'RUNNING');

    if (canTryKeyShareFastPath) {
      try {
        const fastResult = await this.db.$transaction(async (tx) => {
          // Single-query FOR KEY SHARE lock + row fetch (cuts TX round-trips in half under 1,000-clipper fan-in!)
          const rows = await tx.$queryRaw<SharedMediaWork[]>`
            SELECT * FROM "SharedMediaWork" WHERE "sharedWorkKey" = ${input.sharedWorkKey} FOR KEY SHARE
          `;
          const work = rows[0];
          if (!work) return null;

          if (work.status === 'READY' && input.allowSharedReuse) {
            const readyJob = await tx.mediaProcessingJob.create({
              data: {
                userId: input.userId,
                mediaSourceId: input.mediaSourceId,
                projectId: input.projectId ?? null,
                idempotencyKey: input.idempotencyKey,
                sharedWorkKey: input.sharedWorkKey,
                attachedGeneration: work.generation,
                sourceType: input.sourceType,
                status: 'READY',
                stage: 'ready_cached',
                progressPercent: 100,
                options: input.options as Prisma.InputJsonValue,
                resultSummary: {
                  ...((work.resultSummary as Record<string, unknown> | null) ?? {}),
                  deduplicatedSharedWork: true,
                } as Prisma.InputJsonValue,
                completedAt: now,
              },
              include: { mediaSource: { select: { provider: true } } },
            });
            return {
              job: readyJob,
              work,
              httpStatus: 200 as const,
              deduplicatedSharedWork: true,
              needsEnqueue: false,
            };
          }

          const isHealthyRunning = work.status === 'RUNNING';
          if (work.status === 'ENQUEUED' || isHealthyRunning) {
            const attachedJob = await tx.mediaProcessingJob.create({
              data: {
                userId: input.userId,
                mediaSourceId: input.mediaSourceId,
                projectId: input.projectId ?? null,
                idempotencyKey: input.idempotencyKey,
                sharedWorkKey: input.sharedWorkKey,
                attachedGeneration: work.generation,
                sourceType: input.sourceType,
                status: isHealthyRunning ? 'RUNNING' : 'QUEUED',
                stage: isHealthyRunning ? work.stage : 'queued',
                progressPercent: isHealthyRunning ? work.progressPercent : 0,
                bullJobId: work.bullJobId,
                startedAt: isHealthyRunning ? work.startedAt : null,
                options: input.options as Prisma.InputJsonValue,
                resultSummary:
                  isHealthyRunning && work.resultSummary
                    ? ({
                        ...(work.resultSummary as Record<string, unknown>),
                        deduplicatedSharedWork: true,
                      } as Prisma.InputJsonValue)
                    : ({ deduplicatedSharedWork: true } as Prisma.InputJsonValue),
              },
              include: { mediaSource: { select: { provider: true } } },
            });
            return {
              job: attachedJob,
              work,
              httpStatus: 202 as const,
              deduplicatedSharedWork: true,
              needsEnqueue: false,
            };
          }

          // State changed to PENDING_ENQUEUE / FAILED / CANCELLED / expired -> fall through to FOR UPDATE path!
          return null;
        }, TX_OPTS);

        if (fastResult) {
          return fastResult;
        }
      } catch (err: any) {
        if (err?.code === 'P2002') {
          const winner = await this.db.mediaProcessingJob.findUniqueOrThrow({
            where: {
              userId_idempotencyKey: {
                userId: input.userId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            include: { mediaSource: { select: { provider: true } } },
          });
          const work = await this.db.sharedMediaWork.findUniqueOrThrow({
            where: { sharedWorkKey: winner.sharedWorkKey },
          });
          return {
            job: winner,
            work,
            httpStatus: 200,
            deduplicatedSharedWork: true,
            needsEnqueue: false,
          };
        }
        throw err;
      }
    }

    try {
      return await this.db.$transaction(async (tx) => {
        // 1. Re-check per-user idempotency inside TX
        const existingIdem = await tx.mediaProcessingJob.findUnique({
          where: {
            userId_idempotencyKey: {
              userId: input.userId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: { mediaSource: { select: { provider: true } } },
        });
        if (existingIdem) {
          const existingWork = await tx.sharedMediaWork.findUnique({
            where: { sharedWorkKey: existingIdem.sharedWorkKey },
          });
          return {
            job: existingIdem,
            work: existingWork!,
            httpStatus: 200 as const,
            deduplicatedSharedWork: true,
            needsEnqueue: false,
          };
        }

        // 2. Ensure SharedMediaWork row exists without P2002 races under 1,000 concurrent clippers
        await tx.$executeRaw`
          INSERT INTO "SharedMediaWork" (
            "id", "sharedWorkKey", "mediaSourceId", "canonicalSourceId", "sourceType",
            "status", "generation", "stage", "progressPercent", "createdAt", "updatedAt"
          )
          VALUES (
            ${initialWorkId},
            ${input.sharedWorkKey},
            ${input.mediaSourceId},
            ${input.canonicalSourceId},
            ${input.sourceType}::"MediaSourceTypeEnum",
            'PENDING_ENQUEUE'::"SharedWorkStatusEnum",
            1,
            'queued',
            0,
            ${now},
            ${now}
          )
          ON CONFLICT ("sharedWorkKey") DO NOTHING
        `;

        // 3. Acquire exclusive row lock on SharedMediaWork — serializes against worker terminal commit!
        await tx.$queryRaw`
          SELECT "id" FROM "SharedMediaWork" WHERE "sharedWorkKey" = ${input.sharedWorkKey} FOR UPDATE
        `;

        let work = await tx.sharedMediaWork.findUniqueOrThrow({
          where: { sharedWorkKey: input.sharedWorkKey },
        });

        // Case A: Already READY -> late joiner gets instant READY row with ZERO worker execution!
        if (work.status === 'READY' && input.allowSharedReuse) {
          const readyJob = await tx.mediaProcessingJob.create({
            data: {
              userId: input.userId,
              mediaSourceId: input.mediaSourceId,
              projectId: input.projectId ?? null,
              idempotencyKey: input.idempotencyKey,
              sharedWorkKey: input.sharedWorkKey,
              attachedGeneration: work.generation,
              sourceType: input.sourceType,
              status: 'READY',
              stage: 'ready_cached',
              progressPercent: 100,
              options: input.options as Prisma.InputJsonValue,
              resultSummary: {
                ...((work.resultSummary as Record<string, unknown> | null) ?? {}),
                deduplicatedSharedWork: true,
              } as Prisma.InputJsonValue,
              completedAt: now,
            },
            include: { mediaSource: { select: { provider: true } } },
          });
          return {
            job: readyJob,
            work,
            httpStatus: 200 as const,
            deduplicatedSharedWork: true,
            needsEnqueue: false,
          };
        }

        // Case B: Prior work FAILED or CANCELLED -> bump generation and transition cleanly to PENDING_ENQUEUE!
        // (Expired RUNNING worker leases are recovered exclusively by bounded reconcileStrandedWork so
        // concurrent hot-path subscribers never preempt a live FFmpeg worker into duplicate enqueues.)
        const isTerminalRestart =
          work.status === 'FAILED' ||
          work.status === 'CANCELLED' ||
          (work.status === 'READY' && !input.allowSharedReuse);

        let needsEnqueue = false;
        let nextGen = work.generation;
        let deduplicatedSharedWork = false;

        if (isTerminalRestart) {
          nextGen = work.generation + 1;
          needsEnqueue = true;
          deduplicatedSharedWork = false;
        } else if (work.status === 'PENDING_ENQUEUE') {
          // Brand-new row (no enqueuePayload yet) OR stranded outbox ready for retry
          const isBrandNew = work.enqueuePayload === null;
          const retryDue =
            work.nextEnqueueAt === null || work.nextEnqueueAt.getTime() <= now.getTime();
          needsEnqueue = isBrandNew || retryDue;
          deduplicatedSharedWork = !isBrandNew;
        } else {
          // ENQUEUED or RUNNING -> attach without re-enqueueing!
          needsEnqueue = false;
          deduplicatedSharedWork = true;
        }

        const initialJobStatus = work.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
        const initialSummary =
          work.status === 'RUNNING' && work.resultSummary
            ? ({
                ...(work.resultSummary as Record<string, unknown>),
                deduplicatedSharedWork: true,
              } as Prisma.InputJsonValue)
            : ({ deduplicatedSharedWork } as Prisma.InputJsonValue);

        const createdJob = await tx.mediaProcessingJob.create({
          data: {
            userId: input.userId,
            mediaSourceId: input.mediaSourceId,
            projectId: input.projectId ?? null,
            idempotencyKey: input.idempotencyKey,
            sharedWorkKey: input.sharedWorkKey,
            attachedGeneration: nextGen,
            sourceType: input.sourceType,
            status: initialJobStatus,
            stage: work.status === 'RUNNING' ? work.stage : 'queued',
            progressPercent: work.status === 'RUNNING' ? work.progressPercent : 0,
            bullJobId:
              work.status === 'ENQUEUED' || work.status === 'RUNNING' ? work.bullJobId : null,
            startedAt: work.status === 'RUNNING' ? work.startedAt : null,
            options: input.options as Prisma.InputJsonValue,
            resultSummary: initialSummary,
          },
          include: { mediaSource: { select: { provider: true } } },
        });

        let enqueuePayload: MediaProcessJobPayload | undefined;
        if (needsEnqueue) {
          enqueuePayload = {
            ...input.baseEnqueuePayload,
            userJobId: createdJob.id,
            generation: nextGen,
          };
          work = await tx.sharedMediaWork.update({
            where: { id: work.id },
            data: {
              status: 'PENDING_ENQUEUE',
              generation: nextGen,
              ownerWorkerId: null,
              ownerToken: null,
              leaseExpiresAt: null,
              errorCode: null,
              errorMessage: null,
              stage: 'queued',
              progressPercent: 0,
              resultSummary: isTerminalRestart ? undefined : (work.resultSummary ?? undefined),
              enqueuePayload: enqueuePayload as unknown as Prisma.InputJsonValue,
              enqueueAttempts: isTerminalRestart ? 0 : work.enqueueAttempts,
              // Short dispatch lease (5s) so concurrent arrivals don't stampede enqueueFn while we dispatch,
              // yet an API crash before enqueue recovers promptly!
              nextEnqueueAt: new Date(now.getTime() + 5_000),
              updatedAt: now,
            },
          });
        }

        return {
          job: createdJob,
          work,
          httpStatus: 202 as const,
          deduplicatedSharedWork,
          needsEnqueue,
          enqueuePayload,
        };
      }, TX_OPTS);
    } catch (err: any) {
      // Concurrent duplicate POST with same (userId, idempotencyKey) -> return existing row cleanly!
      if (err?.code === 'P2002') {
        const winner = await this.db.mediaProcessingJob.findUniqueOrThrow({
          where: {
            userId_idempotencyKey: {
              userId: input.userId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: { mediaSource: { select: { provider: true } } },
        });
        const work = await this.db.sharedMediaWork.findUniqueOrThrow({
          where: { sharedWorkKey: winner.sharedWorkKey },
        });
        return {
          job: winner,
          work,
          httpStatus: 200,
          deduplicatedSharedWork: true,
          needsEnqueue: false,
        };
      }
      throw err;
    }
  }

  /**
   * Crash-safe outbox dispatch: enqueues BullMQ job with generation-scoped jobId and
   * marks SharedMediaWork ENQUEUED. On transient enqueue failure, records bounded
   * exponential backoff in PostgreSQL so reconciliation recovers without losing jobs.
   */
  async dispatchPendingEnqueue(params: {
    sharedWorkKey: string;
    generation: number;
    payload: MediaProcessJobPayload;
    enqueueFn: (
      payload: MediaProcessJobPayload,
      opts: { jobId: string },
    ) => Promise<{ id?: string }>;
  }): Promise<{ enqueued: boolean; bullJobId?: string; error?: string }> {
    const jobId = buildGenerationBullJobId(params.sharedWorkKey, params.generation);
    try {
      const bullJob = await params.enqueueFn(
        { ...params.payload, generation: params.generation },
        { jobId },
      );
      const bullJobId = bullJob?.id ? String(bullJob.id) : jobId;
      const now = this.now();

      await this.db.sharedMediaWork.updateMany({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          generation: params.generation,
          status: 'PENDING_ENQUEUE',
        },
        data: {
          status: 'ENQUEUED',
          bullJobId,
          enqueueAttempts: { increment: 1 },
          nextEnqueueAt: null,
          updatedAt: now,
        },
      });

      await this.db.mediaProcessingJob
        .updateMany({
          where: {
            sharedWorkKey: params.sharedWorkKey,
            status: 'QUEUED',
            bullJobId: null,
          },
          data: { bullJobId },
        })
        .catch(() => {});

      return { enqueued: true, bullJobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const now = this.now();

      const updated = await this.db.$transaction(async (tx) => {
        const cur = await tx.sharedMediaWork.findUnique({
          where: { sharedWorkKey: params.sharedWorkKey },
        });
        if (!cur || cur.generation !== params.generation || cur.status !== 'PENDING_ENQUEUE') {
          return null;
        }
        const nextAttempts = cur.enqueueAttempts + 1;
        const backoffMs = Math.min(30_000, 500 * Math.pow(2, nextAttempts - 1));
        return tx.sharedMediaWork.update({
          where: { id: cur.id },
          data: {
            enqueueAttempts: nextAttempts,
            nextEnqueueAt: new Date(now.getTime() + backoffMs),
            errorMessage: `Enqueue attempt ${nextAttempts} failed: ${msg}`,
            updatedAt: now,
          },
        });
      }, TX_OPTS);

      return {
        enqueued: false,
        error: updated ? msg : `stale_or_already_dispatched: ${msg}`,
      };
    }
  }

  /**
   * Authoritative PostgreSQL claim for a BullMQ worker starting execution.
   * Prevents duplicate active execution even if Redis keys were deleted or expired!
   */
  async claimWorkExecution(params: {
    sharedWorkKey: string;
    payloadGeneration?: number;
    workerId: string;
    bullJobId?: string;
    leaseMs?: number;
  }): Promise<ClaimWorkResult> {
    const now = this.now();
    const leaseMs = params.leaseMs ?? this.defaultLeaseMs;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    const txResult = await this.db.$transaction(async (tx): Promise<ClaimWorkResult> => {
      await tx.$queryRaw`
        SELECT "id" FROM "SharedMediaWork" WHERE "sharedWorkKey" = ${params.sharedWorkKey} FOR UPDATE
      `;
      const work = await tx.sharedMediaWork.findUnique({
        where: { sharedWorkKey: params.sharedWorkKey },
      });
      if (!work) {
        return { action: 'STALE_GENERATION', work: null };
      }

      // Already READY -> sync any lagging QUEUED/RUNNING subscribers (never CANCELLED!) and skip work
      if (work.status === 'READY') {
        await tx.mediaProcessingJob.updateMany({
          where: {
            sharedWorkKey: params.sharedWorkKey,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
          data: {
            status: 'READY',
            stage: 'completed',
            progressPercent: 100,
            completedAt: work.completedAt ?? now,
            resultSummary: (work.resultSummary ?? {}) as Prisma.InputJsonValue,
          },
        });
        return { action: 'ALREADY_READY', work };
      }

      // Stale BullMQ message from an older generation -> reject without running duplicate work!
      if (params.payloadGeneration !== undefined && params.payloadGeneration < work.generation) {
        return { action: 'STALE_GENERATION', work };
      }

      if (work.status === 'CANCELLED' || work.status === 'FAILED') {
        return { action: 'STALE_GENERATION', work };
      }

      // Verify at least 1 active subscriber remains (handles cancel-before-start & cancel-during-retry!)
      const activeSubscribers = await tx.mediaProcessingJob.count({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });
      if (activeSubscribers === 0) {
        const cancelledWork = await tx.sharedMediaWork.update({
          where: { id: work.id },
          data: {
            status: 'CANCELLED',
            stage: 'cancelled',
            ownerWorkerId: null,
            ownerToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          },
        });
        return { action: 'NO_ACTIVE_SUBSCRIBERS', work: cancelledWork };
      }

      // Check durable PostgreSQL lease when already RUNNING
      let recoveredFromExpiredLease = false;
      let claimGeneration = work.generation;

      if (work.status === 'RUNNING') {
        if (work.leaseExpiresAt && work.leaseExpiresAt.getTime() > now.getTime()) {
          // Another live worker STILL holds a valid PostgreSQL lease!
          return { action: 'ALREADY_OWNED_BY_ACTIVE_WORKER', work };
        }
        // Previous owner crashed / stalled past PostgreSQL lease -> fence it out by bumping generation!
        claimGeneration = work.generation + 1;
        recoveredFromExpiredLease = true;
      }

      const ownerToken = generateWorkOwnerToken(params.workerId, claimGeneration);
      const updatedWork = await tx.sharedMediaWork.update({
        where: { id: work.id },
        data: {
          status: 'RUNNING',
          generation: claimGeneration,
          ownerWorkerId: params.workerId,
          ownerToken,
          leaseExpiresAt,
          bullJobId: params.bullJobId ?? work.bullJobId,
          stage: 'acquiring_source',
          progressPercent: Math.max(work.progressPercent, 10),
          startedAt: work.startedAt ?? now,
          updatedAt: now,
        },
      });

      // Advance active QUEUED subscribers to RUNNING (NEVER regress READY or CANCELLED!)
      await tx.mediaProcessingJob.updateMany({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          status: 'QUEUED',
        },
        data: {
          status: 'RUNNING',
          stage: 'acquiring_source',
          progressPercent: Math.max(work.progressPercent, 10),
          startedAt: now,
          attachedGeneration: claimGeneration,
          bullJobId: params.bullJobId ?? work.bullJobId,
        },
      });

      return {
        action: 'CLAIMED',
        work: updatedWork,
        generation: claimGeneration,
        ownerToken,
        recoveredFromExpiredLease,
      };
    }, TX_OPTS);

    // Best-effort fast Redis lease acquisition (PostgreSQL already fenced ownership durably!)
    if (txResult.action === 'CLAIMED') {
      await this.lock
        .acquire({
          sharedWorkKey: params.sharedWorkKey,
          token: txResult.ownerToken,
          ttlMs: leaseMs,
        })
        .catch(() => {});
    }

    return txResult;
  }

  /**
   * Conditionally renews BOTH the durable PostgreSQL lease and owner-tokenized Redis lock.
   * Returns `{ renewed: false }` if generation/ownerToken no longer matches (fenced!).
   * If Redis lost its key (eviction/restart) while PostgreSQL still confirms ownership,
   * safely re-establishes the Redis lock with the exact same ownerToken.
   */
  async renewWorkLease(params: {
    sharedWorkKey: string;
    generation: number;
    ownerToken: string;
    leaseMs?: number;
  }): Promise<{ renewed: boolean; activeSubscribers: number }> {
    const now = this.now();
    const leaseMs = params.leaseMs ?? this.defaultLeaseMs;
    const nextExpiry = new Date(now.getTime() + leaseMs);

    const updated = await this.db.sharedMediaWork.updateMany({
      where: {
        sharedWorkKey: params.sharedWorkKey,
        generation: params.generation,
        ownerToken: params.ownerToken,
        status: 'RUNNING',
      },
      data: {
        leaseExpiresAt: nextExpiry,
        updatedAt: now,
      },
    });

    if (updated.count === 0) {
      return { renewed: false, activeSubscribers: 0 };
    }

    const activeSubscribers = await this.db.mediaProcessingJob.count({
      where: {
        sharedWorkKey: params.sharedWorkKey,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });

    // Renew Redis lease (or re-acquire if Redis flushed while PostgreSQL confirmed ownership)
    try {
      const redisRenewed = await this.lock.renew({
        sharedWorkKey: params.sharedWorkKey,
        token: params.ownerToken,
        ttlMs: leaseMs,
      });
      if (!redisRenewed) {
        await this.lock.acquire({
          sharedWorkKey: params.sharedWorkKey,
          token: params.ownerToken,
          ttlMs: leaseMs,
        });
      }
    } catch {
      // Redis transient hiccup does not invalidate PostgreSQL durable lease
    }

    return { renewed: true, activeSubscribers };
  }

  /**
   * Generation- and ownerToken-fenced intermediate progress / live-highlight update.
   * Uses conditional UPDATE (PostgreSQL `FOR NO KEY UPDATE`) so intermediate progress ticks
   * NEVER create a `FOR UPDATE` lock convoy against 1,000 concurrent `FOR KEY SHARE` clippers,
   * while still rejecting stale generations / wrong ownerTokens with LEASE_EXPIRED.
   */
  async publishProgressFenced(params: {
    sharedWorkKey: string;
    generation: number;
    ownerToken: string;
    stage: string;
    progressPercent: number;
    resultSummary?: Prisma.InputJsonValue;
  }): Promise<void> {
    const now = this.now();
    await this.db.$transaction(async (tx) => {
      const updated = await tx.sharedMediaWork.updateMany({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          generation: params.generation,
          ownerToken: params.ownerToken,
          status: 'RUNNING',
        },
        data: {
          stage: params.stage,
          progressPercent: params.progressPercent,
          ...(params.resultSummary !== undefined ? { resultSummary: params.resultSummary } : {}),
          updatedAt: now,
        },
      });
      if (updated.count === 0) {
        throw new MediaSourceError({
          code: 'LEASE_EXPIRED',
          message: `Stale worker (gen ${params.generation}) rejected from updating progress on ${params.sharedWorkKey}.`,
        });
      }

      // Strictly update ONLY active QUEUED/RUNNING subscribers (never CANCELLED or READY!)
      await tx.mediaProcessingJob.updateMany({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        data: {
          status: 'RUNNING',
          stage: params.stage,
          progressPercent: params.progressPercent,
          ...(params.resultSummary !== undefined ? { resultSummary: params.resultSummary } : {}),
        },
      });
    }, TX_OPTS);
  }

  /**
   * Atomic terminal READY publication under exclusive `SharedMediaWork` row lock.
   * Replaces double database sweeps with a single linearizable transaction:
   * - Rejects stale generation / wrong ownerToken with LEASE_EXPIRED.
   * - Atomically marks SharedMediaWork + ALL active QUEUED/RUNNING subscribers READY.
   * - NEVER regresses CANCELLED -> READY.
   */
  async commitWorkReady(params: {
    sharedWorkKey: string;
    generation: number;
    ownerToken: string;
    resultSummary: Prisma.InputJsonValue;
  }): Promise<{ updatedSubscribers: number; work: SharedMediaWork }> {
    const now = this.now();
    return await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "SharedMediaWork" WHERE "sharedWorkKey" = ${params.sharedWorkKey} FOR UPDATE
      `;
      const work = await tx.sharedMediaWork.findUnique({
        where: { sharedWorkKey: params.sharedWorkKey },
      });
      if (
        !work ||
        work.status !== 'RUNNING' ||
        work.generation !== params.generation ||
        work.ownerToken !== params.ownerToken
      ) {
        throw new MediaSourceError({
          code: 'LEASE_EXPIRED',
          message: `Stale worker (gen ${params.generation}) rejected from publishing READY on ${params.sharedWorkKey}.`,
        });
      }

      const updatedWork = await tx.sharedMediaWork.update({
        where: { id: work.id },
        data: {
          status: 'READY',
          stage: 'completed',
          progressPercent: 100,
          resultSummary: params.resultSummary,
          completedAt: now,
          ownerToken: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        },
      });

      const subRes = await tx.mediaProcessingJob.updateMany({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        data: {
          status: 'READY',
          stage: 'completed',
          progressPercent: 100,
          completedAt: now,
          resultSummary: params.resultSummary,
        },
      });

      return { updatedSubscribers: subRes.count, work: updatedWork };
    }, TX_OPTS);
  }

  /**
   * Releases ownership on a retryable failure so BullMQ's next attempt can cleanly claim
   * the same generation without being blocked by an active lease.
   */
  async releaseLeaseForRetry(params: {
    sharedWorkKey: string;
    generation: number;
    ownerToken: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const now = this.now();
    await this.db.sharedMediaWork.updateMany({
      where: {
        sharedWorkKey: params.sharedWorkKey,
        generation: params.generation,
        ownerToken: params.ownerToken,
        status: 'RUNNING',
      },
      data: {
        status: 'ENQUEUED',
        stage: 'retry_scheduled',
        ownerWorkerId: null,
        ownerToken: null,
        leaseExpiresAt: null,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
        updatedAt: now,
      },
    });
  }

  /**
   * Fenced terminal FAILED commit (only on final retry exhaustion or non-retryable error).
   * Never overwrites READY or CANCELLED subscribers.
   */
  async commitWorkFailed(params: {
    sharedWorkKey: string;
    generation: number;
    ownerToken: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<boolean> {
    const now = this.now();
    return await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "SharedMediaWork" WHERE "sharedWorkKey" = ${params.sharedWorkKey} FOR UPDATE
      `;
      const work = await tx.sharedMediaWork.findUnique({
        where: { sharedWorkKey: params.sharedWorkKey },
      });
      if (
        !work ||
        work.status !== 'RUNNING' ||
        work.generation !== params.generation ||
        work.ownerToken !== params.ownerToken
      ) {
        return false;
      }

      await tx.sharedMediaWork.update({
        where: { id: work.id },
        data: {
          status: 'FAILED',
          stage: 'failed',
          errorCode: params.errorCode,
          errorMessage: params.errorMessage,
          ownerToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });

      await tx.mediaProcessingJob.updateMany({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        data: {
          status: 'FAILED',
          stage: 'failed',
          errorCode: params.errorCode,
          errorMessage: params.errorMessage,
        },
      });

      return true;
    }, TX_OPTS);
  }

  /**
   * Fenced cancellation transition when worker aborts because active subscribers dropped to 0.
   * Re-verifies inside FOR UPDATE that no new subscriber arrived concurrently!
   */
  async commitWorkCancelledIfNoSubscribers(params: {
    sharedWorkKey: string;
    generation: number;
    ownerToken: string;
  }): Promise<{ cancelled: boolean; newSubscribersJoined: boolean }> {
    const now = this.now();
    return await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "SharedMediaWork" WHERE "sharedWorkKey" = ${params.sharedWorkKey} FOR UPDATE
      `;
      const work = await tx.sharedMediaWork.findUnique({
        where: { sharedWorkKey: params.sharedWorkKey },
      });
      if (
        !work ||
        work.status !== 'RUNNING' ||
        work.generation !== params.generation ||
        work.ownerToken !== params.ownerToken
      ) {
        return { cancelled: false, newSubscribersJoined: false };
      }

      const activeCount = await tx.mediaProcessingJob.count({
        where: {
          sharedWorkKey: params.sharedWorkKey,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });

      if (activeCount > 0) {
        // A brand-new subscriber joined while cancelling -> bump generation & re-queue so it is NEVER stranded!
        const nextGen = work.generation + 1;
        const basePayload = (work.enqueuePayload as MediaProcessJobPayload | null) ?? undefined;
        await tx.sharedMediaWork.update({
          where: { id: work.id },
          data: {
            status: 'PENDING_ENQUEUE',
            generation: nextGen,
            ownerWorkerId: null,
            ownerToken: null,
            leaseExpiresAt: null,
            stage: 'queued',
            progressPercent: 0,
            enqueuePayload: basePayload
              ? ({ ...basePayload, generation: nextGen } as unknown as Prisma.InputJsonValue)
              : undefined,
            nextEnqueueAt: now,
            updatedAt: now,
          },
        });
        return { cancelled: false, newSubscribersJoined: true };
      }

      await tx.sharedMediaWork.update({
        where: { id: work.id },
        data: {
          status: 'CANCELLED',
          stage: 'cancelled',
          ownerWorkerId: null,
          ownerToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
      return { cancelled: true, newSubscribersJoined: false };
    }, TX_OPTS);
  }

  /**
   * Race-safe per-user cancellation serialized against `SharedMediaWork` (`FOR UPDATE`):
   * - NEVER regresses `READY -> CANCELLED` or `FAILED -> CANCELLED`.
   * - Detaches ONLY the authenticated user's job.
   * - Keeps shared work active if any other eligible subscriber remains.
   * - Marks `PENDING_ENQUEUE`/`ENQUEUED` work `CANCELLED` if last subscriber detaches,
   *   or returns exact `generationToAbort` for an active `RUNNING` worker.
   */
  async detachSubscriberAndEvaluateCancel(params: {
    userId: string;
    jobId: string;
  }): Promise<DetachCancelResult> {
    const now = this.now();
    return await this.db.$transaction(async (tx) => {
      const initialJob = await tx.mediaProcessingJob.findFirst({
        where: { id: params.jobId, userId: params.userId },
      });
      if (!initialJob) {
        throw new MediaSourceError({
          code: 'SOURCE_UNAVAILABLE',
          message: 'Media job not found.',
          statusCode: 404,
        });
      }

      // Lock SharedMediaWork first to serialize cleanly against commitWorkReady & attachSubscriber!
      await tx.$queryRaw`
        SELECT "id" FROM "SharedMediaWork" WHERE "sharedWorkKey" = ${initialJob.sharedWorkKey} FOR UPDATE
      `;
      const work = await tx.sharedMediaWork.findUnique({
        where: { sharedWorkKey: initialJob.sharedWorkKey },
      });

      // Re-read job inside the lock to observe any concurrent READY/FAILED commit
      const job = await tx.mediaProcessingJob.findUniqueOrThrow({
        where: { id: initialJob.id },
      });

      if (job.status === 'READY' || job.status === 'FAILED') {
        return {
          jobId: job.id,
          status: job.status,
          alreadyCompleted: true,
          detachedFromSharedWork: false,
          sharedWorkStillActive: false,
          sharedWorkKey: job.sharedWorkKey,
        };
      }

      if (job.status !== 'CANCELLED') {
        await tx.mediaProcessingJob.update({
          where: { id: job.id },
          data: {
            status: 'CANCELLED',
            stage: 'cancelled',
            cancelledAt: now,
          },
        });
      }

      const remainingActive = await tx.mediaProcessingJob.count({
        where: {
          sharedWorkKey: job.sharedWorkKey,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });

      if (remainingActive > 0) {
        return {
          jobId: job.id,
          status: 'CANCELLED',
          detachedFromSharedWork: true,
          sharedWorkStillActive: true,
          sharedWorkKey: job.sharedWorkKey,
        };
      }

      // Zero active subscribers remain
      let generationToAbort: number | undefined;
      if (work) {
        if (work.status === 'PENDING_ENQUEUE' || work.status === 'ENQUEUED') {
          await tx.sharedMediaWork.update({
            where: { id: work.id },
            data: {
              status: 'CANCELLED',
              stage: 'cancelled',
              ownerWorkerId: null,
              ownerToken: null,
              leaseExpiresAt: null,
              updatedAt: now,
            },
          });
        } else if (work.status === 'RUNNING') {
          generationToAbort = work.generation;
          await tx.sharedMediaWork.update({
            where: { id: work.id },
            data: {
              stage: 'cancelling',
              updatedAt: now,
            },
          });
        }
      }

      return {
        jobId: job.id,
        status: 'CANCELLED',
        detachedFromSharedWork: true,
        sharedWorkStillActive: false,
        sharedWorkKey: job.sharedWorkKey,
        generationToAbort,
      };
    }, TX_OPTS);
  }

  /**
   * Idempotent read-side self-heal: if a subscriber job is still QUEUED/RUNNING while its
   * authoritative SharedMediaWork has already reached READY or FAILED, syncs that row cleanly
   * (never touching CANCELLED rows!).
   */
  async syncSubscriberFromWorkIfNeeded(
    job: Prisma.MediaProcessingJobGetPayload<{
      include: { mediaSource: { select: { provider: true } } };
    }>,
  ): Promise<
    Prisma.MediaProcessingJobGetPayload<{
      include: { mediaSource: { select: { provider: true } } };
    }>
  > {
    if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
      return job;
    }
    const work = await this.db.sharedMediaWork.findUnique({
      where: { sharedWorkKey: job.sharedWorkKey },
    });
    if (!work) return job;

    if (work.status === 'READY') {
      await this.db.mediaProcessingJob.updateMany({
        where: { id: job.id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'READY',
          stage: 'completed',
          progressPercent: 100,
          completedAt: work.completedAt ?? this.now(),
          resultSummary: (work.resultSummary ?? {}) as Prisma.InputJsonValue,
        },
      });
      return this.db.mediaProcessingJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { mediaSource: { select: { provider: true } } },
      });
    }

    if (work.status === 'FAILED') {
      await this.db.mediaProcessingJob.updateMany({
        where: { id: job.id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          stage: 'failed',
          errorCode: work.errorCode ?? 'INFRA_ERROR',
          errorMessage: work.errorMessage ?? 'Shared media processing failed.',
        },
      });
      return this.db.mediaProcessingJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { mediaSource: { select: { provider: true } } },
      });
    }

    return job;
  }

  /**
   * Bounded crash reconciliation sweep for:
   * 1. Stranded `PENDING_ENQUEUE` outbox rows (API crash before enqueue or transient Redis outage)
   * 2. Expired `RUNNING` leases (worker OS crash / SIGKILL without running cleanup)
   *
   * Safe to run concurrently from multiple API or worker instances (every state transition
   * uses `FOR UPDATE` row locking and generation-scoped BullMQ deduplication).
   */
  async reconcileStrandedWork(params: {
    enqueueFn: (
      payload: MediaProcessJobPayload,
      opts: { jobId: string },
    ) => Promise<{ id?: string }>;
    batchSize?: number;
  }): Promise<ReconcileStrandedResult> {
    const now = this.now();
    const limit = Math.max(1, Math.min(params.batchSize ?? 20, 100));
    const stats: ReconcileStrandedResult = {
      requeuedPendingCount: 0,
      recoveredExpiredLeaseCount: 0,
      cancelledAbandonedCount: 0,
      failedExhaustedCount: 0,
    };

    // Phase 1: Stranded PENDING_ENQUEUE rows whose retry window is due
    const pendingRows = await this.db.sharedMediaWork.findMany({
      where: {
        status: 'PENDING_ENQUEUE',
        OR: [{ nextEnqueueAt: null }, { nextEnqueueAt: { lte: now } }],
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });

    for (const row of pendingRows) {
      const activeCount = await this.db.mediaProcessingJob.count({
        where: {
          sharedWorkKey: row.sharedWorkKey,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });

      if (activeCount === 0) {
        const res = await this.db.sharedMediaWork.updateMany({
          where: {
            id: row.id,
            generation: row.generation,
            status: 'PENDING_ENQUEUE',
          },
          data: { status: 'CANCELLED', stage: 'cancelled', updatedAt: now },
        });
        if (res.count > 0) stats.cancelledAbandonedCount++;
        continue;
      }

      if (row.enqueueAttempts >= this.maxEnqueueAttempts) {
        await this.db.$transaction(async (tx) => {
          const r = await tx.sharedMediaWork.updateMany({
            where: {
              id: row.id,
              generation: row.generation,
              status: 'PENDING_ENQUEUE',
            },
            data: {
              status: 'FAILED',
              stage: 'failed',
              errorCode: 'INFRA_ERROR',
              errorMessage: `Exceeded max enqueue attempts (${this.maxEnqueueAttempts}).`,
              updatedAt: now,
            },
          });
          if (r.count > 0) {
            await tx.mediaProcessingJob.updateMany({
              where: {
                sharedWorkKey: row.sharedWorkKey,
                status: { in: ['QUEUED', 'RUNNING'] },
              },
              data: {
                status: 'FAILED',
                stage: 'failed',
                errorCode: 'INFRA_ERROR',
                errorMessage: `Exceeded max enqueue attempts (${this.maxEnqueueAttempts}).`,
              },
            });
            stats.failedExhaustedCount++;
          }
        }, TX_OPTS);
        continue;
      }

      const payload = row.enqueuePayload as MediaProcessJobPayload | null;
      if (!payload) continue;

      const dispatch = await this.dispatchPendingEnqueue({
        sharedWorkKey: row.sharedWorkKey,
        generation: row.generation,
        payload,
        enqueueFn: params.enqueueFn,
      });
      if (dispatch.enqueued) {
        stats.requeuedPendingCount++;
      }
    }

    // Phase 2: Expired RUNNING leases (crashed worker process!)
    const expiredRows = await this.db.sharedMediaWork.findMany({
      where: {
        status: 'RUNNING',
        leaseExpiresAt: { lte: now },
      },
      orderBy: { leaseExpiresAt: 'asc' },
      take: limit,
    });

    for (const row of expiredRows) {
      const recovery = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "SharedMediaWork" WHERE "id" = ${row.id} FOR UPDATE
        `;
        const locked = await tx.sharedMediaWork.findUnique({ where: { id: row.id } });
        if (
          !locked ||
          locked.status !== 'RUNNING' ||
          !locked.leaseExpiresAt ||
          locked.leaseExpiresAt.getTime() > now.getTime()
        ) {
          return { action: 'SKIP' as const };
        }

        const activeCount = await tx.mediaProcessingJob.count({
          where: {
            sharedWorkKey: locked.sharedWorkKey,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        });
        if (activeCount === 0) {
          await tx.sharedMediaWork.update({
            where: { id: locked.id },
            data: {
              status: 'CANCELLED',
              stage: 'cancelled',
              ownerWorkerId: null,
              ownerToken: null,
              leaseExpiresAt: null,
              updatedAt: now,
            },
          });
          return { action: 'CANCELLED' as const };
        }

        if (locked.generation >= this.maxRecoveryGenerations) {
          await tx.sharedMediaWork.update({
            where: { id: locked.id },
            data: {
              status: 'FAILED',
              stage: 'failed',
              errorCode: 'LEASE_EXPIRED',
              errorMessage: `Exceeded max worker crash recovery generations (${this.maxRecoveryGenerations}).`,
              ownerWorkerId: null,
              ownerToken: null,
              leaseExpiresAt: null,
              updatedAt: now,
            },
          });
          await tx.mediaProcessingJob.updateMany({
            where: {
              sharedWorkKey: locked.sharedWorkKey,
              status: { in: ['QUEUED', 'RUNNING'] },
            },
            data: {
              status: 'FAILED',
              stage: 'failed',
              errorCode: 'LEASE_EXPIRED',
              errorMessage: `Exceeded max worker crash recovery generations (${this.maxRecoveryGenerations}).`,
            },
          });
          return { action: 'EXHAUSTED' as const };
        }

        const nextGen = locked.generation + 1;
        const basePayload = locked.enqueuePayload as MediaProcessJobPayload | null;
        const nextPayload = basePayload
          ? { ...basePayload, generation: nextGen }
          : null;

        await tx.sharedMediaWork.update({
          where: { id: locked.id },
          data: {
            status: 'PENDING_ENQUEUE',
            generation: nextGen,
            ownerWorkerId: null,
            ownerToken: null,
            leaseExpiresAt: null,
            stage: 'recovering_after_worker_crash',
            enqueueAttempts: 0,
            nextEnqueueAt: new Date(now.getTime() + 5_000),
            enqueuePayload: nextPayload
              ? (nextPayload as unknown as Prisma.InputJsonValue)
              : undefined,
            updatedAt: now,
          },
        });

        // Reset active RUNNING subscribers back to QUEUED cleanly while awaiting recovery worker
        await tx.mediaProcessingJob.updateMany({
          where: {
            sharedWorkKey: locked.sharedWorkKey,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
          data: {
            status: 'QUEUED',
            stage: 'recovering_after_worker_crash',
            attachedGeneration: nextGen,
          },
        });

        return {
          action: 'RECOVER' as const,
          sharedWorkKey: locked.sharedWorkKey,
          generation: nextGen,
          payload: nextPayload,
        };
      }, TX_OPTS);

      if (recovery.action === 'CANCELLED') {
        stats.cancelledAbandonedCount++;
      } else if (recovery.action === 'EXHAUSTED') {
        stats.failedExhaustedCount++;
      } else if (recovery.action === 'RECOVER' && recovery.payload) {
        const dispatch = await this.dispatchPendingEnqueue({
          sharedWorkKey: recovery.sharedWorkKey,
          generation: recovery.generation,
          payload: recovery.payload,
          enqueueFn: params.enqueueFn,
        });
        if (dispatch.enqueued) {
          stats.recoveredExpiredLeaseCount++;
        }
      }
    }

    return stats;
  }
}
