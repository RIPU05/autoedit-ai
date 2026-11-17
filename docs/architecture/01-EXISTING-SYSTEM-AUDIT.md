# AUTOAI EDIT — EXISTING SYSTEM AUDIT & BASELINE ANALYSIS

**Document ID:** ARCH-001  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Audit Date:** 2026-11-15  
**Active Production Deployment:** `https://autoedit-ai.vercel.app/` | `https://autoedit-ai.onrender.com/`

---

## 1. Monorepo Structure & File Layout

An exhaustive inspection of the physical repository tree reveals the following architectural components and directory topology:

```text
autoedit-ai/
├── apps/
│   ├── api/                     # Node.js + Express + Prisma + BullMQ backend
│   │   ├── prisma/
│   │   │   └── schema.prisma    # Complete Prisma ORM schema (PostgreSQL)
│   │   ├── src/
│   │   │   ├── ai/              # AI providers (Claude 3.5 Sonnet, Ollama, Fallback)
│   │   │   ├── config/          # Zod-validated environment configuration (env.ts)
│   │   │   ├── ffmpeg/          # FFmpeg command builder, filtergraph pipeline & probe
│   │   │   ├── lib/             # S3 presigner, Redis connections, Prisma client, telemetry
│   │   │   ├── middleware/      # JWT authentication, BOLA checks, Redis rate limiter
│   │   │   ├── queue/           # BullMQ queue definitions, worker loops, dead-letter logic
│   │   │   ├── routes/          # Express route controllers (Auth, Projects, Upload, Integrations)
│   │   │   ├── services/        # Business logic (Claude, Transcribe, Versioning, Upload Sessions)
│   │   │   ├── app.ts           # Express application setup, security middleware (Helmet, CORS)
│   │   │   ├── index.ts         # HTTP server entrypoint (port 4000)
│   │   │   └── worker.ts        # Standalone headless BullMQ worker entrypoint
│   │   ├── tests/               # Vitest test suites (Unit, Regression, Reliability, POC)
│   │   ├── Dockerfile           # Standard web service container
│   │   └── Dockerfile.worker    # Multi-stage BullMQ worker container with native FFmpeg
│   └── web/                     # Next.js 14 App Router frontend
│       ├── src/
│       │   ├── app/             # App Router pages (/login, /dashboard, /projects/[id], /settings)
│       │   ├── components/      # UI components (TimelineEditor, VersionSidebar, VideoPreview, Uploader)
│       │   └── lib/             # API client, TypeScript definitions, UI helpers
│       ├── package.json
│       └── next.config.js
├── docs/                        # Engineering notes, deployment runbooks, testing procedures
├── infra/                       # Architectural diagrams, n8n templates, readiness checklists
├── services/
│   └── whisper/                 # Faster-Whisper transcription microservices
│       ├── Dockerfile           # Local Python 3.11 CTranslate2 container
│       ├── main.py              # FastAPI local transcription server
│       ├── modal_app.py         # Modal serverless GPU Faster-Whisper service (T4 GPU)
│       └── requirements.txt
├── AGENTS.md                    # Antigravity persistent automated engineering rules
├── GEMINI.md                    # Rule cross-reference
├── render.yaml                  # Render Infrastructure-as-Code deployment spec
└── package.json                 # (NOTE: Root package.json does not exist; apps manage independent deps)
```

> [!NOTE]
> **Monorepo Topology Finding:** The repository is configured as independent applications within `apps/` rather than an npm/pnpm/yarn unified workspace root. `apps/api` and `apps/web` maintain dedicated `package.json` and `node_modules` trees. `packages/database` does not exist as a separate package; the Prisma client and schema are housed directly in `apps/api/prisma/schema.prisma`.

---

## 2. Git Branch History & Ancestry Audit

To establish an accurate baseline, the complete Git commit tree was inspected across all active and remote branches:

| Branch Name | Head Commit | Commits Ahead of `master` | Key Contents & Status |
|---|---|---|---|
| `master` | `799dca2` | 0 (Baseline) | **Production Release (v0.15.0-stable-hybrid).** Contains completed Phase 1 security, BOLA rate-limiting, upload-session state persistence, and error-handling improvements. Live on Vercel and Render. |
| `feature/workflow-automation-setup` | `14abbad` | +1 | Introduced `AGENTS.md` and `GEMINI.md` persistent automation guidelines. |
| `feature/phase2-cloud-infrastructure-plan` | `20387d0` | +2 | Delivered `AUTOAI_EDIT_PHASE2_CLOUD_INFRASTRUCTURE_PLAN.md` detailing hybrid Render + Modal architecture. |
| `feature/phase2-cloud-worker-poc` | `d684e51` | +3 | Authored `services/whisper/modal_app.py`, `apps/api/Dockerfile.worker`, `apps/api/tests/cloud-worker-poc.test.ts`, and `AUTOAI_EDIT_PHASE2_1_CLOUD_POC_REPORT.md`. |
| `feature/phase2-staging-deployment` | `3b5bd1a` | +4 | Introduced `BULL_PREFIX` queue namespacing, `WHISPER_SECRET` auth header dispatch, model weight container pre-caching, non-root `node` worker execution, and `tests/staging-worker-validation.test.ts`. |
| `docs/autoai-master-blueprint` | `Current` | +5 | Active documentation branch containing the complete Master Architecture Blueprint. |

> [!IMPORTANT]
> **Branching Ancestry Rule:** None of the Phase 2 feature branches have been merged into `master`. All production deployments currently run commit `799dca2`. The work on `feature/phase2-staging-deployment` represents validated staging foundations that remain strictly isolated from production.

---

## 3. Comprehensive Component Classification

Every major subsystem across the repository has been audited against source code and test results and classified into one of six objective statuses:

### A. Implemented and Verified
*Fully written, tested with automated test suites, and verified in production or local environments.*

1. **Authentication & Session Management (`apps/api/src/routes/auth.routes.ts`):**
   - JWT authentication via `HttpOnly` secure cookies.
   - User registration, password hashing via bcryptjs, and Google OAuth callback handler (`/api/auth/google/callback`).
   - Covered by 7 tests in `tests/auth-rate-limit.test.ts` and `tests/route-regression.test.ts`.
2. **BOLA-Guarded S3 Upload Session System (`apps/api/src/services/upload-session.service.ts`):**
   - Direct-to-S3 presigned PUT and multipart upload chunk initiation.
   - Multi-node session ownership verification preventing Broken Object Level Authorization (BOLA).
   - Validated by 11 passing tests in `tests/upload-authorization.test.ts`.
3. **Non-Destructive Version History Engine (`apps/api/src/services/version.service.ts`):**
   - Tree-structured version graph (`EditVersion` model) recording immutable snapshots of timeline operations, editorial prompts, and AI reasoning.
   - Child-version branching and historical rollback support.
   - Verified in `tests/cloud-worker-poc.test.ts` and `tests/worker-regression.test.ts`.
4. **Explainable AI Narrative Generator (`apps/api/src/ai/providers.ts`):**
   - Multi-agent editorial reasoning producing strategy summaries, key moments, hook mechanisms, and transcript alignment.
   - Claude 3.5 Sonnet integration with schema-enforced fallback logic.
   - Verified in `tests/worker-regression.test.ts`.
5. **Interactive Preview Studio (`apps/web/src/components/TimelineEditor.tsx`, `VideoPreview.tsx`):**
   - Client-side virtual rendering of timeline cuts without intermediate cloud transcoding.
   - Instant visual diff comparison (`CompareView.tsx`) between uncut raw video and edited sequence.
6. **FFmpeg Core Transcoding Engine (`apps/api/src/ffmpeg/pipeline.ts`):**
   - Headless FFmpeg execution constructing complex filtergraphs for silence removal, 9:16 vertical crop/pad, audio normalization, and burned-in subtitles.
   - Tested in `tests/unit/pipeline.test.ts`.

---

### B. Implemented but Incompletely Tested
*Code is fully written and functional, but automated end-to-end integration tests depend on live external services that are mocked in CI.*

1. **Live n8n Webhook Dispatch (`apps/api/src/services/n8n.service.ts`):**
   - Automated workflow trigger upon render completion.
   - Webhook signature hashing (`N8N_WEBHOOK_SECRET`) and execution state tracking (`WorkflowRun` model).
   - Unit-tested via mocks in `tests/route-regression.test.ts`; live HTTP round-trips require an external n8n instance.
2. **Modal Serverless Faster-Whisper GPU App (`services/whisper/modal_app.py`):**
   - Complete Python microservice implementing Faster-Whisper on NVIDIA T4 with scale-to-zero, Bearer authentication, and direct S3 streaming (`/transcribe-s3`).
   - Validated via unit mocks in `tests/staging-worker-validation.test.ts`; live deployment on Modal is gated awaiting user approval.
3. **Containerized BullMQ Worker (`apps/api/Dockerfile.worker`):**
   - Multi-stage Debian container bundling native FFmpeg, non-root `node` user, and scratch healthcheck.
   - Docker CLI is not installed on the local Windows workstation; build verification has been performed statically and verified against Render's container build specification.

---

### C. Partially Implemented
*Foundational models or routes exist in the codebase, but the feature is incomplete or requires additional workflows.*

1. **Creator Profile & Style Memory (`apps/api/src/services/creator-memory.service.ts`):**
   - `CreatorProfile` Prisma model exists and stores preferences (`pacingPreference`, `editingStyle`, `signals`).
   - Dynamic prompt injection is implemented in `buildPromptInjection()`.
   - Missing: Automated Bayesian / reinforcement learning feedback loops that update creator style counters based on timeline edits.
2. **Social Copy Repurposing Panel (`apps/web/src/components/RepurposePanel.tsx`):**
   - UI panel renders AI-generated captions and hashtags for TikTok, Instagram, YouTube, and LinkedIn.
   - Backend persists copy in `Analysis.socialCopy`.
   - Missing: Direct one-click publishing integrations or OAuth connections to social networks.
3. **Queue Namespacing (`apps/api/src/queue/queues.ts`):**
   - `BULL_PREFIX` configuration implemented in Phase 2.2 allows segregating queues (`staging:analysis` vs `bull:analysis`).
   - Missing: Automated dashboard UI displaying active jobs across multiple namespaces.

---

### D. Planned Only
*Documented in project roadmaps, release notes, or database schemas, but no core runtime code exists.*

1. **Twitch, Kick, and YouTube Livestream Ingestion (`LIVE-001` - `LIVE-003`):**
   - Documented in roadmap; no OAuth handlers, chat stream listeners, or video chunking implementations exist in `apps/api`.
2. **Direct OBS RTMP/SRT Broadcast Gateway (`LIVE-002`):**
   - Requires integration of MediaMTX or an RTMP ingest server to receive live broadcasts from OBS.
3. **Real-Time Multimodal Chat Spike Detector (`AI-002`):**
   - Planned algorithm to combine chat velocity, exclamation sentiment, and keyword clustering to flag live stream highlights.
4. **Automated Social Publishing (`PUB-001`):**
   - Direct API publishing to YouTube Data API v3, TikTok Content Posting API, or Instagram Graph API.

---

### E. Missing Foundations
*Architectural elements required for enterprise SaaS operations that have not yet been authored.*

1. **Billing, Subscription & Stripe Metering (`SAAS-001`):**
   - No `Subscription`, `Plan`, or `Invoice` Prisma models exist.
   - No Stripe webhook handlers or usage metering tables exist in the database.
2. **Face Tracking & Smart Vertical Crop (`PROD-004`):**
   - FFmpeg pipeline currently crops or pads horizontally to 1080x1920 using center-crop (`crop=ih*9/16:ih`). Dynamic AI face/speaker tracking bounding boxes are not yet implemented.
3. **Standalone Database Package (`packages/database`):**
   - Monorepo does not share Prisma models across potential future microservices.

---

### F. Blocked by Infrastructure or External APIs
*Cannot be executed without live third-party accounts, credentials, or paid cloud infrastructure.*

1. **Live Cloud Modal GPU Transcription:** Blocked pending user authorization of Modal deployment in Stage 2.
2. **Twitch / YouTube VOD Retrieval:** Blocked by platform API restrictions (Twitch API does not permit arbitrary third-party MP4 downloads without creator OAuth scopes; YouTube requires OAuth permissions and compliant quota limits).
3. **Render Cloud Worker Staging:** Blocked pending user approval of cloud provisioning gate.

---

## 4. Test Coverage Baseline Reconciliation by Branch

To maintain strict truth in technical documentation, test execution counts must never conflate the production `master` branch with experimental or staging feature branches:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   TEST SUITE INVENTORY BY BRANCH                       │
└────────────────────────────────────────────────────────────────────────┘
  [PRODUCTION: master (commit 799dca2)]
  ├── tests/auth-rate-limit.test.ts            (3 tests passed)
  ├── tests/route-regression.test.ts           (10 tests passed)
  ├── tests/upload-authorization.test.ts      (11 tests passed)
  ├── tests/worker-regression.test.ts          (4 tests passed)
  ├── tests/worker-reliability.test.ts         (4 tests passed)
  ├── tests/unit/env.test.ts                   (4 tests passed)
  ├── tests/unit/pipeline.test.ts              (7 tests passed)
  └── tests/integration/e2e.test.ts           (4 tests skipped - live sidecars)
  ────────────────────────────────────────────────────────────────────────
  MASTER TOTAL:                                43 passed | 4 skipped | 0 failed

  [STAGING ADDITIONS: feature/phase2-cloud-worker-poc (commit d684e51)]
  └── tests/cloud-worker-poc.test.ts           (+3 tests passed, 10 criteria)
  ────────────────────────────────────────────────────────────────────────
  PHASE 2.1 POC TOTAL:                         46 passed | 4 skipped | 0 failed

  [STAGING ADDITIONS: feature/phase2-staging-deployment & docs/autoai-master-blueprint]
  └── tests/staging-worker-validation.test.ts  (+5 tests passed, queue/auth)
  ────────────────────────────────────────────────────────────────────────
  STAGING & BLUEPRINT TOTAL:                   51 passed | 4 skipped | 0 failed
```

| Test File | Focus | On `master`? | On `phase2-staging`? | Tests Passed | Tests Skipped | Tests Failed |
|---|---|---|---|---|---|---|
| `tests/auth-rate-limit.test.ts` | Auth rate limiting & lockout prevention | **Yes** | **Yes** | 3 | 0 | 0 |
| `tests/route-regression.test.ts` | Auth, projects, S3 upload, integration routes | **Yes** | **Yes** | 10 | 0 | 0 |
| `tests/upload-authorization.test.ts` | BOLA security, multi-user chunk isolation | **Yes** | **Yes** | 11 | 0 | 0 |
| `tests/worker-regression.test.ts` | Analysis worker fallback, timeline generation | **Yes** | **Yes** | 4 | 0 | 0 |
| `tests/worker-reliability.test.ts` | Scratch cleanup, retry backoff, error categories | **Yes** | **Yes** | 4 | 0 | 0 |
| `tests/unit/env.test.ts` | Zod schema validation for environment variables | **Yes** | **Yes** | 4 | 0 | 0 |
| `tests/unit/pipeline.test.ts` | FFmpeg command synthesis & filtergraph logic | **Yes** | **Yes** | 7 | 0 | 0 |
| `tests/integration/e2e.test.ts` | Live service integration (requires live sidecars) | **Yes** | **Yes** | 0 | 4 | 0 |
| `tests/cloud-worker-poc.test.ts` | Phase 2.1 cloud worker lifecycle & DLQ routing | **No** (Branch only) | **Yes** | 3 | 0 | 0 |
| `tests/staging-worker-validation.test.ts` | Phase 2.2 queue isolation, secret headers, health | **No** (Branch only) | **Yes** | 5 | 0 | 0 |
| **TOTALS** | | **Master: 8 files** | **Branch: 10 files** | **Master: 43**<br>**Branch: 51** | **4** | **0** |

> [!CAUTION]
> **Production Baseline Truth:** 43 tests pass on `master`. 51 tests pass only on the staging and blueprint feature branches (`feature/phase2-staging-deployment` and `docs/autoai-master-blueprint`). No claim may be made that 51 tests run on production until the feature branch is merged into `master`.

- **Automated Test Success Rate on Current Blueprint Branch:** **100% of runnable tests passing** (51/51).
- **TypeScript Compilation:** `apps/api` (`tsc -p tsconfig.json`) passes with **0 errors**.
- **Next.js Web Build:** `apps/web` (`next build`) compiles all 10 production routes with **0 errors**.
- **Next.js Web Build:** `apps/web` (`next build`) compiles all 10 production routes with **0 errors**.
