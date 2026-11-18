# Universal Media API, Durable Shared-Work Coordination & Private Project Workflow (Steps 3B.9 & 3B.9.1)

## Overview

Steps 3B.9 and 3B.9.1 connect AutoAI Edit's durable media processing core — `DurableMediaRegistryService`, `DurableArtifactPublisher`, `UnifiedVodProcessingService`, `ContinuousLiveSessionService`, and private `Project` / `EditTimeline` / `EditVersion` models — to authenticated HTTP APIs (`/api/media/*`), durable per-user job tracking (`MediaProcessingJob`), a PostgreSQL-authoritative shared-work coordinator (`SharedMediaWork`), owner-tokenized Redis leases (`SharedWorkRedisLock`), and a real BullMQ background worker (`MEDIA_PROCESS_QUEUE = 'media-process'`).

This preserves the non-negotiable AutoAI Edit product workflow:

```text
Universal Input (URL | Existing Upload | Dev/Test Controlled Fixture)
  → POST /api/media/sources/resolve          (Truthful capability & rights check)
  → POST /api/media/jobs                     (Idempotent per-user job + durable SharedMediaWork outbox)
  → BullMQ Worker ('media-process')          (Fenced Live/VOD/Upload execution + continuous lease heartbeat)
  → GET  /api/media/jobs/:jobId              (Owner-only status polling + idempotent self-heal)
  → GET  /api/media/jobs/:jobId/highlights   (Live rights re-check + 300s signed URLs)
  → POST /api/media/projects/from-source     (Private Project + EditTimeline + root EditVersion)
  → GET  /api/media/projects/:projectId/highlights
  → POST /api/media/projects/:projectId/edits (Auto / Prompt / Reference / Manual + private MP4)
  → Private MP4 Download (User independently decides where to publish)
```

---

## 1. Universal Media API Endpoints

All routes are mounted under `/api/media` behind `requireAuth` (`apps/api/src/app.ts`, `apps/api/src/routes/media.routes.ts`).

| Method & Path | Purpose | Rate Limiter |
| --- | --- | --- |
| `POST /api/media/sources/resolve` | Normalizes input, performs SSRF/URL validation, checks server-side rights/capabilities, returns truthful `capabilityStatus` | `MEDIA_RESOLVE_LIMITER` (60/min per user) |
| `POST /api/media/jobs` | Idempotently attaches a per-user `MediaProcessingJob` to durable `SharedMediaWork` and dispatches at most one BullMQ job per generation | `MEDIA_JOB_LIMITER` (30/min per user) |
| `GET /api/media/jobs/:jobId` | Returns persistent job status (`QUEUED`, `RUNNING`, `READY`, `FAILED`, `CANCELLED`) strictly to the owning user (`404` to non-owners) | Authenticated |
| `POST /api/media/jobs/:jobId/cancel` | Cancels only the authenticated user's job; stops shared work only when zero active subscribers remain; never regresses `READY → CANCELLED` | Authenticated |
| `GET /api/media/jobs/:jobId/highlights` | Re-checks live PostgreSQL rights/revocation and returns verified highlights with short-lived (`300s`) signed download URLs (supports live highlights while `RUNNING`) | Authenticated |
| `POST /api/media/projects/from-source` | Creates a private `Project`, `EditTimeline`, and root `EditVersion` seeded from the user's owned job | Authenticated |
| `GET /api/media/projects/:projectId/highlights` | Returns authorized highlights for an owned private project (`404` to non-owners; re-checks live rights) | Authenticated |
| `POST /api/media/projects/:projectId/edits` | Applies an `auto`, `prompt`, `reference`, or `manual` edit to an owned project, creating an immutable `EditVersion` and optional `PRIVATE_USER` MP4 render | Authenticated |

---

## 2. Truthful Source Capability States

`POST /api/media/sources/resolve` never fakes acquisition or bypasses platform restrictions:

- **`READY_TO_PROCESS`**: Permitted source ready for queued ingestion/analysis (existing user-owned upload, or server-registered non-production controlled test fixture with verified rights).
- **`REQUIRES_PERMISSION`**: Recognized source whose rights status in PostgreSQL is unverified, denied, or revoked.
- **`UNSUPPORTED_ACQUISITION`**: Valid, recognized external provider VOD/video URL (YouTube, Twitch, Kick VOD) with no permitted acquisition adapter enabled in this release (`POST /api/media/jobs` rejects with `422` without enqueueing).
- **`BROADCAST_UNRESOLVED`**: Live channel URL (`twitch.tv/<channel>`, etc.) with no active resolved broadcast/session ID.
- **`SOURCE_UNAVAILABLE`**: Missing owned upload project/asset, invalid/unreachable fixture, or missing resource.

---

## 3. PostgreSQL vs Redis vs BullMQ Responsibilities (Step 3B.9.1)

No single ephemeral layer is trusted as the sole concurrency authority:

| Subsystem | Authoritative Responsibility | Failure Behavior |
| --- | --- | --- |
| **PostgreSQL (`SharedMediaWork` + `MediaProcessingJob` + `SharedCacheArtifact`)** | Durable source of truth for shared-work identity (`sharedWorkKey`), monotonic `generation`, active `ownerWorkerId`, `ownerToken`, `leaseExpiresAt`, crash-safe outbox `enqueuePayload`, rights grants, artifact CAS publication, and subscriber states. | Survives Redis key eviction/restarts, API crashes, and worker `SIGKILL` crashes. |
| **Redis (`SharedWorkRedisLock`)** | Fast owner-tokenized lease (`acquire`, `renew`, `verifyOwner`, atomic Lua compare-and-delete `release`) + rate-limit/quota counters + BullMQ backing store. | If Redis deletes/loses a lock key mid-run, PostgreSQL `SharedMediaWork` STILL rejects duplicate worker claims (`ALREADY_OWNED_BY_ACTIVE_WORKER`) and the legitimate worker's next heartbeat re-establishes the Redis lock with its exact `ownerToken`. |
| **BullMQ (`MEDIA_PROCESS_QUEUE = 'media-process'`)** | Asynchronous job delivery, bounded concurrency (`2`), exponential retry backoff, `UnrecoverableError` short-circuiting, and dead-letter queue routing. | Uses generation-scoped deterministic `jobId` (`${sharedWorkKey}__g${generation}`), deduplicating concurrent dispatches on the same generation while allowing clean crash recovery or post-cancel restarts on `generation + 1`. |

---

## 4. Durable Shared-Work Lifecycle & PostgreSQL Lock Matrix

Additive PostgreSQL model `SharedMediaWork` (`apps/api/prisma/migrations/20261118121804_shared_media_work_coordination/migration.sql`) tracks one authoritative row per `sharedWorkKey`:

```text
PENDING_ENQUEUE ──(outbox dispatch)──▶ ENQUEUED ──(worker claim)──▶ RUNNING ──(commitWorkReady)──▶ READY
      │                                   │                           │   │
      │ (last subscriber cancels)         │ (last subscriber cancels) │   ├──(final failure)──▶ FAILED
      ▼                                   ▼                           │   └──(all cancelled)──▶ CANCELLED
  CANCELLED                           CANCELLED                       │
                                                                      └──(worker SIGKILL / lease expired)──▶ generation++ → PENDING_ENQUEUE
```

### Contention-Free Parallel Attach + Linearizable Terminal Completion

To support 1,000 concurrent clippers attaching without blocking worker heartbeats while preserving strict linearizability on terminal commits, `SharedWorkCoordinator` uses PostgreSQL row lock modes cleanly (zero lock upgrades → zero deadlocks):

| Operation | Row Lock on `SharedMediaWork` | Conflicts with Concurrent Clippers? | Conflicts with Worker Heartbeat (`UPDATE leaseExpiresAt`)? | Conflicts with Terminal Commit / Cancel? |
| --- | --- | --- | --- | --- |
| Steady-state subscriber attach (`ENQUEUED` / healthy `RUNNING` / `READY`) | `FOR KEY SHARE` | **No** (parallel fan-in) | **No** (`FOR NO KEY UPDATE` runs unblocked) | **Yes** (`FOR UPDATE`) |
| Worker lease heartbeat (`renewWorkLease`) | `FOR NO KEY UPDATE` | **No** | Yes (single owner) | **Yes** |
| Outbox mutation / restart (`PENDING_ENQUEUE`, `FAILED`, `CANCELLED`) | `FOR UPDATE` | Yes | Yes | Yes |
| Worker terminal commit (`commitWorkReady`, `commitWorkFailed`) | `FOR UPDATE` | **Yes** (waits for in-flight attaches) | Yes | Yes |
| User cancellation (`detachSubscriberAndEvaluateCancel`) | `FOR UPDATE` | **Yes** | Yes | Yes |

---

## 5. Owner Fencing & Atomic Redis Lock Operations

Implemented in `apps/api/src/media/api/shared-work-lock.ts` (`SharedWorkRedisLock`) and `apps/api/src/media/api/shared-work-coordinator.ts`:

- **Unique Per-Attempt Tokens:** Every worker claim generates `ownerToken = "${workerId}:g${generation}:${randomUUID()}"`.
- **Atomic Lua Operations:**
  - `acquire`: `SET key token PX ttl NX` (idempotent re-acquire for matching token).
  - `renew`: extends TTL via `PEXPIRE` **only if `GET key == token`**.
  - `verifyOwner`: returns exact owner match + remaining `PTTL`.
  - `release`: **atomic compare-and-delete** (`if GET key == token then DEL key else return 0`). An old/stalled worker waking up after another worker acquired the lock receives `0` and **never deletes the newer worker's lock**.
- **PostgreSQL Generation Fencing:** Every progress update (`publishProgressFenced`), live-highlight update, terminal commit (`commitWorkReady`, `commitWorkFailed`), and lease renewal (`renewWorkLease`) validates `(sharedWorkKey, generation, ownerToken, status = 'RUNNING')` in PostgreSQL. Any stale generation or wrong `ownerToken` is rejected immediately with `LEASE_EXPIRED`.

---

## 6. Crash-Safe Enqueue Outbox & Worker Recovery

### API Crash / Transient Enqueue Failure Recovery

1. `submitMediaJob` commits BOTH the user's `MediaProcessingJob` row AND `SharedMediaWork` (`status = 'PENDING_ENQUEUE'`, `enqueuePayload`, `nextEnqueueAt = now + 5s`) in ONE PostgreSQL transaction before touching BullMQ.
2. Immediately after commit, `dispatchPendingEnqueue` enqueues `${sharedWorkKey}__g${generation}` onto BullMQ and marks `SharedMediaWork` `PENDING_ENQUEUE → ENQUEUED`.
3. If the API process crashes between DB commit and BullMQ `queue.add`, or if BullMQ/Redis fails transiently:
   - The job stays durably in PostgreSQL `PENDING_ENQUEUE` with exponential backoff (`nextEnqueueAt`).
   - Bounded `reconcileStrandedWork(batchSize)` (run periodically by workers and on demand) re-dispatches due outbox rows cleanly without creating duplicate active workers, failing cleanly to `FAILED` only after `maxEnqueueAttempts` (default `5`).

### Worker OS Crash (`SIGKILL` / OOM) Recovery

1. Every active worker renews its PostgreSQL `leaseExpiresAt` and Redis lock every `leaseMs / 3` (default 10s on a 30s lease).
2. If a worker OS process dies abruptly without running `finally`, its durable PostgreSQL `leaseExpiresAt` expires.
3. `reconcileStrandedWork` detects `status = 'RUNNING' AND leaseExpiresAt <= now` under `FOR UPDATE`, increments `generation = generation + 1`, resets active subscribers to `QUEUED`, and enqueues `${sharedWorkKey}__g${nextGen}` for another healthy worker OS process to claim and complete (bounded by `maxRecoveryGenerations = 5`).

---

## 7. Subscriber Terminal-State Correctness

Step 3B.9.1 eliminates Step 3B.9's double `updateMany` sweep completely:

- **Zero Late-Subscriber Races:** Because steady-state attach takes `FOR KEY SHARE` and `commitWorkReady` takes `FOR UPDATE` on the exact same `SharedMediaWork` row, PostgreSQL strictly serializes every subscriber either **before** `commitWorkReady` (so `commitWorkReady`'s single `UPDATE` sees and marks it `READY`) or **after** `commitWorkReady` (so the attach transaction reads `work.status === 'READY'` and inserts the subscriber row directly in `READY` state with HTTP `200`).
- **Monotonic State Transitions:**
  - `CANCELLED → READY` is impossible (`commitWorkReady` only updates `status IN ('QUEUED', 'RUNNING')`).
  - `READY → RUNNING` is impossible (`claimWorkExecution` and `publishProgressFenced` never touch `READY` rows).
  - `READY → CANCELLED` is impossible (`detachSubscriberAndEvaluateCancel` returns `{ status: 'READY', alreadyCompleted: true }` without mutating completed jobs).
- **Idempotent Read-Side Sync:** `getUserJobStatus` additionally calls `syncSubscriberFromWorkIfNeeded` as belt-and-suspenders without ever touching `CANCELLED` rows.

---

## 8. Cancellation Semantics & Race Handling

`cancelUserJob` executes inside `FOR UPDATE` on `SharedMediaWork`:

- **Detaches Only Caller:** While any other `QUEUED`/`RUNNING` subscriber remains, `sharedWorkStillActive = true` and shared processing continues untouched.
- **Cancel Before Enqueue / Before Start:** Marks `PENDING_ENQUEUE`/`ENQUEUED` `SharedMediaWork` as `CANCELLED`; reconciler and worker skip execution (`NO_ACTIVE_SUBSCRIBERS`).
- **Cancel During Processing:** Propagates `AbortSignal` (`REQUEST_CANCELLED`) scoped strictly to `(sharedWorkKey, generation)` (`${sharedWorkKey}::g${generation}`) into FFmpeg and `ContinuousLiveSessionService`!
- **Cancel During Retry Backoff:** BullMQ's next retry attempt calls `claimWorkExecution`, sees `0` active subscribers, and exits immediately without re-running work.
- **Cancel Racing with New Subscriber:** When the worker handles `REQUEST_CANCELLED` inside `commitWorkCancelledIfNoSubscribers` (`FOR UPDATE`), it re-checks active subscribers; if a brand-new clipper arrived concurrently, it bumps `generation + 1` and immediately dispatches the fresh generation so the new clipper is never accidentally cancelled or stranded!
- **New Subscriber After All Prior Users Cancelled:** Bumps `generation` (`CANCELLED → PENDING_ENQUEUE` at `generation + 1`) and dispatches `${sharedWorkKey}__g${generation + 1}` cleanly.

---

## 9. Long-Running Livestream & VOD Handling

- **No Fixed 300s Lock Limit:** Continuous dual lease renewal (`leaseMs / 3`) keeps multi-hour livestreams and long VODs alive indefinitely while healthy.
- **Session vs. Subscriber Separation:** One `SharedMediaWork` row represents one active broadcast/VOD processing session; 1,000 clippers create 1,000 independent `MediaProcessingJob` rows attached to that single `SharedMediaWork` row, and later create 1,000 isolated private `Project` / `EditTimeline` / `EditVersion` workflows.
- **Live Streaming Highlights:** While a livestream `SharedMediaWork` is `RUNNING`, each extracted highlight is published via `publishProgressFenced`, allowing clippers polling `GET /api/media/jobs/:jobId/highlights` to download verified highlights before the stream ends.

---

## 10. Measured Deduplication & Hardening Results (Step 3B.9.1)

Measured against real local PostgreSQL, Redis, MinIO, BullMQ, and FFmpeg (`apps/api/tests/integration/shared-job-hardening.test.ts`):

- **1,000 Concurrent Clippers across 2 Independent API Instances (`apiA` + `apiB`, 1.5s short lease):**
  - Total elapsed: **13.79s**
  - BullMQ jobs enqueued: **1**
  - Worker ownership claims: **1**
  - FFmpeg VOD source imports: **1**
  - Highlight analysis passes: **1**
  - Base clip renders: **1**
  - Subscribers reaching `READY`: **1,000 / 1,000** (0 stranded)
  - Heap delta: **+18.3 MB**
- **20 Concurrent Live Clippers across 2 API Instances:** **1** `ContinuousLiveSessionService` owner, **1** BullMQ job, **20 / 20** `READY`.
- **Two Separate Worker OS Processes + Real `SIGKILL` Crash:** Worker PID #1 claimed `generation 1` and was abruptly terminated via `SIGKILL`; after lease expiry + bounded reconciliation, Worker PID #2 claimed `generation 2` and produced a verified MP4 passing `ffprobe`.

---

## 11. Security, Rights, Quotas & Production Safety Gate

- Authenticated `userId` strictly from JWT middleware (`req.user.sub`); `.strict()` Zod contracts reject forged `rightsStatus`, `canonicalSourceId`, `ownerUserId`, `storageKey`, `workerId`, and path-traversal `fixtureKey`.
- Live PostgreSQL rights & revocation re-checked before worker execution and on every highlight/project download; short-lived (`300s`) signed download URLs with zero raw storage key exposure.
- Rate limits (`MEDIA_RESOLVE_LIMITER`, `MEDIA_JOB_LIMITER`), per-user active-job/daily quotas, and SSRF protection remain enforced.
- Controlled test fixtures (`apps/api/src/media/api/controlled-fixture-registry.ts`) remain strictly disabled whenever `NODE_ENV === 'production'`.

---

## 12. Remaining Limitations & Explicitly Deferred Items

- **Reconciliation Latency on Abrupt Worker `SIGKILL`:** Recovery occurs after `leaseExpiresAt` elapses plus the worker reconciliation interval (default 30s lease + 15s reconciler tick; configurable per deployment).
- **Single-Region PostgreSQL Bottleneck Beyond Beta Scale:** Suitable and fast for our target initial 100 free beta users and tested up to 1,000 concurrent clippers; extreme >10,000/s fan-in beyond beta would add read-replica status polling or batched subscriber fan-out.
- **Cross-Process Immediate Cancel Latency:** Local in-process `AbortController` cancels same-process workers immediately; remote worker OS processes abort on their next heartbeat tick (`leaseMs / 3`, default ~10s, or ~500ms on short leases).
- **Explicitly Deferred (Not Part of Step 3B.9.1):** Third-party YouTube/Twitch/Kick permitted acquisition integrations, frontend UI wiring for URL input/live highlight feeds, production migrations/deployments, billing, social-media publishing, and GPU/Kubernetes infrastructure.
