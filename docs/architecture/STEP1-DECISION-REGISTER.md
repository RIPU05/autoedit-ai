# AutoAI Edit — Step 1: Architecture Decision Register (ADR)

**Document ID:** ADR-STEP1-001  
**Version:** 1.0.0-PROD  
**Status:** Approved for Implementation Governance  
**Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Master Commit SHA:** `f77d5ba498a43536dd0723b5eb85e169384ace34`  
**Target Branch:** `docs/step1-architecture-audit-roadmap`  

---

## 1. Overview & Governance

This Architecture Decision Register (ADR) captures the definitive architectural decisions, preserved invariants, and trade-off rationales governing the development of AutoAI Edit. These decisions supersede preliminary notes and guide all subsequent milestone implementations.

---

## 2. Architecture Decisions

### ADR-001: Decouple Platform Identity from Media Access (Link-First Ingestion)
- **Status:** APPROVED.
- **Context:** Early designs assumed users must authenticate via Twitch or YouTube OAuth before editing footage from those platforms.
- **Decision:** Platform OAuth account connections are **never mandatory for ordinary editing**. Any user can paste a public livestream or video link (YouTube, Twitch, Kick) or upload their own MP4/MOV file. Platform authorization is strictly requested only when an operation requires authenticated platform write permissions (e.g., personal OBS stream key generation, private VOD access, or direct social media publishing).
- **Consequences:** Lowers onboarding friction to near zero; expands audience to independent clippers and casual editors; simplifies identity model.

---

### ADR-002: Four Composable Editing Modes on One Unified Timeline Model
- **Status:** APPROVED.
- **Context:** Video editors often partition into separate apps for auto-clipping, prompt-based AI, and manual timeline editing.
- **Decision:** AutoAI Edit provides **four composable editing paradigms within a single Web Studio**:
  1. *Auto Edit:* Algorithmic highlight extraction and silence reduction.
  2. *Prompt Edit:* Conversational natural-language directives.
  3. *Reference Edit:* Pacing and aesthetic transfer from an exemplar video.
  4. *Manual Edit:* Pixel-accurate HTML5 canvas timeline manipulation.
  All four modes read and modify a single, non-destructive, versioned timeline model (`EditTimelinePlan`).
- **Consequences:** Creators never lose work when switching between editing modes; eliminates duplicate editing engines; preserves complete version history.

---

### ADR-003: Modular Monolith vs. Distributed Microservices
- **Status:** APPROVED.
- **Context:** High-throughput media processing often tempts teams to split into microservices prematurely (auth service, upload service, transcription service, render service).
- **Decision:** AutoAI Edit is architected as a **modular monolith** within a unified multi-package repository. All domain modules reside within `apps/api`, sharing a database, Redis queue connection, and contracts package. Only compute-heavy tasks that benefit from hardware isolation (Python Whisper sidecar) run as distinct services.
- **Consequences:** Dramatically lowers operational complexity, eliminates distributed transaction overhead, enables zero-network local development, and scales easily past 100+ concurrent creators.

---

### ADR-004: Two Processing Modes (LITE Deterministic vs. PRO Multimodal) in One App
- **Status:** APPROVED.
- **Context:** Offering free or low-cost clipping while maintaining sustainable margins is a primary SaaS challenge.
- **Decision:** Implement two configuration-driven processing tiers within the same application:
  - **LITE Mode:** Runs on commodity CPU workers; uses deterministic signal processing (chat velocity spikes, silence detection, audio peak envelopes); cost: ~$0.03/clip.
  - **PRO Mode:** Serverless GPU transcription, Claude/Gemini semantic reasoning, automated virality scoring, smart face reframing; cost: ~$0.15/clip.
- **Consequences:** Allows profitable free/low-cost tiers; gives creators a seamless 1-click non-destructive upgrade path from LITE cuts to PRO polish.

---

### ADR-005: Foundation-First Implementation (Local E2E Pipeline as Milestone 1 Gate)
- **Status:** APPROVED.
- **Context:** Empirical testing revealed that existing workers cannot run even a local upload-to-export cycle due to hardcoded S3 endpoints, lack of transcription fallback, and missing prompt-editing fallback.
- **Decision:** **Milestone 1 must resolve foundational pipeline blockers and achieve an authentic local end-to-end test (upload → analyze → edit → render → download)** before developing new streaming or reference-editing features.
- **Consequences:** Guarantees that future feature work builds upon a solid, verified, and testable media pipeline.

---

### ADR-006: Multi-Storage Provider Abstraction with S3_ENDPOINT Support
- **Status:** APPROVED.
- **Context:** `apps/api/src/lib/s3.ts` hardcodes standard AWS S3 client options, preventing local testing with MinIO and vendor switching to Cloudflare R2.
- **Decision:** Refactor storage operations into a `StorageService` interface; introduce `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` environment variables in `env.ts`.
- **Consequences:** Enables completely hermetic local testing with Dockerized MinIO; allows production to switch to zero-egress Cloudflare R2 with zero code refactoring.

---

### ADR-007: Capability-Based Worker Scheduling (CPU vs. GPU)
- **Status:** APPROVED.
- **Context:** Running heavy GPU tasks on general CPU instances causes timeouts; running light FFmpeg jobs on expensive GPU instances wastes cloud budget.
- **Decision:** Tag BullMQ jobs with required capabilities (`requiredCapability: 'cpu' | 'gpu'`). Worker instances subscribe only to queues matching their hardware profile.
- **Consequences:** Optimizes cloud infrastructure costs; enables seamless addition of dedicated GPU rendering nodes in the future.

---

### ADR-008: Serverless GPU for Transcription (Modal Labs Scale-to-Zero)
- **Status:** APPROVED.
- **Context:** Running 24/7 GPU instances on cloud providers costs hundreds of dollars monthly, even when idle.
- **Decision:** Deploy the Whisper transcription service (`services/whisper/modal_app.py`) as a serverless function on Modal Labs. The function spins up an A10G GPU in <2 seconds and scales to zero when idle.
- **Consequences:** Near-zero idle costs; instantaneous burst capacity for concurrent uploads; eliminates complex cloud GPU cluster management.

---

### ADR-009: Strict Quota Accounting & Hard Spend Caps Ahead of Public Compute
- **Status:** APPROVED.
- **Context:** Publicly exposing free-tier cloud video rendering without hard caps risks runaway cloud bills.
- **Decision:** Server-side entitlement enforcement, durable clip minute reservation, and hard spend caps (`SAAS-009`, `AUTH-005`) are required prerequisites before public cloud launch.
- **Consequences:** Protects platform financial solvency; prevents API credit exhaustion from bot abuse.

---

### ADR-010: Git Branch Governance & Pull Request Automation Policy
- **Status:** APPROVED.
- **Context:** Need for reliable, automated development lifecycle without risking production outages.
- **Decision:**
  1. All development occurs on isolated feature or documentation branches.
  2. Automatic PR creation and update via GitHub CLI (`gh`) are enabled.
  3. **Auto-merging is strictly prohibited** (`gh pr merge` and `--auto` are forbidden).
  4. Merging into `master` requires explicit human approval by repository owner (`RIPU05`).
- **Consequences:** Maintains a clean, auditable commit history; ensures human oversight over production deployments.
