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

## 2. Key Product & Architectural Decisions Requiring User Choice

The following 5 strategic decisions are presented for creator and executive alignment before proceeding to code implementation:

### Question 1: Ingestion Priority for Initial Beta (OBS vs. Twitch VOD Import)
- **Option A (Recommended):** Prioritize **Path B (Direct OBS Ingest via MediaMTX)**. This provides 100% control over raw 1080p60 video quality, real-time chunking, and zero platform API limitations.
- **Option B:** Prioritize **Path A (Completed Twitch/YouTube VOD URL import)**. This is simpler for creators who already stream, but is constrained by platform API restrictions on direct video downloads.

### Question 2: Subtitle Aesthetic & Typography Standards
- **Option A (Recommended):** High-contrast modern **Karaoke Animated Subtitles** (Montserrat ExtraBold, high-contrast yellow/white fill with black stroke, active word highlight animation matching speech cadence).
- **Option B:** Clean Minimalist Static Subtitles (Subtle bottom captions without animation, preferred for corporate or educational podcasts).

### Question 3: Live Buffer Retention Window
- **Option A (Recommended):** **90-minute rolling buffer** for live broadcasts. Unpinned chunks older than 90m are purged to minimize S3 storage costs.
- **Option B:** Full stream retention (Keep all 6 hours of raw chunks). Increases storage costs by ~$0.30 per stream.

### Question 4: Primary AI Model Tiering
- **Option A (Recommended):** **Anthropic Claude 3.5 Sonnet** as primary reasoning engine with deterministic rule-based fallback. Delivers the highest editorial humor, narrative coherence, and hook quality.
- **Option B:** Self-hosted open-weight LLM (e.g. Qwen 3:8B or Llama 3 on Modal GPU). Eliminates Anthropic API dependencies, but requires managing GPU inference cold starts and delivers slightly lower editorial reasoning quality.

### Question 5: SaaS Packaging & Free Tier Strategy
- **Option A (Recommended):** **Freemium with Watermark & Resolution Cap** (Free tier allows 2 exports/month with subtle "AutoAI Edit" corner watermark; $29/mo Creator tier unlocks watermark-free 1080p exports and live OBS ingest).
- **Option B:** 7-Day Free Trial (Full access for 7 days, then credit card required).
