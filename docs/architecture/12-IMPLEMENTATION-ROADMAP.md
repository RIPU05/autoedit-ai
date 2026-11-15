# AUTOAI EDIT — IMPLEMENTATION ROADMAP & MILESTONE SPECIFICATION

**Document ID:** ARCH-012  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Engineering Roadmap & Project Management Plan

---

## 1. Dependency Graph & Critical Path

The AutoAI Edit engineering roadmap is sequenced to maximize code reuse, preserve existing working functionality, and eliminate premature infrastructure spending:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   ENGINEERING DEPENDENCY GRAPH                         │
└────────────────────────────────────────────────────────────────────────────────────────┘

  [MILESTONE 0: FOUNDATIONS & CONTRACTS]
  ├── Shared TypeScript Contracts & Schemas
  └── Prisma Schema Extensions (Non-destructive)
         │
         ▼
  [MILESTONE 1: CLOUD WORKER & GPU DEPLOYMENT] ◄── [PREREQUISITE: STAGE 2 APPROVAL]
  ├── Modal Serverless Faster-Whisper GPU
  └── Render Background Worker (Headless Docker)
         │
         ├────────────────────────────────────────┐
         ▼                                        ▼
  [MILESTONE 2: CAPTION & AUDIO POLISH]    [MILESTONE 3: LIVE STREAM INGEST (OBS)]
  ├── ASS Animated Karaoke Subtitles       ├── MediaMTX RTMP/SRT Gateway
  └── EBU R128 Loudness Normalization      └── 6-Second Rolling Chunk Buffer
         │                                        │
         ▼                                        ▼
  [MILESTONE 4: MULTIMODAL HIGHLIGHT ENGINE & CHAT SPIKE DETECTOR]
  ├── Twitch / YouTube Live Chat Listeners
  └── Unified Highlight Candidate Ranking
         │
         ├────────────────────────────────────────┐
         ▼                                        ▼
  [MILESTONE 5: SAAS BILLING & QUOTAS]     [MILESTONE 6: SOCIAL PUBLISHING AUTOMATION]
  ├── Stripe Tiered Subscription Plans     ├── YouTube Shorts & TikTok APIs
  └── Video Minute Usage Metering          └── n8n Multi-Channel Automation
```

---

## 2. Milestone 0: Core Architecture Foundations & Shared Contracts

- **Objective:** Consolidate shared data types, validation schemas, and database definitions into a clean foundation before introducing new streaming microservices.
- **Scope of Changes:**
  - Create `packages/shared` or unified contracts module for timeline JSON schemas, queue payloads, and chat event types.
  - Implement non-destructive Prisma schema additions (`MediaSource`, `LiveSession`, `MediaSegment`, `ChatEvent`, `HighlightSignal`, `HighlightCandidate`).
  - Add strict Zod validation schemas for all incoming API payloads.
- **Dependencies:** None (Internal code refactoring).
- **Acceptance Tests:**
  - 100% of existing 51 automated tests continue to pass.
  - API TypeScript build passes with zero errors.
  - Schema diff validates with zero breaking migrations.
- **Definition of Done:** Foundations merged cleanly on feature branch without regressions.

---

## 3. Milestone 1: Cloud Worker & Serverless Whisper Production Deployment

- **Objective:** Achieve complete cloud independence, allowing users to upload and process videos entirely on cloud infrastructure without requiring the developer's workstation.
- **Prerequisite:** Explicit user authorization of the Stage 2 Staging Deployment Approval Gate.
- **Scope of Changes:**
  - Deploy `services/whisper/modal_app.py` to Modal Labs under service name `autoedit-whisper`.
  - Deploy `apps/api/Dockerfile.worker` to Render as a dedicated background worker with `BULL_PREFIX=staging`.
  - Configure production environment variables (`WHISPER_URL`, `WHISPER_SECRET`, `REDIS_URL`, `AWS_ACCESS_KEY_ID`).
  - Execute end-to-end cloud staging test with an authorized 15-second test video while developer PC worker processes are stopped.
- **Acceptance Tests:**
  - Upload -> BullMQ -> Render Worker -> Modal GPU Whisper -> Claude AI -> FFmpeg Render completes end-to-end in cloud.
  - Local worker terminal shows 0 processed jobs.
- **Rollback Approach:** Suspend Render background worker with one click; un-deploy Modal service; clear `BULL_PREFIX`.

---

## 4. Milestone 2: Audio & Caption Polish (Karaoke Subtitles & Loudnorm)

- **Objective:** Elevate exported video aesthetics to professional short-form production standards.
- **Scope of Changes:**
  - Implement ASS subtitle generator formatting word-by-word active karaoke highlight animations (`PROD-005`).
  - Integrate EBU R128 loudness filter (`loudnorm=I=-14:TP=-1.5:LRA=7`) into FFmpeg rendering pipeline (`PROD-006`).
  - Add automated voice ducking (`sidechaincompress`) for background music tracks.
- **Acceptance Tests:**
  - Rendered MP4 exhibits true-peak $\le -1.5\text{ dBTP}$ and integrated loudness within $\pm 0.5\text{ LUFS}$ of $-14\text{ LUFS}$.
  - Subtitle words animate in sync with Faster-Whisper word timestamps.
- **Definition of Done:** Subtitle styles preview accurately in `VideoPreview.tsx` and burn into exported MP4.

---

## 5. Milestone 3: Real-Time Livestream Ingest & Direct OBS Gateway

- **Objective:** Enable creators to stream directly from OBS into AutoAI Edit with rolling buffer segmentation.
- **Scope of Changes:**
  - Provision lightweight MediaMTX gateway on dedicated edge instance (`LIVE-002`, `LIVE-003`).
  - Implement stream key generation and SHA-256 webhook authentication (`POST /api/live/auth/stream-key`).
  - Configure MediaMTX to slice incoming streams into 6-second MPEG-TS chunks and sync to S3 (`LIVE-005`).
  - Implement rolling buffer cleanup cron purging unpinned chunks older than 90 minutes.
- **Acceptance Tests:**
  - OBS connects to `rtmps://ingest.autoedit.ai/live` using valid stream key and streams for 30 minutes without dropped frames.
  - Chunks stream into S3; unpinned chunks auto-delete after window expires.
- **Definition of Done:** Stream sessions appear in real time on the dashboard.

---

## 6. Milestone 4: Multimodal Highlight Engine & Chat Spike Detector

- **Objective:** Unify chat velocity, audio peaks, and transcript context into automated highlight candidate proposals.
- **Scope of Changes:**
  - Implement Twitch IRC and YouTube Live chat WebSocket listeners (`LIVE-006`).
  - Author sliding-window chat velocity detector (`VOD-004`) and emote surge analyzer (`VOD-005`).
  - Implement composite scoring equation combining chat, audio, and speech density.
  - Add dynamic context expansion (pre-roll setup and post-roll resolution).
  - Surface highlight candidate cards in Studio UI with 1-click preview and render.
- **Acceptance Tests:**
  - Simulated chat surge (+400% msgs/sec) flags candidate highlight within 2 seconds of occurrence.
  - Candidates display transparent Explainable AI narrative in Studio UI.
- **Definition of Done:** Highlighting operates identically for both live broadcasts and uploaded VODs.

---

## 7. Milestone 5: SaaS Monetization, Usage Metering & Quotas

- **Objective:** Transform AutoAI Edit into a commercially viable SaaS product with automated billing.
- **Scope of Changes:**
  - Integrate Stripe Billing (Free, Creator $29/mo, Pro $79/mo).
  - Implement video processing minute tracking (`SAAS-002`) and usage metering.
  - Enforce tiered feature gates (export resolution caps, max monthly minutes).
  - Add user billing portal and invoice history in `/settings`.
- **Acceptance Tests:**
  - Stripe webhook creates and updates subscription records reliably.
  - Users exceeding monthly minute quotas receive upgrade prompt before queuing renders.
- **Definition of Done:** End-to-end checkout, upgrade, and quota enforcement verified via Stripe test mode.

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
