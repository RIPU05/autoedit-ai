# AUTOAI EDIT — ARCHITECTURE DECISION RECORDS (ADRS) & OPEN QUESTIONS

**Document ID:** ARCH-013  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Architectural Governance & Strategic Decisions

---

## 1. Architectural Decision Records (ADRs 001–008)

### ADR-001: Hybrid Compute Topology (Render CPU + Modal Serverless GPU)
- **Status:** **APPROVED & IMPLEMENTED IN STAGING**
- **Context:** AutoAI Edit requires continuous queue listening, FFmpeg CPU rendering, and GPU machine learning transcription. Provisioning a dedicated cloud GPU instance (e.g. AWS `g4dn.xlarge` @ $380/mo or RunPod @ $150/mo) creates high fixed costs even when zero videos are being processed.
- **Decision:** Decouple workloads. Run continuous background workers on inexpensive Render CPU instances ($25/mo) and execute Faster-Whisper transcription on Modal Labs serverless NVIDIA T4 GPUs ($0.59/compute-hour, billed per millisecond, scale-to-zero in 60s).
- **Consequences:** Slashes fixed monthly compute overhead by >80%; absorbs first 2,500 monthly transcriptions within Modal's $30 recurring free tier credit; incurs minor cold-start latency (~1.5s).

---

### ADR-002: Virtual Client-Side Preview vs. Server Transcoding
- **Status:** **APPROVED & CORE INVARIANT (`EDIT-001`)**
- **Context:** Creators need immediate feedback after trimming or adjusting timeline cuts. Rendering a 60-second vertical video with burned-in subtitles on a cloud CPU takes 20–30 seconds.
- **Decision:** The Studio editor (`VideoPreview.tsx`) virtually renders cuts in real time directly in the client browser using HTML5 media events, seamless time seeking, and SVG subtitle overlays over raw source media. Server FFmpeg rendering is deferred exclusively to the final user-approved export.
- **Consequences:** Delivers 0-second editing latency; eliminates cloud compute costs during the creative editing phase; requires modern client browser with H.264 MP4 playback support.

---

### ADR-003: Tree-Structured Immutable Version History
- **Status:** **APPROVED & CORE INVARIANT (`EDIT-003`)**
- **Context:** Destructive in-place database mutations risk accidental data loss when creators experiment with radical prompt-based edits ("Make it hyper-fast", "Cut out the guest").
- **Decision:** Model timeline state as an immutable tree graph (`EditVersion`). Every edit appends a new version snapshot referencing its parent version (`parentVersionId`). Restoring a past version activates the snapshot without deleting descendant nodes.
- **Consequences:** Zero risk of creative work destruction; supports instant A/B timeline comparison and multi-path branching; requires modest JSON storage in PostgreSQL.

---

### ADR-004: Direct MediaMTX Gateway vs. Third-Party Video PaaS (Mux / Livepeer)
- **Status:** **PROPOSED FOR STAGE 2 (`LIVE-002`)**
- **Context:** AutoAI Edit requires direct access to 6-second video chunks for rolling highlight analysis. Commercial live streaming PaaS providers (e.g. Mux Video) charge high per-minute ingestion and storage fees ($0.07/minute = $25.20 for a single 6-hour stream) and restrict direct raw chunk access.
- **Decision:** Deploy an open-source MediaMTX gateway on a lightweight edge instance. Ingest RTMP/SRT directly from OBS, slice into 6-second MPEG-TS chunks, and store in S3/R2 with automated rolling buffer cleanup.
- **Consequences:** Reduces ingestion costs by >90%; provides frame-accurate chunk timestamps; requires managing a dedicated MediaMTX edge service.

---

### ADR-005: Serverless Faster-Whisper on GPU vs. Third-Party APIs (Deepgram / AssemblyAI)
- **Status:** **APPROVED (`AI-004`)**
- **Context:** Managed transcription APIs (AssemblyAI, Deepgram, OpenAI Whisper API) charge $0.25 to $0.90 per audio hour ($1.50–$5.40 for a 6-hour stream).
- **Decision:** Self-host CTranslate2-accelerated Faster-Whisper on Modal NVIDIA T4 GPUs. An NVIDIA T4 transcribes an audio hour in ~72 seconds, costing **$0.0118** in compute.
- **Consequences:** Reduces transcription costs by >95%; provides full control over word-level timestamp accuracy and Hinglish vocabulary; eliminates third-party vendor lock-in.

---

### ADR-006: Tiered Multimodal Highlight Sieve vs. Continuous LLM Ingestion
- **Status:** **PROPOSED (`AI-xxx`)**
- **Context:** Feeding all 360 minutes of a 6-hour stream transcript directly into Claude 3.5 Sonnet consumes hundreds of thousands of tokens, costing $15–$30 per video and exceeding rate limits.
- **Decision:** Filter stream audio and chat through a 3-tier multimodal sieve. Use fast deterministic math (chat velocity spikes + audio loudness peaks) to eliminate 85% of dead air; run Faster-Whisper on candidate regions; pass only the top 5% candidate transcripts to Claude for viral hook extraction and editorial reasoning.
- **Consequences:** Keeps Claude API costs under $0.10–$0.28 per multi-hour stream while preserving high editorial intelligence.

---

### ADR-007: Dynamic Queue Namespacing (`BULL_PREFIX`) for Staging Isolation
- **Status:** **APPROVED & IMPLEMENTED IN STAGING (`INFRA-002`)**
- **Context:** Testing new worker Docker containers or streaming pipelines against a shared Redis instance risks staging workers pulling and corrupting production customer jobs.
- **Decision:** Enforce dynamic prefix isolation across all BullMQ queues and workers via `env.BULL_PREFIX` (e.g. `staging:analysis` vs `bull:analysis`).
- **Consequences:** Guarantees 100% queue isolation; enables safe staging verification on shared Redis clusters without provisioning duplicate Redis instances.

---

### ADR-008: Cloudflare R2 Object Storage for Zero-Egress Media Distribution
- **Status:** **PROPOSED FOR PRODUCTION SCALE (`INFRA-xxx`)**
- **Context:** Ingesting 6-hour streams and serving high-bitrate video clips from AWS S3 incurs standard AWS egress fees ($0.09 per GB), which compound rapidly at scale.
- **Decision:** Utilize Cloudflare R2 (or Wasabi) for media chunks and client video playback while maintaining AWS S3 compatibility via standard S3 SDKs.
- **Consequences:** Eliminates egress transfer fees completely ($0.00 egress); reduces monthly bandwidth overhead at scale.

---

## 2. Resolved Product & Architecture Decisions (Decisions A through L)

The core architectural direction for AutoAI Edit has been formally established and locked:

### Decision A: Studio Unification
- **Resolution:** **One Unified Studio**. Creators do not use disjoint tools for live streams vs. pre-recorded videos. Both live broadcasts and VOD uploads share the identical timeline engine, non-destructive editing primitives, and explainable AI narrative drawer.

### Decision B: Ingestion Topology (Both are First-MVP Requirements)
- **Resolution:** Both **Direct OBS Ingest (Path B)** and **Connected Platforms (Path A)** are core MVP requirements.
- **Phasing:** Path B (OBS via MediaMTX) is implemented first to establish deterministic low-latency chunking and timestamp synchronization. Path A (Twitch/YouTube/Kick chat and stream status) follows immediately to pair chat excitement with the broadcast video.

### Decision C: Caption & Subtitle Aesthetic
- **Resolution:** **Multiple Caption Styles Supported in MVP**. Both high-contrast animated **Karaoke Subtitles** (active word highlight tracking speech cadence for TikTok/Reels) and **Clean Minimalist Subtitles** (static crisp typography with subtle translucent backing for educational/podcasts) are supported as first-class presets.

### Decision D: Live Rolling Buffer Retention
- **Resolution:** **30-Minute Rolling Buffer Pilot** (updated from 90m). Unpinned chunks older than 30 minutes are automatically purged during live broadcasts to eliminate unnecessary cloud storage fees during beta testing. Retention is configurable per user tier.

### Decision E: Segment Pinning
- **Resolution:** **Supported (`LIVE-010`)**. Chunks associated with flagged highlight candidates or creator bookmarks are pinned (`isPinned: true`) and permanently retained, completely exempt from rolling buffer purging.

### Decision F: Replayable Evidence Timeline
- **Resolution:** **Mandatory Core Requirement**. Every AI highlight references exact audio/visual/chat evidence with millisecond timestamps, chat surge percentages, and acoustic metrics, allowing creators to inspect why each clip was chosen.

### Decision G: Model-Independent AI Gateway
- **Resolution:** **Vendor-Agnostic Adapter Pattern**. The system interfaces with an abstract `AiGateway` provider. While Claude 3.5 Sonnet serves as the primary reasoning engine, pluggable adapters support Google Gemini, OpenAI GPT-4o, and self-hosted open-weight LLMs (Ollama/vLLM), with deterministic fallback.

### Decision H: Cloud Provider Flexibility
- **Resolution:** **Strict Protocol Decoupling**. Core services communicate via standard Docker containers, standard Redis protocols, and S3-compatible APIs. Compute workloads can migrate seamlessly between Render, Oracle Cloud ARM instances, Hetzner, AWS, or RunPod without vendor lock-in.

### Decision I: Undecided Subscription Pricing & Packaging
- **Resolution:** **Undecided Pending Empirical Calibration**. Unit economics are modeled as engineering projections. Retail SaaS pricing, free-tier quotas, and packaging remain undecided until empirical costs and abuse controls are measured during the beta.

### Decision J: Non-Negotiable Core Invariants
- **Resolution:** **Strictly Preserved**. Instant Preview Edit (`EDIT-001`), Explainable AI (`EDIT-002`), and Non-Destructive Version History (`EDIT-003`) must never be degraded or broken.

### Decision K: Queue Isolation & Multi-Tenancy
- **Resolution:** **Dynamic Namespacing (`BULL_PREFIX`)**. Enforces 100% queue isolation between staging and production environments on shared Redis clusters.

### Decision L: Security & BOLA Protection
- **Resolution:** **Zero Secret Git Policy & BOLA Session Verification**. All third-party tokens encrypted with AES-256-GCM; all upload sessions and media access guarded by database ownership checks.

---

## 3. Genuine Remaining Open Decisions (Deferred to Empirical Beta)

The following operational questions will be evaluated using real creator telemetry during Milestone 4 and Milestone 5:

1. **Open Decision 1: Retail SaaS Tier Pricing & Free-Tier Abuse Limits**
   - *Status:* Deferred to Milestone 5.
   - *Plan:* Collect real compute cost data per user during the closed creator pilot before publishing commercial plan rates.
2. **Open Decision 2: Edge Transcoder Hardware Acceleration (NVENC vs CPU)**
   - *Status:* Deferred to Milestone 3/4.
   - *Plan:* Monitor CPU utilization on MediaMTX edge instances. If concurrent live broadcasts exceed 50 streams, evaluate provisioning GPU-accelerated NVENC transcode nodes.
3. **Open Decision 3: Default Ingestion Protocol for Creators (SRT vs RTMPS)**
   - *Status:* Deferred to Milestone 3 beta onboarding.
   - *Plan:* Both protocols are implemented in MediaMTX; creator feedback during beta onboarding will determine which protocol is highlighted as the primary recommended default in the UI.
