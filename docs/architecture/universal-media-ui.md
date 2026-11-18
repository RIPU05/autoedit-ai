# Universal Media Input, Job Progress & Highlight Workspace UI (Step 3C.1)

## Overview

Step 3C.1 connects the Step 3B.9 / 3B.9.1 Universal Media API (`/api/media/*`) directly to the Next.js frontend (`apps/web`), giving independent clippers one cohesive authenticated workspace to:

1. Paste a public YouTube, Twitch, or Kick live/VOD link — or pick an existing uploaded video, or upload a new video — with **no mandatory streamer login**.
2. Receive truthful backend capability feedback (never faking acquisition for unsupported external links).
3. Submit idempotent highlight-detection jobs backed by PostgreSQL `SharedMediaWork`, `MediaProcessingJob`, and BullMQ (`media-process`).
4. Monitor real backend progress (`QUEUED`, `RUNNING`, `READY`, `FAILED`, `CANCELLED`), resume seamlessly across browser refreshes, and cancel safely without disrupting other clippers.
5. Preview detected highlights using short-lived (`300s`) refreshable signed URLs, open a private editing project in the existing timeline editor, edit across Auto / Prompt / Reference / Manual modes, and privately download the final MP4.

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
- `media.applyProjectEdit(projectId, req)` → `POST /api/media/projects/:projectId/edits`

Additive backend handoff improvements (`apps/api/src/routes/projects.routes.ts`):
- `GET /api/projects` returns non-sensitive `sourceAsset` metadata (`id`, `durationSec`, `width`, `height` — never `s3Key`) so the Existing Upload picker lists only projects with uploaded source footage.
- `GET /api/projects/:id` includes safe `mediaSource` summary (`id`, `provider`, `sourceType`, `metadata`) for duration & header display.
- `GET /api/projects/:id/source-url` checks live PostgreSQL rights via `DurableMediaRegistryService` for `mediaSource`-backed projects and issues a short-lived (`300s`) signed preview URL when `sourceAsset` is absent.

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

## 7. Automated Browser E2E & Verification Coverage

- **Frontend Helper Unit Tests (`apps/api/tests/unit/media-workspace-helpers.test.ts`):** URL/SSRF guard, honest capability messaging, polling backoff & terminal stop, idempotency keys, and API error formatting.
- **Universal Media UI Playwright Browser E2E (`apps/api/tests/e2e/universal-media-ui.test.ts`):** All 20 Section 10 scenarios verified against live Next.js (`localhost:3000`), Express API (`localhost:4000`), BullMQ worker, PostgreSQL, Redis, MinIO, and FFmpeg (including `ffprobe` validation of downloaded private MP4, browser refresh resume, double-click dedup, multi-subscriber cancel, failed job error, cross-user denial, expired link refresh, and `390×844` mobile layout check).
- **Existing Upload/Editor Regression E2E (`apps/api/tests/e2e/browser-pipeline.test.ts`):** Full `Register → Upload → Analyze → Prompt Edit → Render → Download` workflow preserved end-to-end.

---

## 8. Remaining Limitations Before the 100-User Beta

- **External Platform Acquisition:** Public YouTube, Twitch, and Kick URLs are truthfully recognized and reported as `UNSUPPORTED_ACQUISITION` / `BROADCAST_UNRESOLVED` until permitted provider acquisition mechanisms are integrated.
- **Recent Media Jobs History List:** Currently browser refresh resumes the active/deep-linked job via `sessionStorage` + `?job=<jobId>` + `GET /api/media/jobs/:jobId`; a multi-job history endpoint (`GET /api/media/jobs`) can be added when clippers manage multiple concurrent queued streams.
- **Reference Mode Style Transfer:** Beta Reference mode persists a versioned pacing/effect preset; automated external reference-video analysis/style transfer is deferred to a future milestone.
- **Production Deployment & Migrations:** Local/test migrations (`20261118110531_media_processing_jobs`, `20261118121804_shared_media_work_coordination`) have not yet been applied to production pending explicit release approval.
