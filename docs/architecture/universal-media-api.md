# Universal Media API, Authenticated Jobs & Private Project Workflow (Step 3B.9)

## Overview

Step 3B.9 connects AutoAI Edit's durable media processing core — `DurableMediaRegistryService`, `DurableArtifactPublisher`, `UnifiedVodProcessingService`, `ContinuousLiveSessionService`, and private `Project` / `EditTimeline` / `EditVersion` models — to authenticated HTTP APIs (`/api/media/*`), persistent per-user job tracking (`MediaProcessingJob`), and a real BullMQ background worker (`MEDIA_PROCESS_QUEUE = 'media-process'`).

This preserves the non-negotiable AutoAI Edit product workflow:

```text
Universal Input (URL | Existing Upload | Dev/Test Controlled Fixture)
  → POST /api/media/sources/resolve          (Truthful capability & rights check)
  → POST /api/media/jobs                     (Idempotent per-user job + shared-work dedup)
  → BullMQ Worker ('media-process')          (Live / VOD / Upload execution + PostgreSQL CAS)
  → GET  /api/media/jobs/:jobId              (Owner-only status polling)
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
| `POST /api/media/jobs` | Idempotently creates a per-user `MediaProcessingJob`, attaches to shared work, and enqueues at most one BullMQ job per `sharedWorkKey` | `MEDIA_JOB_LIMITER` (30/min per user) |
| `GET /api/media/jobs/:jobId` | Returns persistent job status (`QUEUED`, `RUNNING`, `READY`, `FAILED`, `CANCELLED`) strictly to the owning user (`404` to non-owners) | Authenticated |
| `POST /api/media/jobs/:jobId/cancel` | Cancels only the authenticated user's job; stops shared work only when zero active subscribers remain | Authenticated |
| `GET /api/media/jobs/:jobId/highlights` | Re-checks live PostgreSQL rights/revocation and returns verified highlights with short-lived (`300s`) signed download URLs (supports live highlights while `RUNNING`) | Authenticated |
| `POST /api/media/projects/from-source` | Creates a private `Project`, `EditTimeline`, and root `EditVersion` seeded from the user's owned job | Authenticated |
| `GET /api/media/projects/:projectId/highlights` | Returns authorized highlights for an owned private project (`404` to non-owners; re-checks live rights) | Authenticated |
| `POST /api/media/projects/:projectId/edits` | Applies an `auto`, `prompt`, `reference`, or `manual` edit to an owned project, creating an immutable `EditVersion` and optional `PRIVATE_USER` MP4 render | Authenticated |

---

## 2. Truthful Source Capability States

`POST /api/media/sources/resolve` never fakes acquisition or bypasses platform restrictions. Every response returns an explicit `capabilityStatus`:

- **`READY_TO_PROCESS`**: Permitted source ready for queued ingestion/analysis (an existing user-owned upload, or a server-registered non-production controlled test fixture with verified rights).
- **`REQUIRES_PERMISSION`**: Recognized source whose rights status in PostgreSQL is unverified, denied, or revoked.
- **`UNSUPPORTED_ACQUISITION`**: Valid, recognized external provider VOD/video URL (e.g., YouTube VOD, Twitch VOD, Kick VOD) where AutoAI Edit has no permitted live acquisition adapter enabled in this release. `POST /api/media/jobs` rejects submission with `422 UNSUPPORTED_ACQUISITION` without enqueueing any worker job.
- **`BROADCAST_UNRESOLVED`**: Live channel URL (e.g., `https://www.twitch.tv/shroud`, YouTube live handle, Kick channel) that has no active resolved broadcast/session ID. Must never be conflated into one cache key across different broadcasts.
- **`SOURCE_UNAVAILABLE`**: Missing owned upload project/asset, invalid/unreachable fixture, or missing resource.

---

## 3. Authenticated Request Validation & Server-Trusted Boundaries

All request payloads are validated by strict `.strict()` Zod contracts in `packages/contracts/src/media-api.ts`:

- **Authenticated User Identity:** `userId` is always extracted from the verified JWT (`req.user.sub`).
- **Forged Fields Rejected:** Strict schemas reject unknown or client-forged security fields (`rightsStatus`, `canonicalSourceId`, `ownerUserId`, `storageKey`, `objectKey`, `workerId`, `sharedWorkKey`) with `400 VALIDATION_ERROR`.
- **No Raw Storage Keys in API Responses:** Responses never expose `s3Key`, `objectKey`, `publishedObjectKey`, bucket names, or filesystem paths — only opaque `highlightId`, `cacheKey`, verified media metadata, and short-lived (`300s`) signed `downloadUrl`s.
- **No Cross-User Enumeration:** Non-owners requesting `GET /api/media/jobs/:jobId`, `POST /api/media/jobs/:jobId/cancel`, `GET /api/media/jobs/:jobId/highlights`, `GET /api/media/projects/:projectId/highlights`, or `POST /api/media/projects/:projectId/edits` receive `404 SOURCE_UNAVAILABLE`.

---

## 4. Job Persistence, Idempotency & Shared-Work Deduplication

### PostgreSQL Model (`MediaProcessingJob`)

Added via additive migration `apps/api/prisma/migrations/20261118110531_media_processing_jobs/migration.sql`:

- Per-user ownership (`userId`) linked to `MediaSource` (`mediaSourceId`) and optional `Project` (`projectId`).
- Status lifecycle: `QUEUED | RUNNING | READY | FAILED | CANCELLED`, plus `stage`, `progressPercent`, `sharedWorkKey`, `queueJobId`, `errorCode`, `errorMessage`, `resultSummary`, and lifecycle timestamps.
- Database-enforced per-user idempotency via `@@unique([userId, idempotencyKey])`.

### 1,000 Clippers → 1 Shared Background Job

1. **Per-User Idempotency:** If the same user retries `POST /api/media/jobs` with the same `idempotencyKey`, the existing `MediaProcessingJob` row is returned (`200 OK`) without double-counting quotas or double-enqueueing.
2. **Instant Cache Reuse (Late Joiners):** If a `READY` job already exists for the same `sharedWorkKey` (e.g., all shared highlights are already published in MinIO + PostgreSQL CAS), the new user's `MediaProcessingJob` is created immediately in `READY` state (`reusedSharedWork: true`) with zero worker execution.
3. **Concurrent Fan-In Deduplication:** For concurrent submissions sharing the same `sharedWorkKey`, `UniversalMediaApiService` atomically acquires a Redis `SET NX` enqueue lock (`${keyPrefix}enq:${sharedWorkKey}`) and enqueues to BullMQ with a deterministic `jobId = sharedWorkKey`. If 1,000 authorized clippers submit jobs for the same broadcast/VOD simultaneously:
   - 1,000 isolated `MediaProcessingJob` rows are persisted (one per user).
   - Strictly **1** BullMQ job is enqueued and processed.
   - Strictly **1** FFmpeg acquisition/analysis/base-clip render runs.
   - All 1,000 user rows transition together (`QUEUED → RUNNING → READY`) and serve verified highlights from the single shared cache.

---

## 5. Multi-Subscriber Cancellation Semantics

`POST /api/media/jobs/:jobId/cancel`:

1. Verifies the job belongs to `req.user.sub` (`404` otherwise).
2. Marks ONLY that user's `MediaProcessingJob` as `CANCELLED`.
3. Counts remaining `QUEUED` or `RUNNING` subscribers for the same `sharedWorkKey`:
   - **Remaining subscribers > 0:** Returns `{ status: 'CANCELLED', detachedFromSharedWork: true, sharedWorkStillActive: true }`. Shared background work continues undisturbed for remaining clippers.
   - **Remaining subscribers === 0:** Sets a Redis cancellation marker (`${keyPrefix}cancel:${sharedWorkKey}`), clears the enqueue lock, and triggers the local worker `AbortController` if running in-process. The BullMQ worker polls subscriber count and aborts FFmpeg/storage work promptly to reclaim CPU and disk.

---

## 6. BullMQ Queue & Worker Lifecycle

- **Queue:** `MEDIA_PROCESS_QUEUE = 'media-process'` (`apps/api/src/queue/queues.ts`), with deterministic `jobId`, bounded retries (`attempts: 3`), and exponential backoff (`2000ms`).
- **Worker:** `createMediaWorker()` (`apps/api/src/queue/workers/media.worker.ts`), started in `apps/api/src/worker.ts` alongside `analysisWorker`, `renderWorker`, and `n8nWorker` with graceful `SIGTERM`/`SIGINT` shutdown.
- **Concurrency:** Bounded (`concurrency: 2` by default) to protect CPU and memory under load.
- **Execution-Time Rights Check:** Before starting media work, the worker re-validates server-authoritative rights in PostgreSQL (`resolveServerTrustedAuth`).
- **Retry & Dead-Letter Policy:**
  - Transient errors (Redis hiccups, MinIO network errors, worker crashes) retry up to `attempts` with exponential backoff, updating subscribers to `FAILED` and routing to `deadLetterQueue` only on final exhaustion.
  - Non-retryable errors (`ACCESS_DENIED`, `RIGHTS_UNVERIFIED`, `DRM_RESTRICTED`, `UNSUPPORTED_ACQUISITION`, `SSRF_BLOCKED`, `INVALID_URL`, `QUOTA_EXCEEDED`, `REQUEST_CANCELLED`) immediately throw BullMQ `UnrecoverableError` without burning retries.

---

## 7. Unified Live, VOD & Upload Execution Paths

The single `media-process` worker cleanly routes three permitted execution paths without duplicating editing workflows:

1. **Controlled Live Session (`live`)**: Streams real-time segments via `ContinuousLiveSessionService`, publishing each verified highlight to `resultSummary` as soon as it becomes ready so clippers polling `GET /api/media/jobs/:jobId/highlights` can download highlights while the stream is still `RUNNING`.
2. **Controlled VOD (`vod`)**: Executes `UnifiedVodProcessingService` (`acquireOrReuseVodSource → analyzeOrReuseVodHighlights → generateOrReuseVodBaseClip`) backed by PostgreSQL CAS (`DurableArtifactPublisher`) and MinIO immutable objects.
3. **Existing Owned Upload (`uploaded`)**: Downloads the authenticated user's uploaded `MediaAsset`, runs private `PRIVATE_USER` highlight detection + FFmpeg base clip generation, and publishes strictly under that user's private cache namespace without exposing anything to other users.

---

## 8. Private Projects, Timelines & Custom Renders

- `POST /api/media/projects/from-source` creates a completely isolated `Project`, `EditTimeline`, and root `EditVersion` linked to the shared `MediaSource`. Two clippers working from the same VOD get distinct `projectId`, `timelineId`, and `rootVersionId` records.
- `POST /api/media/projects/:projectId/edits` applies `auto`, `prompt`, `reference`, or `manual` edits, creating immutable child `EditVersion` snapshots and optional `PRIVATE_USER` MP4 renders isolated by `requesterUserId` and `customEditHash`.
- Cross-user access to another user's project, highlights, or private renders is denied (`404` at API boundary, `ACCESS_DENIED` at storage/cache boundary).

---

## 9. Live Revocation & Signed Download URLs

Every call to `GET /api/media/jobs/:jobId/highlights` and `GET /api/media/projects/:projectId/highlights`:

1. Re-queries PostgreSQL `DurableMediaRegistryService.resolveServerTrustedAuth()` live — never relying on stale cached authorization decisions.
2. Immediately rejects revoked sources with `403 ACCESS_DENIED` (stopping new download URL issuance immediately).
3. Verifies object existence/size/ETag integrity in MinIO before minting short-lived (`300s` default) signed URLs.

---

## 10. Rate Limits, Quotas & SSRF Protection

- **Route Rate Limits:** `MEDIA_RESOLVE_LIMITER` (60 requests/min/user) and `MEDIA_JOB_LIMITER` (30 requests/min/user), returning `429`.
- **Job Quotas:** Configurable `maxActiveJobsPerUser` (default 5), `maxDailyJobSubmissionsPerUser` (default 50, backed by Redis `INCR` with 24h TTL), and `maxClipsPerUserPerDay` (default 20 for new uncached renders).
- **SSRF & URL Validation:** `resolveMediaSourceFromUrl()` rejects non-HTTP(S) schemes (`file://`, `ftp://`, `javascript:`), loopback (`127.0.0.1`, `localhost`, `::1`), cloud metadata IPs (`169.254.169.254`), and private RFC1918 ranges with `403 SSRF_BLOCKED` / `400 INVALID_URL`.

---

## 11. Production Safety Gate for Controlled Test Fixtures

`apps/api/src/media/api/controlled-fixture-registry.ts`:

- `areControlledFixturesEnabled()` returns **`false` unconditionally whenever `process.env.NODE_ENV === 'production'`**, even if `ALLOW_CONTROLLED_MEDIA_FIXTURES=true` is accidentally configured.
- Client requests may only reference an opaque alphanumeric `fixtureKey` (`^[a-zA-Z0-9_-]{3,80}$`) registered server-side in test/dev code — arbitrary client filesystem paths or path-traversal strings (`../`) are rejected at Zod validation.

---

## 12. Explicitly Deferred Items

The following remain intentionally out of scope for Step 3B.9:

- Arbitrary third-party scraping or unauthorized YouTube/Twitch/Kick downloaders or DRM/paywall bypasses.
- Official third-party provider ingestion integrations/agreements (plug into the same `MediaSource` / `UniversalMediaApiService` capability interface when available).
- Frontend web UI redesign for URL pasting, live highlight feeds, and job progress polling (existing upload workflow remains 100% intact).
- Production database migrations, production deployments, billing, social-media auto-publishing, and Kubernetes/GPU autoscaling.
