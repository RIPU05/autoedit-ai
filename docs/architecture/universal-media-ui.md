# Universal Media Input, Job Progress & Highlight Workspace UI (Steps 3C.1 & 3C.1.1)

## Overview

Steps 3C.1 and 3C.1.1 connect the Universal Media API (`/api/media/*`) directly to the Next.js frontend (`apps/web`) with production-grade source preview verification, durable asynchronous background private rendering, and resilient workspace state management, giving independent clippers one cohesive authenticated workspace to:

1. Paste a public YouTube, Twitch, or Kick live/VOD link — or pick an existing uploaded video, or upload a new video — with **no mandatory streamer login**.
2. Receive truthful backend capability feedback (never faking acquisition for unsupported external links).
3. Submit idempotent highlight-detection jobs backed by PostgreSQL `SharedMediaWork`, `MediaProcessingJob`, and BullMQ (`media-process`).
4. Monitor real backend progress (`QUEUED`, `RUNNING`, `READY`, `FAILED`, `CANCELLED`), resume seamlessly across browser refreshes and tabs, and cancel safely without disrupting other clippers.
5. Preview verified full source media (`SOURCE_MEDIA` / `PRIVATE_UPLOAD`) distinctly from detected highlight clips (`BASE_CLIP`), edit privately across Auto / Prompt / Reference / Manual modes, enqueue durable background private MP4 renders (`PrivateRenderJob` + BullMQ `private-render`), and download verified private MP4s.

AutoAI Edit remains strictly a clipping and editing tool — **no social-media publishing buttons, no streamer approval flows, no billing checkout, and no automatic channel connections**.

---

## 1. Screens & User Flow

| Route | Component(s) | Purpose |
| --- | --- | --- |
| `/dashboard` | `Uploader`, `UniversalMediaWorkspace`, Recent Projects, AI Activity | Main authenticated entry point preserving existing direct upload → classic AI analysis workflow while embedding Universal Media Input right alongside it. |
| `/media` | `UniversalMediaWorkspace`, `Uploader` | Dedicated mobile-responsive Universal Media Hub supporting `?job=<jobId>` deep-links and unauthenticated redirect to `/login?next=/media`. |
| `/projects/[id]` | `SourceHighlightsEditorPanel`, `TimelineEditor`, `VersionSidebar`, `CompareView` | Private editing workspace supporting both classic direct-upload analysis projects and media-source projects created via `POST /api/media/projects/from-source`. |

```text
/dashboard or /media (Authenticated)
  ├─ Tab 1: Paste YouTube / Twitch / Kick URL → POST /api/media/sources/resolve
  │    └─ Honest capability card (UNSUPPORTED_ACQUISITION / BROADCAST_UNRESOLVED / REQUIRES_PERMISSION)
  │       → Friendly guidance + 1-click switch to Upload or Existing Upload (zero fake processing!)
  ├─ Tab 2: Existing Uploaded Asset → POST /api/media/sources/resolve (READY_TO_PROCESS)
  │    └─ "Detect Highlights" → POST /api/media/jobs (stable per-submission idempotencyKey)
  │       → Bounded polling GET /api/media/jobs/:jobId (resumes on browser refresh!)
  │       → Optional "Cancel Job" → POST /api/media/jobs/:jobId/cancel
  │       → READY → GET /api/media/jobs/:jobId/highlights
  │       → Preview <video> (auto-refresh on expired URL) + Private MP4 download
  │       → "Edit in Private Project" → POST /api/media/projects/from-source
  │            → /projects/:projectId?highlight=<id>
  │                 ├─ SourceHighlightsEditorPanel (Auto / Prompt / Reference / Manual + Private MP4 Render)
  │                 └─ Existing TimelineEditor + VersionSidebar + CompareView
  └─ Direct Upload (Uploader) → Existing Register → Upload → Analyze → Prompt Edit → Render → Download (100% preserved)
```

---

## 2. API Integration (`apps/web/src/lib/api.ts`)

All Universal Media calls reuse the existing authenticated `api()` client (`credentials: 'include'`, `15s` timeout, structured `ApiError`) and `@autoedit/contracts` TypeScript types:

- `media.resolveSource(input)` → `POST /api/media/sources/resolve`
- `media.submitJob(req)` → `POST /api/media/jobs`
- `media.getJobStatus(jobId)` → `GET /api/media/jobs/:jobId`
- `media.cancelJob(jobId)` → `POST /api/media/jobs/:jobId/cancel`
- `media.getJobHighlights(jobId)` → `GET /api/media/jobs/:jobId/highlights`
- `media.createProjectFromSource(req)` → `POST /api/media/projects/from-source`
- `media.getProjectHighlights(projectId)` → `GET /api/media/projects/:projectId/highlights`
- `media.applyProjectEdit(projectId, req)` → `POST /api/media/projects/:projectId/edits` (fast non-blocking save; returns HTTP `202` with `renderJob` when `renderOutput: true`, HTTP `200` on idempotent replay, HTTP `201` on save-only; no 90-second HTTP timeout)
- `media.enqueueProjectRender(projectId, req)` → `POST /api/media/projects/:projectId/renders`
- `media.listProjectRenders(projectId)` → `GET /api/media/projects/:projectId/renders`
- `media.getPrivateRenderStatus(projectId, renderJobId)` → `GET /api/media/projects/:projectId/renders/:renderJobId`
- `media.cancelPrivateRender(projectId, renderJobId)` → `POST /api/media/projects/:projectId/renders/:renderJobId/cancel`

### Verified Source Preview (`GET /api/projects/:id/source-url`) & Full Source vs. Highlight Distinction

Implemented in `apps/api/src/media/api/source-preview.service.ts` and `apps/api/src/routes/projects.routes.ts`:

- **Private Ownership & Zero Client-Key Trust:** Verifies `project.userId === req.user.sub` (returning `404` to non-owners) and completely ignores any client-supplied storage keys.
- **Full Source (`SOURCE_MEDIA`) vs. Highlight Clip (`BASE_CLIP`):**
  - `GET /api/projects/:id/source-url` resolves **strictly** `SOURCE_MEDIA` via `DurableArtifactPublisher.getAuthorizedPublishedArtifact` matching exact `project.mediaSource.sourceRevision`, `publishedGeneration >= 1`, `PUBLISHED`/`REPAIRING` state, non-expired `expiresAt`, live PostgreSQL rights (`DurableMediaRegistryService.resolveServerTrustedAuth`), and MinIO HEAD size/ETag integrity.
  - **Never silently substitutes a `BASE_CLIP`** when full `SOURCE_MEDIA` is absent, expired, or unretained — returns `404` (`SOURCE_UNAVAILABLE`) with a truthful unavailable-source message while highlight clip previews remain independently accessible via `GET /api/media/projects/:projectId/highlights`.
  - **Private Upload Projects (`sourceAsset`):** Preserves direct-upload preview behavior while verifying object existence and positive matching size in MinIO before issuing a short-lived (`300s`) signed URL. `GET /api/projects/:id` excludes `sourceAsset.s3Key` and `bucket` from JSON responses.
  - **Sanitized Error Codes:** Revoked/denied rights → `403`; corrupt/mismatched MinIO object → `502` (`ARTIFACT_CORRUPT`); missing/expired/unretained source → `404` (`SOURCE_UNAVAILABLE`). Raw object keys are never leaked in responses or errors.
  - **Frontend Player (`TimelineEditor` + `VideoPreview`):** Displays explicit unavailable/denied messaging instead of stalling on `"Loading preview…"`, performs automatic one-shot signed-URL renewal on `<video onError>`, and provides a manual `"Refresh preview link"` button.

---

## 2A. Durable Background Private Rendering & Lifecycle (Step 3C.1.1)

Implemented in `apps/api/src/media/api/private-render.service.ts`, `apps/api/src/queue/workers/private-render.worker.ts`, Prisma model `PrivateRenderJob`, and BullMQ queue `private-render`:

```text
POST /api/media/projects/:projectId/edits (renderOutput: true, idempotencyKey)
  → Verify owner + live PostgreSQL rights + free-beta quotas & backpressure
  → Single PostgreSQL tx: append ONE immutable EditVersion + create ONE PrivateRenderJob (QUEUED)
  → Enqueue generation-scoped BullMQ job on `private-render` (HTTP 202 returned immediately)
  → Private Render Worker (bounded CPU concurrency = PRIVATE_RENDER_CONCURRENCY, default 2)
      ├─ Atomic PostgreSQL FOR UPDATE claim + continuous lease heartbeat (leaseMs / 3)
      ├─ Re-verify live rights + fetch verified SOURCE_MEDIA (or private upload) to isolated scratch dir
      ├─ Run real FFmpeg trim/effects with AbortSignal (SIGKILL immediately on cancel or lease loss!)
      ├─ Independent ffprobe + SHA-256 validation (rejects empty/incomplete/corrupt MP4s)
      ├─ Upload immutable MP4 to owner-scoped prefix: private/users/<userId>/renders/...
      ├─ Re-verify live rights + fenced PostgreSQL READY commit (discard object if cancelled/fenced)
      └─ Always remove scratch dir in finally
  → Frontend polls GET /api/media/projects/:projectId/renders/:renderJobId (bounded backoff)
      ├─ Re-verifies live rights + retention expiry + MinIO HEAD size/ETag
      └─ Mints fresh 300s signed download URL dynamically (NEVER stored in DB or browser storage)
```

- **Version Creation vs. Render Lifecycle:** Timeline `EditVersion` records are committed immediately and immutably on save (refreshed in `VersionSidebar` right away). Rendering is decoupled into `PrivateRenderJob` (`QUEUED → RUNNING → READY | FAILED | CANCELLED`). Retrying a failed/cancelled render via `POST /api/media/projects/:projectId/renders` reuses the existing `editVersionId` without creating duplicate timeline versions.
- **Idempotency & Double-Click Safety:** `(userId, idempotencyKey)` unique constraint in PostgreSQL plus frontend `submitLockRef` ensures rapid double-clicks or retries create strictly ONE `EditVersion`, ONE `PrivateRenderJob`, and ONE BullMQ enqueue.
- **Crash Recovery & Fencing:** Periodic bounded `reconcileStrandedRenders` reclaims expired `RUNNING` leases by bumping `generation` and re-enqueueing up to `maxAttempts` (default 3), while stale workers are fenced out by `(id, generation, ownerToken)` CAS checks.
- **Job Persistence, Refresh & Multi-Tab Sync:**
  - `SourceHighlightsEditorPanel` recovers in-progress and completed private renders across browser refreshes via `GET /api/media/projects/:projectId/renders` + opaque `sessionStorage` `{ projectId, renderJobId }` ref (zero signed URLs stored).
  - `UniversalMediaWorkspace` guards all async poll/highlight calls with `activeJobIdRef` + request epoch counters so switching jobs never applies stale responses, syncs status across tabs viewing the same `jobId` via opaque `BroadcastChannel` (`{ jobId, status, ts }` — never clobbering tabs viewing other jobs), clears highlights immediately on `403` rights revocation, auto-refreshes stale links on tab focus/download click, and reconnects automatically on `online`/`visibilitychange`.

---

## 2B. User Privacy, Resource Controls & Free-Beta Quotas

- **Strict Private Isolation:** Shared `SOURCE_MEDIA` and `BASE_CLIP` artifacts are reused only when server-verified `SHARED_PERMITTED` rights allow; every user's `Project`, `EditTimeline`, `EditVersion`, `PrivateRenderJob`, and rendered MP4 (`private/users/<userId>/...`) remain 100% isolated (`404` to non-owners). Post-render source rights revocation immediately blocks further downloads (`403`).
- **CPU-First Free-Beta Controls (100 Free Beta Users):**
  - Bounded concurrent private FFmpeg renders: `PRIVATE_RENDER_CONCURRENCY=2` (isolated from shared `media-process` ingestion workers).
  - Per-user fairness & quotas: max **2** active private renders per user (`429`), max **20** private renders per user per day (`429`), max **5** active / **50** daily media ingestion jobs (`429`).
  - Output bounds: max **180s** clip duration per private render (`400`), resolution ceiling **1280×720** / **30 fps**.
  - Global backpressure: max **50** queued global private renders (`503` retryable).
  - Retention & scratch cleanup: per-job scratch directories removed unconditionally in `finally`; private render outputs expire after **24 hours** (`outputExpiresAt`), and signed URLs expire after **300 seconds** (5 minutes).

---

## 3. Job Polling, Idempotency & Refresh Behavior

Implemented in `apps/web/src/lib/media-workspace.ts` and `apps/web/src/components/UniversalMediaWorkspace.tsx`:

- **Double-Submit Protection:** Generating a stable per-submission `idempotencyKey` (`ui_<source>_<uuid>`) combined with an immediate synchronous `submitLockRef` ensures rapid double-clicks or retries map to strictly ONE `MediaProcessingJob` row.
- **Bounded Polling & Backoff (`computeNextPollDelayMs`):**
  - Polls every `1.2s` (first 3 ticks) → `2.0s` (ticks 4–10) → `3.0s` thereafter while `QUEUED` or `RUNNING`.
  - On temporary network/5xx errors, shows a non-destructive reconnecting message and backs off exponentially (`2s → 4s → 8s → 15s cap`).
  - Stops polling immediately (`null`) upon reaching terminal status (`READY`, `FAILED`, `CANCELLED`).
- **Browser Refresh Resume:** Stores ONLY an opaque `{ jobId, sourceLabel, savedAt }` pointer in `sessionStorage` and syncs `?job=<jobId>` in the URL. On reload, the component calls authenticated `GET /api/media/jobs/:jobId` to resume polling or re-fetch highlights. If another user signs in or the job returns `404`, the stale local pointer is cleared immediately.
- **Accessible Progress UI:** Displays real backend `stage` and `progressPercent` inside `role="progressbar"` (`aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow`, `aria-live="polite"`) — never arbitrary fake progress animations.
- **Cancellation:** Clicking **Cancel Job** calls `POST /api/media/jobs/:jobId/cancel` and reports whether shared processing for other clippers remained active (`sharedWorkStillActive`).

---

## 4. Supported vs. Unsupported Source Messages & Free Beta Limits

- **Recognized Unsupported YouTube / Twitch / Kick VOD URLs (`UNSUPPORTED_ACQUISITION`):**
  - Displays: *"This source is recognized, but automatic processing isn't available for it yet. You can upload a video you are authorized to use."*
  - Shows zero fake processing buttons and offers 1-click navigation to upload or choose an existing upload.
- **Unresolved Live Channel URLs (`BROADCAST_UNRESOLVED`):**
  - Displays honest guidance that automatic processing for live channel URLs isn't available yet and invites uploading an authorized recording.
- **Free Beta Limits Strip (no billing/checkout, no unlimited claims):**
  - Up to 60 min duration · Max 500 MB highlight scan (5 GB direct upload) · 5 active / 50 daily jobs · 5-min private download links.

---

## 5. Highlight Selection, Private Project Handoff & Existing Editor

- **Highlight Cards:** Display candidate time range (`0:10 – 0:22`), composite score, contributing signal badges (`AUDIO_ENERGY`, etc.), playable `<video>` preview, private **Download MP4** link, and **Edit in Private Project** CTA.
- **Expired Signed URL Recovery:** Signed URLs (`300s` TTL) live strictly in React component memory and are NEVER written to `localStorage` or `sessionStorage`. Both `<video onError>` and an explicit **Refresh links** button re-query the authenticated highlights endpoint for fresh signed URLs.
- **Empty Highlights Handling:** If a job finishes `READY` with `0` highlights, shows a clear empty state while still letting the user click **Open Private Project** to edit manually.
- **Private Editor Handoff (`/projects/[id]`):**
  - `SourceHighlightsEditorPanel` loads `GET /api/media/projects/:projectId/highlights` and exposes all 4 editing modes (**Auto**, **Prompt**, **Reference**, **Manual**) via `POST /api/media/projects/:projectId/edits` (rendering private MP4s and appending immutable `EditVersion` records to `VersionSidebar`).
  - Reference mode honestly labels its beta scope (versioned pacing/effect preset; full external reference-video style transfer planned later).
  - Existing `<TimelineEditor />`, `<VersionSidebar />`, and `<CompareView />` remain mounted and functional for both media-source projects and classic upload projects.

---

## 6. Security Boundaries

- **Server-Authoritative Identity & Rights:** Frontend never sends `rightsStatus`, `ownerUserId`, `workerId`, `storageKey`, or `canonicalSourceId`.
- **Client + Server SSRF Defense:** `validatePublicMediaUrlInput()` rejects non-HTTP(S) schemes and local/private-network hosts (`localhost`, `127.0.0.1`, `169.254.169.254`, RFC1918 ranges) before calling the backend, which independently enforces strict SSRF blocking.
- **Zero Storage Key Leakage:** No `s3Key`, `objectKey`, `publishedObjectKey`, or MinIO paths appear in API responses, DOM, or browser storage.
- **No Long-Term Signed URL Persistence:** Signed URLs are never saved to `localStorage` or `sessionStorage`.
- **Cross-User Isolation & Expired Sessions:** `401` redirects to `/login?next=...`; `404` on another user's job or project renders clean denial without leaking existence; controlled test fixtures remain strictly disabled in production (`NODE_ENV === 'production'`).

---

## 7. Automated Verification & Measured Performance

- **Step 3C.1.1 Hardening Integration Suite (`apps/api/tests/integration/step3c11-hardening.test.ts`):** 4/4 passed (`45.8s`) against real local PostgreSQL, Redis, MinIO, BullMQ, and FFmpeg — verifying `SOURCE_MEDIA` vs. `BASE_CLIP` non-substitution, live rights revocation, missing/corrupt/expired/stale source rejection, private upload preview, cross-user 404 denial, non-blocking async HTTP `202` render submission (`< 2s` under simulated 2.5s worker delay), exact idempotency (1 version, 1 render job, 1 enqueue), running FFmpeg cancellation, crashed-worker bounded lease recovery (generation 1 → 2), `ffprobe` validation, private output isolation, signed URL renewal, and free-beta quotas/backpressure.
- **Frontend Helper Unit Tests (`apps/api/tests/unit/media-workspace-helpers.test.ts`):** 4/4 passed (`7ms`).
- **Universal Media UI Playwright Browser E2E (`apps/api/tests/e2e/universal-media-ui.test.ts`):** 3/3 passed (`57.0s`) — covering async `202` private render, double-click dedup, browser refresh resume on both `/media` and `/projects/[id]`, signed URL renewal, real `ffprobe`-validated private MP4 download, multi-tab `BroadcastChannel` sync, multi-subscriber cancel isolation, cross-user denial, and `390×844` mobile layout.
- **Existing Upload/Editor Regression E2E (`apps/api/tests/e2e/browser-pipeline.test.ts`):** 4/4 passed (`80.7s`) — full `Register → Upload → Analyze → Prompt Edit → Render → Download` (`1080×1920`, H.264/AAC, `6.2s < 11.578s`) preserved end-to-end.
- **Shared-Work Scaling & Full API Regression (`AI_PROVIDER=fallback npm test --prefix apps/api`):** **29/29 active files, 245/245 tests passed** (`456.2s`):
  - `universal-media-api.test.ts`: 9/9 passed (`52.3s`; 1,000 clippers → 1 shared job in `12.2s`).
  - `shared-job-hardening.test.ts`: 6/6 passed (`94.1s`; 1,000 clippers across 2 API instances: `enqueues=1 | workerClaims=1 | imports=1 | analyses=1 | baseClipRenders=1 | readySubscribers=1000/1000`).
  - `shared-live-processing.test.ts`: 7/7 passed (`62.1s`; 1,000 clippers in `6.05s`, 5,000 authorized URL issuances in `4.05s`).
  - Shared contracts (`npm run test:contracts`): 40/40 passed (`2.9s`).

---

## 8. Remaining Blockers Before the 100-User Beta

- **External Platform Acquisition:** Public YouTube, Twitch, and Kick URLs are truthfully recognized and reported as `UNSUPPORTED_ACQUISITION` / `BROADCAST_UNRESOLVED` until permitted provider acquisition mechanisms are integrated.
- **Scheduled Expired Private-Render Storage Reaper:** `PrivateRenderJob.outputExpiresAt` already blocks serving expired outputs on read; a periodic background MinIO deletion sweep for expired private render objects should be scheduled before public beta launch to reclaim object storage automatically.
- **Recent Media Jobs History List:** Currently browser refresh resumes the active/deep-linked job via `sessionStorage` + `?job=<jobId>` + `GET /api/media/jobs/:jobId`; a multi-job history endpoint (`GET /api/media/jobs`) can be added when clippers manage multiple concurrent queued streams.
- **Reference Mode Style Transfer:** Beta Reference mode persists a versioned pacing/effect preset; automated external reference-video analysis/style transfer is deferred to a future milestone.
- **Production Deployment & Migrations:** Local/test migrations (`20261118110531_media_processing_jobs`, `20261118121804_shared_media_work_coordination`, `20261118150221_private_render_jobs`) have not yet been applied to production pending explicit release approval.
