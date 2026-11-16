# AUTOAI EDIT — IMPLEMENTATION ROADMAP & MILESTONE SPECIFICATION

**Document ID:** ARCH-012  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Engineering Roadmap & Project Management Plan

---

## 1. Product Vision & Dependency Graph

### 1.1 Core Product Vision
**AutoAI Edit is one unified web application** serving independent clippers, streamers, video podcasters, digital content creators, and ordinary users.

- **Link-First & Upload Access:** Any user can paste a supported public livestream/video URL (Twitch, YouTube, Kick) or upload their own video file (MP4/MOV).
- **No Mandatory Platform Lock-In:** Platform account connections (OAuth) are **never mandatory for ordinary editing**. Authorization is requested only where a particular platform action strictly requires it (e.g. personal OBS stream key generation, private VOD access, or direct social media API publishing).
- **Four Composable Editing Paradigms:** Creators can edit automatically via highlight/silence detection (**AUTO EDIT**), instruct changes in natural language (**PROMPT EDIT**), transfer exemplar pacing and aesthetics (**REFERENCE EDIT**), or adjust timeline blocks directly (**MANUAL EDIT**). All four compile into a single non-destructive `EditTimelinePlan`.

### 1.2 Engineering Dependency Graph & Safety Invariant
> [!IMPORTANT]
> **Safety Invariant (Quotas Ahead of Public Cloud Compute):** To eliminate the risk of runaway cloud bills or malicious API abuse, **server-side entitlement enforcement, durable quota accounting, and hard spend limits (`SAAS-009`, `AUTH-005`) are deployed in Milestone 1**, strictly *ahead* of enabling public free-tier cloud processing or high-throughput live ingest.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   ENGINEERING DEPENDENCY GRAPH                         │
└────────────────────────────────────────────────────────────────────────────────────────┘

  [MILESTONE 0: FOUNDATIONS & CONTRACTS]
  ├── Milestone 0A: Shared Contracts Package (@autoedit/contracts)
  ├── Milestone 0B: Non-Destructive Database Schema Evolution
  └── Milestone 0C: Reference Style Contracts (Proposed in ARCH-019)
         │
         ▼
  [MILESTONE 1: CLOUD WORKER FOUNDATION & QUOTA ENFORCEMENT GATE] ◄── [PREREQUISITE]
  ├── Server-Side Entitlement & Usage Reservation Engine (SAAS-009, AUTH-005)
  ├── Modal Serverless Faster-Whisper GPU (Target Benchmark: A10G Scale-to-Zero)
  └── Render Background Worker (Headless Docker with Hard Spend Limits)
         │
         ├────────────────────────────────────────┐
         ▼                                        ▼
  [MILESTONE 2: CAPTION & AUDIO POLISH]    [MILESTONE 3: LINK-FIRST INGEST & LITE ENGINE]
  ├── ASS Animated Karaoke Subtitles       ├── MediaMTX RTMP/SRT Gateway (OBS)
  └── EBU R128 Loudness Normalization      ├── Link-First Public Chat Monitor (Twitch/Kick)
         │                                 └── Deterministic LITE Sieve (EWMA Chat & Peaks)
         │                                        │
         └───────────────────┬────────────────────┘
                             │
                             ▼
  [MILESTONE 4: PRO MULTIMODAL AI & CONTENT-AWARE REFERENCE EDITING]
  ├── Faster-Whisper GPU Audio Slices & Claude/Gemini Virality Scoring (0-100)
  ├── 1-Click Lite-to-Pro Non-Destructive Upgrade Refinement (EDIT-013)
  └── Content-Aware Reference Style Transfer Engine (REF-001..REF-008)
         │
         ├────────────────────────────────────────┐
         ▼                                        ▼
  [MILESTONE 5: COMMERCIAL SAAS & BILLING] [MILESTONE 6: SOCIAL PUBLISHING AUTOMATION]
  ├── Stripe Billing (Pricing TBD Post-Beta)├── YouTube Shorts & TikTok APIs
  └── Automated Customer Invoice History   └── n8n Multi-Channel Automation Webhooks
```

---

## 2. Milestone 0: Core Architecture Foundations & Shared Contracts

- **Phasing Structure:**
  - **Milestone 0A (Shared Contracts Package):** Author `@autoedit/contracts` with strict TypeScript types, Zod schemas, discriminated unions, and tenant-aware references for media, livestreams, platform connectors, highlights, and jobs. Zero database migrations.
  - **Milestone 0B (Reviewed Database Evolution):** Generate, review, and test non-destructive Prisma schema additions (`MediaSource`, `LiveSession`, `MediaSegment`, `RetentionPolicy`, `ChatEvent`, `HighlightCandidate`) with zero-downtime safety checks before any database application.
  - **Milestone 0C (Reference Style Contracts):** Author `packages/contracts/src/reference.ts` defining schemas for `ReferenceMediaAsset`, `ReferenceStyleProfile`, `ReferenceStyleFeature`, `ReferenceStyleSelection`, `ReferenceStyleApplicationRequest`, and `StyleMatchReport`.
- **Dependencies:** None (Internal code foundation).
- **Acceptance Tests:**
  - 100% of existing automated tests continue to pass without regression.
  - API and Web builds pass with zero errors.
  - Schema diff validates with zero breaking migrations.
- **Definition of Done:** Foundations merged cleanly on feature branch without regressions.

---

## 3. Milestone 1: Cloud Worker Foundation & Critical Quota Enforcement Gate

- **Objective:** Deploy cloud worker compute and serverless Faster-Whisper with **mandatory server-side entitlement gates and durable quota accounting (`SAAS-009`, `AUTH-005`)** in place *before* any public free-tier cloud processing can run.
- **Prerequisite:** Explicit user authorization of the Stage 2 Staging Deployment Approval Gate.
- **Scope of Changes:**
  - Implement server-side Entitlement Manager and Redis-backed two-phase reservation pattern (`UsageReservation` via `SAAS-009`) preventing double-charging on worker failure.
  - Implement project count and duration quota gates (`AUTH-005`) blocking unauthorized compute dispatch.
  - Deploy `services/whisper/modal_app.py` to Modal Labs under service name `autoedit-whisper` (NVIDIA T4 / A10G scale-to-zero).
  - Deploy `apps/api/Dockerfile.worker` to Render as a dedicated background worker with `BULL_PREFIX=staging` and hard spend limits.
  - Configure production environment variables (`WHISPER_URL`, `WHISPER_SECRET`, `REDIS_URL`, `AWS_ACCESS_KEY_ID`).
  - Execute end-to-end cloud staging test with an authorized test video while developer PC worker processes are stopped.
- **Acceptance Tests:**
  - Quota Gate rejects jobs exceeding tenant allocation before enqueuing to BullMQ.
  - Upload -> BullMQ -> Render Worker -> Modal GPU Whisper -> Claude AI -> FFmpeg Render completes end-to-end in cloud.
  - Local developer worker terminal shows 0 processed jobs.
- **Rollback Approach:** Suspend Render background worker with one click; un-deploy Modal service; clear `BULL_PREFIX`.

---

## 4. Milestone 2: Audio & Caption Polish (Karaoke Subtitles & Loudnorm)

- **Objective:** Elevate exported video aesthetics to professional short-form production standards.
- **Scope of Changes:**
  - Implement ASS subtitle generator formatting word-by-word active karaoke highlight animations (`PROD-005`).
  - Integrate EBU R128 loudness filter (`loudnorm=I=-14:TP=-1.5:LRA=7`) into FFmpeg rendering pipeline (`PROD-006`).
  - Add automated voice ducking (`sidechaincompress`) for background music tracks.
- **Acceptance Tests:**
  - Rendered MP4 exhibits true-peak $\le -1.5\text{ dBTP}$ and integrated loudness within $\pm 0.5\text{ LUFS}$ of $-14\text{ LUFS}$ (benchmark target).
  - Subtitle words animate in sync with Faster-Whisper word timestamps.
- **Definition of Done:** Subtitle styles preview accurately in `VideoPreview.tsx` and burn into exported MP4.

---

## 5. Milestone 3: Link-First Livestream Ingest & LITE Clipping Engine

- **Objective:** Enable clippers and creators to paste public stream URLs or stream directly from OBS, capturing footage with rolling buffer segmentation and zero-LLM LITE highlight detection under strict quota allowances.
- **Scope of Changes:**
  - Implement **Link-First Access**: users can paste public Twitch/YouTube/Kick URLs without connecting a platform account.
  - Provision lightweight MediaMTX gateway on dedicated edge instance for direct OBS streaming (`LIVE-002`, `LIVE-003`).
  - Implement stream key generation and SHA-256 webhook authentication (`POST /api/live/auth/stream-key`).
  - Configure MediaMTX to slice incoming streams into 6-second MPEG-TS chunks and sync to S3 (`LIVE-005`).
  - Implement rolling buffer cleanup cron purging unpinned chunks older than 30 minutes (configurable pilot buffer), preserving chunks with active reference-counted pin leases (`SegmentPinReference`).
  - Implement Cloud Chat Monitor for public Twitch IRC and Kick Pusher WebSockets (`LIVE-006`).
  - Author the **LITE Detection Engine** (`LIVE-015`): sliding EWMA chat velocity, emote surge scoring (`KEKW`, `POG`), and FFmpeg `silencedetect` audio peaks generating highlight candidates at $0.00 AI inference cost.
- **Acceptance Tests:**
  - Public livestream URL loads chat spike timeline without requiring user platform login.
  - OBS connects to `rtmps://ingest.autoedit.ai/live` using valid stream key and streams for 30 minutes without dropped frames.
  - Simulated chat surge (+400% msgs/sec) flags LITE candidate highlight within target 2 seconds of occurrence at zero AI cost.
  - Chunks stream into S3; unpinned chunks auto-delete after window expires.
- **Definition of Done:** Stream sessions and LITE highlights appear in real time on the dashboard and web studio.

---

## 6. Milestone 4: PRO Multimodal AI Engine, Upgrade Refinement & Content-Aware Reference Editing

- **Objective:** Augment LITE candidate clusters with Faster-Whisper GPU transcription, Claude/Gemini semantic reasoning, 1-click in-studio upgrade refinement, and content-aware reference style transfer.
- **Scope of Changes:**
  - Connect Modal Faster-Whisper serverless GPU to transcribe prioritized highlight candidate audio windows.
  - Author Multi-Agent LLM reasoning pipeline (Director, Hook, Social Copy agents) delivering 0–100 virality scores and explainable editorial strategies.
  - Implement **Lite-to-Pro Upgrade Refinement** (`EDIT-013`): in-studio 1-click upgrade that extracts segment audio, runs GPU/LLM analysis, and non-destructively attaches word-level transcripts and hooks without altering manual trims.
  - Implement **Content-Aware Reference-Based AI Editing Engine** (`REF-001` through `REF-008`):
    - Stage A: FFmpeg cut pacing (ASL), keyframe OCR subtitle typography, and Sha-256 Redis profile cache.
    - Stage B: Content-Aware mapping engine that snaps cut intervals to speech pauses ($\pm 0.35\text{s}$ tolerance), aligns punch zooms with acoustic volume surges, and maps reference hook structure onto source video narrative arcs.
    - 4-Tier Conflict Resolution: Manual Pinned Edits > Prompt Overrides > Reference Profile > Auto Baseline.
    - Studio UI: Style match report drawer, attribute toggles, and instant HTML5 canvas preview.
  - Calibrate heuristic signal weight vectors against empirical creator datasets across gaming, podcast, and tutorial genres.
  - Dynamic context expansion (pre-roll setup and post-roll resolution).
- **Acceptance Tests:**
  - PRO pipeline produces word-level timestamps, virality score, and 3 platform-optimized hooks for flagged candidate.
  - Upgrading an existing LITE clip produces an immutable new `EditVersion` snapshot with word-level subtitles while retaining user trim offsets.
  - Applying a 30s reference video adapts to source speech boundaries without cutting words mid-phoneme.
- **Definition of Done:** Creators can freely combine AUTO highlights, REFERENCE style transfer, PROMPT refinements, and MANUAL trims within one unified studio timeline.

---

## 7. Milestone 5: Commercial SaaS Monetization & Stripe Billing

- **Objective:** Transform AutoAI Edit into a commercially viable SaaS product with automated billing and self-serve tier upgrades.
- **Scope of Changes:**
  - Integrate Stripe Billing (Free/LITE, Creator PRO, Streamer PRO — retail prices TBD post-beta telemetry).
  - Connect Stripe webhooks for subscription creation, upgrades, cancellations, and payment failures.
  - Add user billing portal and invoice history in `/settings`.
- **Acceptance Tests:**
  - Stripe webhook creates and updates subscription records reliably.
  - Plan upgrade immediately refreshes tenant entitlements in Redis and expands monthly export limits.
- **Definition of Done:** End-to-end checkout, upgrade, and invoice management verified via Stripe test mode with zero double-charge risk.

---

## 8. Milestone 6: Automated Social Publishing & Creator Workflows

- **Objective:** Enable one-click or automated scheduled publishing of rendered clips to social platforms.
- **Scope of Changes:**
  - Integrate YouTube Data API v3 for direct Shorts uploads with AI-generated titles and tags (`PUB-004`).
  - Integrate TikTok Content Posting API (`PUB-005`).
  - Enhance n8n webhook integration (`PUB-001`) with customizable trigger rules.
  - Build scheduled release calendar in dashboard.
- **Acceptance Tests:**
  - Rendered clip successfully publishes to authorized test YouTube Shorts channel with correct title and privacy status.
- **Definition of Done:** End-to-end creation, AI clipping, rendering, and publishing completed without manual file downloading.
