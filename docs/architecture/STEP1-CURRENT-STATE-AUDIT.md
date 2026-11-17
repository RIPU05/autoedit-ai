# AutoAI Edit — Step 1: Current State Technical Audit

**Document ID:** AUDIT-STEP1-001  
**Version:** 1.0.0-PROD  
**Status:** Approved for Implementation Governance  
**Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Master Commit SHA:** `f77d5ba498a43536dd0723b5eb85e169384ace34`  
**Production URL (Frontend):** `https://autoedit-ai.vercel.app/`  
**Production URL (API):** `https://autoedit-ai.onrender.com/`  
**Target Branch:** `docs/step1-architecture-audit-roadmap`  

---

## 1. Executive Summary & Audit Methodology

AutoAI Edit is being developed as an expandable, cloud-native video editing and content automation platform designed for independent clippers, live streamers (Twitch, Kick, YouTube), podcasters, and everyday content creators. The platform's product vision centers on **one unified web studio** that provides four composable editing paradigms:
1. **Auto Edit:** Algorithmic highlight extraction and silence reduction.
2. **Prompt Edit:** Natural-language conversational directives ("make it faster", "zoom in on reactions").
3. **Reference Edit:** Exemplar-conditioned style transfer (replicating pacing, zooms, typography, and structure).
4. **Manual Edit:** Pixel-accurate, client-side canvas timeline trimming and layout adjustment.

### Audit Invariant & Document Scope
This audit adheres strictly to empirical verification: **no feature is marked `VERIFIED_WORKING` without reproducible, non-mocked test evidence.** Code presence, TypeScript interfaces, and unit tests using mock objects do not constitute proof of production end-to-end functionality.

> [!NOTE]
> **Blueprint Branch Separation:** The 20 upstream architectural blueprints (`00-MASTER-BLUEPRINT.md` through `19-REFERENCE-BASED-AI-EDITING.md`) reside on dedicated architecture branches (`docs/autoai-master-blueprint`, `docs/lite-and-pro-processing-architecture`, `docs/reference-based-ai-editing`, and `docs/blueprint-final-consistency-review`, tracked in open PRs #5, #6, and #7). They have not yet been merged into `master`. This Step 1 audit evaluates the current codebase on `master` (`f77d5ba`) and references those specifications as target architecture baselines.

---

## 2. Part A — Repository Structure & Codebase Inspection

The repository is organized as an independent multi-package project (without a root `package.json` package-manager workspace runner). Each subsystem maintains its own `package.json`, build lifecycle, and dependencies.

```
autoedit-ai/
├── .github/workflows/ci.yml       # GitHub Actions CI workflow (mocked unit tests)
├── apps/
│   ├── api/                      # Node.js Express 4.21 + Prisma + BullMQ backend
│   └── web/                      # Next.js 15.5.19 + React 19 frontend
├── services/
│   └── whisper/                  # Python 3.10 FastAPI sidecar (faster-whisper)
├── packages/
│   └── contracts/                # Shared Zod schemas & TypeScript types (Milestone 0A)
├── infra/                        # Deployment runbooks, n8n templates, phase docs
├── docker-compose.yml            # Local developer multi-service stack definition
└── render.yaml                   # Production Render Blueprint definition
```

### 2.1 Backend Architecture (`apps/api`)
- **Web Framework:** Express 4.21.0 ([`apps/api/src/app.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/app.ts)) with Helmet, CORS, Cookie-Parser, and rate limiting (`express-rate-limit`).
- **Database & ORM:** Prisma 5.20.0 ([`apps/api/prisma/schema.prisma`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/prisma/schema.prisma)) targeting PostgreSQL. Migrations: `20260615132347_init_full`, `20260619095644_add_ollama_error_category`, `20260621000000_backend_integrations`, `20260621010000_n8n_event_log_fields`.
- **Queue & Async Processing:** BullMQ 5.13.0 + ioredis 5.4.1 ([`apps/api/src/queue/queues.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/queue/queues.ts)). Four queues: `analysis`, `render`, `n8n-dispatch`, and `dead-letter`.
- **Worker Entrypoint:** [`apps/api/src/worker.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/worker.ts) runs `analysisWorker`, `renderWorker`, and `n8nWorker`.
- **Media Engine:** Static FFmpeg 6.1.1 (`ffmpeg-static`) and FFprobe 4.0.2 (`ffprobe-static`) executed via `fluent-ffmpeg` ([`apps/api/src/ffmpeg/pipeline.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/ffmpeg/pipeline.ts)).
- **Object Storage:** AWS SDK v3 `@aws-sdk/client-s3` ([`apps/api/src/lib/s3.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/lib/s3.ts)).
  > [!CRITICAL]
  > **Architectural Limitation in S3 Client:** `apps/api/src/lib/s3.ts` instantiates `S3Client` with hardcoded AWS endpoints (`region`, `accessKeyId`, `secretAccessKey`). It does **NOT** accept `endpoint` or `forcePathStyle`. Consequently, the API cannot communicate with local MinIO or LocalStack without code changes to [`env.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/config/env.ts) and [`s3.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/lib/s3.ts).
- **Authentication & Security:** JWT with HTTP-only cookies and Bearer tokens ([`apps/api/src/middleware/auth.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/middleware/auth.ts)). Rate limiting scoped by user ID and route category.
- **AI Providers:** Modular orchestrator in [`apps/api/src/ai/providers.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/ai/providers.ts) supporting Claude (`@anthropic-ai/sdk`), Ollama HTTP, and a deterministic offline fallback (`buildFallbackPipelineResult`).

### 2.2 Frontend Architecture (`apps/web`)
- **Framework:** Next.js 15.5.19 (`App Router`) with React 19 ([`apps/web/package.json`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/package.json)).
- **Routes:** 10 production pages compiled successfully:
  - `/` (Landing page)
  - `/login` (Email/password authentication)
  - `/dashboard` (Project index & file uploader)
  - `/projects/[id]` (Main studio, timeline editor, version history, repurpose panel)
  - `/settings` & `/settings/integrations` (User profile & third-party keys)
  - `/analytics` (Usage metrics)
  - `/admin/feedback` (User feedback triage)
- **Studio Components:**
  - [`TimelineEditor.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/TimelineEditor.tsx): Non-destructive timeline state, AI Director prompt interface, 7 goal presets.
  - [`VideoPreview.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/VideoPreview.tsx): HTML5 video playback with playhead synchronization.
  - [`VisualTimeline.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/VisualTimeline.tsx): Multi-track visual timeline representation.
  - [`VersionSidebar.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/VersionSidebar.tsx) & [`CompareView.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/CompareView.tsx): Version history and visual diff comparison.
  - [`RepurposePanel.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/RepurposePanel.tsx): Multi-aspect ratio batch export selector (YouTube, Shorts, TikTok, Reels, LinkedIn, X).

### 2.3 Transcription Sidecar (`services/whisper`)
- **Engine:** Python FastAPI service wrapping `faster-whisper` (CTranslate2) with optional `pyannote.audio` diarization ([`services/whisper/main.py`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/services/whisper/main.py)).
- **Serverless Design:** [`services/whisper/modal_app.py`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/services/whisper/modal_app.py) defines a serverless deployment for Modal Labs GPU infrastructure (scale-to-zero).
- **Vulnerability Discovered:** In [`analysis.worker.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/queue/workers/analysis.worker.ts#L84-L90), `transcribeRich` is invoked unconditionally on any video with audio. If the Whisper sidecar is offline (port 9000 unreachable), `transcribeRich` throws an unhandled error after 3 retries, and the analysis worker marks the project as **`FAILED`**. There is **no fallback** for transcription.

### 2.4 Testing Suite & CI Workflows
- **Vitest Unit/Regression Suite:** 46 passing tests, 4 skipped (`tests/integration/e2e.test.ts` gated behind `RUN_E2E=1`).
- **Test Nature:** Every unit test in `apps/api/tests/` uses `vi.mock` for Prisma, Redis, S3, and FFmpeg. There are **zero automated integration tests running against real databases or storage** in GitHub Actions CI (`.github/workflows/ci.yml`).

---

## 3. Part B — Review of Existing Architecture Branches & PRs

A detailed audit of all active branches, open pull requests, and commit histories was conducted:

```
master (f77d5ba) ◄── origin/master
  ├── feature/automated-pull-request-workflow (PR #4 - OPEN)
  ├── feature/stage2-milestone0a-shared-contracts (Commit 1657597 - NO PR)
  └── docs/autoai-master-blueprint (Baseline)
        └── docs/lite-and-pro-processing-architecture (PR #5 - OPEN)
              └── docs/reference-based-ai-editing (PR #6 - OPEN)
                    └── docs/blueprint-final-consistency-review (PR #7 - OPEN)
```

### 3.1 Pull Request Status Table
| PR # | Head Branch | Base Branch | State | Summary of Content | Risk / Assessment |
|:---:|---|---|:---:|---|---|
| **#4** | `feature/automated-pull-request-workflow` | `master` | **OPEN** | Adds persistent agent guidelines (`AGENTS.md`, `GEMINI.md`) for automated Git operations. | **Low Risk.** Clean documentation; should target `master`. |
| **#5** | `docs/lite-and-pro-processing-architecture` | `docs/autoai-master-blueprint` | **OPEN** | Adds `18-LITE-AND-PRO-PROCESSING-ARCHITECTURE.md` (LITE deterministic vs PRO multimodal AI). | **Valid Architecture.** Preserves product invariants. |
| **#6** | `docs/reference-based-ai-editing` | `docs/lite-and-pro-processing-architecture` | **OPEN** | Adds `19-REFERENCE-BASED-AI-EDITING.md` (Exemplar video style transfer, 4 composable editing modes). | **Valid Architecture.** Preserves product invariants. |
| **#7** | `docs/blueprint-final-consistency-review` | `docs/reference-based-ai-editing` | **OPEN** | Final consistency review across all 20 blueprints; unifies roadmap and link-first streaming access. | **Valid Architecture.** Represents the canonical blueprint state. |
| — | `feature/stage2-milestone0a-shared-contracts` | — | **NO PR** | Implements `packages/contracts/` (`@autoedit/contracts`) with 21 unit tests. | **Diverged History.** Branched from `799dca2` (behind `origin/master` at `f77d5ba`). Must be rebased/cherry-picked. |

### 3.2 Key Architectural Decisions Confirmed as Valid:
1. **Link-First Access Decoupled from User Identity:** Users can edit videos without connecting Twitch/Kick/YouTube accounts. Platform authorization is strictly reserved for actions requiring platform write access (OBS ingest, private VOD download, direct publishing).
2. **Four Composable Editing Paradigms:** Auto, Prompt, Reference, and Manual modes coexist within one studio and produce a unified `EditTimelinePlan`.
3. **Single Application Monolith:** No microservice sprawl. One Next.js frontend, one Express API, and one background worker pool consuming from BullMQ queues.
4. **Shared Stream Ingestion:** One logical stream ingest per live session, with shared highlight detection and reusable segment assets across multiple clipper workspaces.

---

## 4. Part C — Current Functionality Matrix

The following matrix documents the verified reality of AutoAI Edit across 24 core capabilities:

| # | Feature Area | Current Implementation | Evidence & File Location | Status | Missing Work / Gaps | Priority |
|---|--------------|------------------------|--------------------------|:------:|---------------------|:--------:|
| 1 | **User Registration & Login** | Express auth routes, JWT in HTTP-only cookie, bcrypt password hashing. | [`apps/api/src/routes/auth.routes.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/routes/auth.routes.ts); live browser verified. | **VERIFIED_WORKING** | Password reset flow; session revocation list. | HIGH |
| 2 | **Route Protection** | `requireAuth` middleware redirects to `/login`. | [`apps/api/src/middleware/auth.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/middleware/auth.ts); verified in browser. | **VERIFIED_WORKING** | Role-based permission granularity (ADMIN/CREATOR). | MEDIUM |
| 3 | **Video Upload (Multipart S3)** | Multi-part presigning in API; dropzone in web UI. | [`apps/api/src/routes/upload.routes.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/routes/upload.routes.ts); [`Uploader.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/Uploader.tsx). | **IMPLEMENTED_NOT_E2E_VERIFIED** | S3 client lacks `S3_ENDPOINT` for local MinIO; direct cloud E2E untested. | HIGH |
| 4 | **Public Video/Stream URL Ingestion** | Blueprints exist in `00-MASTER-BLUEPRINT.md` (unmerged branch `docs/autoai-master-blueprint`). | No backend parsing or yt-dlp/downloader code in `apps/api`. | **NOT_IMPLEMENTED** | YouTube/Twitch/Kick URL parser, canonical sanitizer, stream downloader. | HIGH |
| 5 | **Live Stream Capture (OBS/RTMP)** | Architecture in `06-LIVESTREAM-INGESTION-ARCHITECTURE.md` (unmerged branch `docs/autoai-master-blueprint`). | No MediaMTX or RTMP/SRT ingestion daemon in repository. | **DOCUMENTED_ONLY** | Ingestion gateway, stream key generator, rolling buffer writer. | MEDIUM |
| 6 | **Shared Stream Deduplication** | Blueprint in ARCH-006 (unmerged branch `docs/autoai-master-blueprint`). | No shared stream coordinator in codebase. | **DOCUMENTED_ONLY** | Ingest lease manager, shared segment store, tenant access proxy. | MEDIUM |
| 7 | **FFmpeg Media Probing** | Duration, dimensions, fps, audio stream inspection. | [`apps/api/src/ffmpeg/probe.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/ffmpeg/probe.ts); verified on `test_sample_10s.mp4`. | **VERIFIED_WORKING** | HDR/color space detection; audio channel layout parsing. | LOW |
| 8 | **Silence & Audio Detection** | FFmpeg `silencedetect` filter parses silence intervals. | [`apps/api/src/ffmpeg/probe.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/ffmpeg/probe.ts); verified in pipeline script. | **VERIFIED_WORKING** | Adaptive noise floor calibration for variable mic inputs. | MEDIUM |
| 9 | **Audio Extraction** | 16-bit PCM 44.1kHz mono WAV extraction via FFmpeg. | [`apps/api/src/ffmpeg/probe.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/ffmpeg/probe.ts); verified `extracted_audio.wav`. | **VERIFIED_WORKING** | Multi-track audio channel separation. | LOW |
| 10 | **Whisper Transcription** | FastAPI `faster-whisper` sidecar on port 9000. | [`services/whisper/main.py`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/services/whisper/main.py); connection refused in local tests. | **BLOCKED** | Local Python/Whisper offline; worker crashes on offline Whisper (no fallback). | HIGH |
| 11 | **Deterministic AI Fallback** | Silence-anchored highlight, virality score, and social copy generator. | [`apps/api/src/ai/providers.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/ai/providers.ts); verified zero-cost execution. | **VERIFIED_WORKING** | Rule-based hook selection tuning. | LOW |
| 12 | **Claude Multimodal Analysis** | Anthropic Sonnet/Haiku integration for highlight scoring. | [`apps/api/src/services/claude.service.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/services/claude.service.ts); returns HTTP 401 on Render. | **BLOCKED** | Anthropic API key invalid on production Render; key rotation required. | HIGH |
| 13 | **Prompt-Based Timeline Editing** | Web textarea + 7 presets; `POST /:id/edit`. | [`TimelineEditor.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/TimelineEditor.tsx); [`projects.routes.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/routes/projects.routes.ts). | **PARTIAL** | UI/API fully wired, but calls Claude with **no fallback**; crashes when Claude is 401. | HIGH |
| 14 | **Reference-Based AI Editing** | Architecture defined in ARCH-019 (unmerged branch `docs/reference-based-ai-editing`, PR #6). | Zero code in `apps/api` or `apps/web`. | **DOCUMENTED_ONLY** | Exemplar style extractor, pacing transfer engine, reference UI panel. | MEDIUM |
| 15 | **Manual Timeline Editing** | Client-side trim, reorder, zoom, effect toggling. | [`TimelineEditor.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/TimelineEditor.tsx); state updates verified. | **IMPLEMENTED_NOT_E2E_VERIFIED** | Snapping controls, multi-track splitting, keyframe animation. | MEDIUM |
| 16 | **Studio HTML5 Video Preview** | Playhead seek, segment skipping, canvas duration. | [`VideoPreview.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/VideoPreview.tsx). | **IMPLEMENTED_NOT_E2E_VERIFIED** | Client-side subtitle burn preview, real-time zoom transform canvas. | MEDIUM |
| 17 | **Version History & Diffing** | Immutable `EditVersion` records; visual compare modal. | [`VersionSidebar.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/VersionSidebar.tsx); [`CompareView.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/CompareView.tsx). | **IMPLEMENTED_NOT_E2E_VERIFIED** | One-click restore regression testing against active database. | MEDIUM |
| 18 | **FFmpeg Reel Transcoding (9:16)** | Scale, crop, Ken Burns zoom, audio resample to MP4. | [`apps/api/src/ffmpeg/pipeline.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/ffmpeg/pipeline.ts); verified `final_reel.mp4`. | **VERIFIED_WORKING** | Animated subtitle ASS integration, EBU R128 audio normalization. | HIGH |
| 19 | **Cloud Worker Execution** | BullMQ worker consuming Redis jobs. | [`apps/api/src/worker.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/worker.ts); missing from `render.yaml`. | **BLOCKED** | Render deploys only web API; no cloud worker runs in production. | CRITICAL |
| 20 | **Multi-Storage Abstraction** | AWS S3 SDK v3 directly imported. | [`apps/api/src/lib/s3.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/lib/s3.ts). | **PARTIAL** | Storage provider interface missing; hardcoded to AWS; no MinIO/R2 support. | HIGH |
| 21 | **User Cohorts & Quotas** | Architecture in ARCH-010/018 (unmerged branch `docs/lite-and-pro-processing-architecture`, PR #5). | Basic rate limiter only; no cohort or usage quota tables. | **NOT_IMPLEMENTED** | Founding cohort tracking, clip minute quotas, durable ledger. | HIGH |
| 22 | **Configurable Pricing & Billing** | Architecture in ARCH-018 (unmerged branch `docs/lite-and-pro-processing-architecture`, PR #5); Stripe integration specs. | No billing models in Prisma schema; no Stripe SDK. | **DOCUMENTED_ONLY** | Stripe checkout webhook, dynamic entitlement verification. | LOW |
| 23 | **Referral Campaigns** | Requirements in ARCH-000 (unmerged branch `docs/autoai-master-blueprint`) / prompt. | No referral code generator, attribution, or reward engine. | **NOT_IMPLEMENTED** | Referral tracking schema, reward ledger, referral UI dashboard. | LOW |
| 24 | **Social Multi-Publishing** | n8n webhook dispatch for automated social publishing. | [`apps/api/src/routes/n8n.routes.ts`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/api/src/routes/n8n.routes.ts); [`RepurposePanel.tsx`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/apps/web/src/components/RepurposePanel.tsx). | **IMPLEMENTED_NOT_E2E_VERIFIED** | Direct platform OAuth publishing (YouTube Data API, TikTok API). | LOW |

---

## 5. Part D — Infrastructure Assessment

### 5.1 Deployment Definitions Breakdown
| Component | Definition File | Runtime Target | Status / Assessment |
|---|---|---|---|
| **Express API** | [`render.yaml`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/render.yaml) & [`docker-compose.yml`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docker-compose.yml) | Render Free Web Service (`autoedit-api`) | **CONFIGURED.** Boots with cold start (~45s). |
| **Next.js Web** | Vercel Project Config & [`docker-compose.yml`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docker-compose.yml) | Vercel Serverless Platform | **CONFIGURED.** Builds and deploys reliably. |
| **BullMQ Worker** | [`docker-compose.yml`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docker-compose.yml) (service `worker`) | **MISSING ON RENDER** | **CRITICAL DEFECT.** Defined in local Docker Compose, but completely omitted from `render.yaml`. Cloud jobs enter Redis and freeze indefinitely. |
| **Whisper Service** | [`services/whisper/Dockerfile`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/services/whisper/Dockerfile) & `modal_app.py` | Local Docker / Modal Labs | **NOT DEPLOYED.** Local Docker is offline; Modal app is unprovisioned. |
| **PostgreSQL** | [`docker-compose.yml`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docker-compose.yml) (`postgres:16-alpine`) | Neon / Local Docker | **CONFIGURED.** Cloud database healthy; local port 5432 closed. |
| **Redis** | [`docker-compose.yml`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docker-compose.yml) (`redis:7-alpine`) | Upstash / Local Docker | **CONFIGURED.** Cloud Upstash healthy; local port 6379 closed. |
| **Object Storage** | Implicit AWS S3 | AWS S3 Bucket (`autoedit-...`) | **CONFIGURED FOR AWS ONLY.** Local MinIO/LocalStack definition absent from `docker-compose.yml`. |

### 5.2 Redis Connection vs. Active Worker Consumption
The production backend `/health` endpoint reports:
```json
{
  "redis": { "ok": true, "latencyMs": 505 },
  "queue": { "ok": true, "latencyMs": 335 }
}
```
> [!WARNING]
> A healthy Redis connection and queue status does **NOT** indicate that background jobs are being processed. The health check simply calls `connection.ping()` and `queue.getJobCounts()`. Because `render.yaml` does not provision a worker service, jobs sit in the queue in `QUEUED` state indefinitely.

### 5.3 Local Docker & Host Environment Blockers
- **Host OS:** Windows x64.
- **Docker Desktop:** Not installed (`docker : The term 'docker' is not recognized`).
- **Podman / WSL:** Podman is not installed; WSL is unconfigured.
- **Native Services:** PostgreSQL and Redis servers are not installed as Windows services.
- **Node.js Local Boot Blocker:** Attempting to start `node dist/index.js` locally triggers immediate `AggregateError: connect ECONNREFUSED 127.0.0.1:6379` because BullMQ attempts to connect to Redis on module load.

### 5.4 CPU and GPU Worker Extensibility
The application is architecturally capable of connecting additional CPU and GPU workers without redesign:
- **Stateless Jobs:** `analysis` and `render` jobs communicate strictly via S3 object keys (`s3Key`, `bucket`) and database IDs (`projectId`, `renderId`). No local state persists between jobs.
- **Required Interface Boundary:**
  1. Add capability tags to BullMQ job payloads (`{ requiredCapability: 'gpu' | 'cpu' }`).
  2. Implement capability-aware worker concurrency (`CONCURRENCY_RENDER_GPU`, `CONCURRENCY_RENDER_CPU`).
  3. Decouple transcription via an external HTTP/gRPC interface (`WHISPER_URL`), allowing the transcription engine to run on serverless GPU (Modal Labs) while CPU workers handle FFmpeg rendering.
