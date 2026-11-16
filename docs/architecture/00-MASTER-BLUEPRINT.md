# AUTOAI EDIT — MASTER PRODUCT & SYSTEM ARCHITECTURE BLUEPRINT

**Document ID:** ARCH-000  
**Version:** 1.0.0-PROD  
**Status:** Approved for Architectural Review (Stage 1 Complete)  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Production Deployment:** `https://autoedit-ai.vercel.app/` | `https://autoedit-ai.onrender.com/`  
**Branch:** `docs/autoai-master-blueprint`

---

## 1. Executive Summary & Vision

**AutoAI Edit** is an enterprise-grade, cloud-native content automation platform that transforms raw video content—both pre-recorded long-form videos (podcasts, tutorials, interviews) and live interactive broadcasts (Twitch, YouTube, Kick, direct OBS streams)—into high-engagement, publishable short-form video assets (YouTube Shorts, Instagram Reels, TikTok, LinkedIn clips).

The central design breakthrough of AutoAI Edit is **a unified media and event processing paradigm**: live broadcasts and pre-recorded uploads share the exact same underlying timeline representation, editing primitives, caption generators, AI ranking models, and cloud rendering pipelines. Whether a creator streams for 4 hours via OBS or uploads a 1-hour 4K MP4 file, the system converts incoming media into time-synchronized evidence streams (transcripts, audio excitement, chat activity, visual scene changes) and presents the creator with a non-destructive, explainable editorial timeline that can be previewed instantly and rendered across multiple aspect ratios on demand.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    AUTOAI EDIT UNIFIED PIPELINE                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
   ┌───────────────────────┐   ┌───────────────────────┐   ┌───────────────────────┐
   │  Direct File Upload   │   │  Platform VOD Import  │   │  Live Stream Ingestion│
   │  (S3 Multipart Chunk) │   │ (Twitch/YouTube/Kick) │   │ (OBS via RTMP/RTMPS)  │
   └───────────┬───────────┘   └───────────┬───────────┘   └───────────┬───────────┘
               │                           │                           │
               ▼                           ▼                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │                     UNIFIED MEDIA & EVENT TIMELINE (EPOCH-BASED)              │
   │  [Media Segments] + [Faster-Whisper Transcripts] + [Chat Events] + [Audio/CV] │
   └───────────────────────────────────────┬───────────────────────────────────────┘
                                           │
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │                     MULTIMODAL AI HIGHLIGHT ENGINE (CLAUDE/OLLAMA)            │
   │      Chat Velocity Spike + Hook Detection + Semantic Context + Excitement     │
   └───────────────────────────────────────┬───────────────────────────────────────┘
                                           │
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │                     STUDIO EDITOR (CORE PRODUCT INVARIANTS)                   │
   │  1. Instant Preview Edit   2. Explainable AI Narrative   3. Version History   │
   └───────────────────────────────────────┬───────────────────────────────────────┘
                                           │
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │               HYBRID CLOUD RENDERING & PUBLISHING (FFMPEG + N8N)              │
   │  9:16 Vertical Reframing + Animated Captions + Cloud Distribution (Shorts/Reel│
   └───────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Non-Negotiable Core Product Invariants

The entire system architecture is anchored around three non-negotiable user experience capabilities that have been proven in previous releases and must remain intact across all future milestones:

### 1. Instant Preview Edit (`EDIT-001`)
- **Principle:** Creators must never wait for an expensive cloud FFmpeg re-render simply to evaluate an edit decision.
- **Contract:** The client studio player dynamically translates the `EditTimeline` operations JSON (`cut`, `keep`, `zoom`, `speed`, `mute`) in real time using HTML5 media events, seamless timeline seeking, and SVG subtitle overlays over the raw source video. Cloud rendering is strictly reserved for the final export.

### 2. Explainable AI (`EDIT-002`)
- **Principle:** Content creators will not trust "black box" automated cuts.
- **Contract:** Every AI-recommended clip, silence cut, and editorial decision is accompanied by a transparent narrative:
  - *Editorial Strategy:* Why this segment forms a cohesive narrative arc.
  - *Hook Score & Mechanism:* The exact hook sentence, timestamp, and psychological hook mechanism (curiosity gap, controversial statement, shocking data).
  - *Evidence Tracing:* The exact trigger signals (e.g., "+340% chat velocity surge", "peak audio excitement 88dB", "speech pacing 190 WPM").

### 3. Non-Destructive Version History (`EDIT-003`)
- **Principle:** Editing is an iterative, non-linear creative process. No edit may ever overwrite or destroy original media or earlier work.
- **Contract:** Every prompt-based edit ("Make it faster", "Focus on the debate"), manual timeline trim, or AI regeneration appends an immutable `EditVersion` record to a tree-structured snapshot graph. Creators can revert to earlier versions, fork alternate cuts, or compare A/B versions side by side with zero risk of data loss.

---

## 3. High-Level Architectural Principles

1. **Monolithic Core with Serverless GPU Acceleration & Cloud Flexibility:**
   - Business logic, REST endpoints, project management, and queue orchestration reside in a unified Node.js / Express backend (`apps/api`) and a Next.js 14 frontend (`apps/web`).
   - High-throughput video transcoding and silence detection run in isolated containerized background workers (`apps/api/Dockerfile.worker`).
   - Heavy machine learning inference (Faster-Whisper transcription) is delegated to serverless GPU containers on Modal Labs (`services/whisper/modal_app.py`), running NVIDIA T4 GPUs that scale to zero when idle ($0.00 idle cost).
   - While Render, Modal, and Upstash form the primary reference implementation due to validated staging proofs, compute contracts remain vendor-agnostic (supporting Oracle Cloud ARM, Hetzner, AWS, or RunPod).

2. **Unified Data Abstraction & Single Studio Experience:**
   - Both uploaded MP4 files and live RTMP streams decompose into discrete, addressable `MediaSegment` records tied to an immutable `MediaSource`.
   - Creators work within **One Unified Studio**: live streams and pre-recorded VODs share the exact same visual editor, non-destructive timeline, and explainable AI narrative drawer.
   - Time is indexed via epoch-normalized millisecond offsets, guaranteeing that stream interruptions, network jitter, and late chat messages synchronize precisely with video frames.

3. **Multi-Tenant Isolation & Zero Secret Leakage:**
   - Redis queues use dynamic namespacing (`BULL_PREFIX=staging` vs `BULL_PREFIX=bull`) to ensure test jobs never interfere with production customer workloads.
   - S3 objects are protected with presigned URLs and user-scoped path prefixes (`users/{userId}/projects/{projectId}/*`).
   - Third-party OAuth tokens (Twitch, YouTube, Kick, Claude, n8n) are encrypted at rest using AES-256-GCM.

4. **Cloud Independence:**
   - The platform operates 100% in the cloud without requiring the developer's workstation or any local GPU. When a creator uploads a video or broadcasts a stream, the cloud backend handles ingestion, analysis, AI clipping, rendering, and storage end-to-end.

5. **Dual Processing Architecture (LITE vs PRO Modes):**
   - The platform delivers both **LITE Mode** (cost-effective, high-velocity deterministic signal processing via chat EWMA and audio peaks at ~$0.03/clip) and **PRO Mode** (deep multimodal AI with Faster-Whisper GPU transcription, Gemini/Claude narrative reasoning, and animated karaoke captions at ~$0.13/clip) inside ONE unified application without code bifurcation.
   - Highlights generated in LITE mode can be non-destructively refined with PRO AI on demand without losing manual edits.

6. **Empirical Calibration & Flexible Pricing:**
   - Heuristic thresholds (chat velocity multipliers, audio loudness gates, clip duration clamping) serve as engineering baselines that will be empirically calibrated against ground-truth creator data in Milestone 4.
   - Subscription pricing, free-tier quotas, and retail packaging remain undecided pending measured unit economics and abuse controls in beta.

---

## 4. Master Blueprint Directory Roadmap

The complete architecture specification is partitioned into 19 focused, cross-referenced documents within `docs/architecture/`:

| Document ID | File Name | Focus & Scope |
|---|---|---|
| **ARCH-001** | [`01-EXISTING-SYSTEM-AUDIT.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/01-EXISTING-SYSTEM-AUDIT.md) | Exhaustive audit of existing code, branches, database models, and test matrices. |
| **ARCH-002** | [`02-COMPLETE-FEATURE-INVENTORY.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/02-COMPLETE-FEATURE-INVENTORY.md) | Itemized catalog of 94 product features across Categories A through J with stable IDs. |
| **ARCH-003** | [`03-APPLICATION-SCREENS-AND-UX.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/03-APPLICATION-SCREENS-AND-UX.md) | UX workflows, component hierarchies, loading/empty/error states for all 18+ application screens. |
| **ARCH-004** | [`04-SERVICES-AND-API-CONTRACTS.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/04-SERVICES-AND-API-CONTRACTS.md) | Complete REST & WebSocket API schemas, BullMQ payload contracts, and error structures. |
| **ARCH-005** | [`05-DATA-MODEL-AND-EVENT-TIMELINE.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/05-DATA-MODEL-AND-EVENT-TIMELINE.md) | Unified relational Prisma schema, event models, time synchronization, and diffs. |
| **ARCH-006** | [`06-LIVESTREAM-INGESTION-ARCHITECTURE.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/06-LIVESTREAM-INGESTION-ARCHITECTURE.md) | Direct RTMP/SRT ingestion via MediaMTX, OBS setup, platform APIs, rolling chunks. |
| **ARCH-007** | [`07-AI-HIGHLIGHT-ENGINE.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/07-AI-HIGHLIGHT-ENGINE.md) | Multimodal scoring algorithms combining chat spikes, acoustics, speech, and LLM reasoning. |
| **ARCH-008** | [`08-EDITING-AND-RENDERING.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/08-EDITING-AND-RENDERING.md) | Studio timeline engine, non-destructive version tree, FFmpeg filtergraphs, 9:16 reframing. |
| **ARCH-009** | [`09-CLOUD-INFRASTRUCTURE.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/09-CLOUD-INFRASTRUCTURE.md) | Hybrid topology (Render, Modal, Upstash, AWS S3/R2), containers, and resource sizing. |
| **ARCH-010** | [`10-SECURITY-RELIABILITY-COSTS.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/10-SECURITY-RELIABILITY-COSTS.md) | Auth, OAuth, stream key safety, circuit breakers, idempotency, and unit economics. |
| **ARCH-011** | [`11-SCALABILITY-ROADMAP.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/11-SCALABILITY-ROADMAP.md) | Scaling path from MVP (10 users) to Creator Beta (500 users) to Production (10,000 streams). |
| **ARCH-012** | [`12-IMPLEMENTATION-ROADMAP.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/12-IMPLEMENTATION-ROADMAP.md) | Phased delivery schedule (Milestones 0 through 6) with definitions of done and rollback plans. |
| **ARCH-013** | [`13-ARCHITECTURE-DECISIONS-AND-OPEN-QUESTIONS.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/13-ARCHITECTURE-DECISIONS-AND-OPEN-QUESTIONS.md) | Architectural Decision Records (ADRs 001–008) and product questions requiring user input. |
| **ARCH-014** | [`14-VERIFICATION-MATRIX.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/14-VERIFICATION-MATRIX.md) | End-to-end traceability matrix linking features, data models, APIs, screens, and tests. |
| **ARCH-015** | [`15-BLUEPRINT-REVIEW-AND-APPROVAL.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/15-BLUEPRINT-REVIEW-AND-APPROVAL.md) | Formal architecture sign-off, feature inventory reconciliation (94 features), and stage transition gates. |
| **ARCH-016** | [`16-SHARED-CONTRACTS-IMPLEMENTATION.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/16-SHARED-CONTRACTS-IMPLEMENTATION.md) | Reusable domain contracts package (`@autoedit/contracts`) specification and runtime validation. |
| **ARCH-017** | [`17-COMPETITIVE-ANALYSIS-AND-RESEARCH-REGISTER.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/17-COMPETITIVE-ANALYSIS-AND-RESEARCH-REGISTER.md) | Competitive benchmark (Stakeout Clips, StreamLadder, Opus Clip) and cloud-first positioning. |
| **ARCH-018** | [`18-LITE-AND-PRO-PROCESSING-ARCHITECTURE.md`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/18-LITE-AND-PRO-PROCESSING-ARCHITECTURE.md) | Dual-tier processing specification (LITE deterministic vs PRO multimodal AI), quotas, and upgrade refinement. |
