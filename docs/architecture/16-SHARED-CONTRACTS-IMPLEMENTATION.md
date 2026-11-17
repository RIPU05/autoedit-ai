# AUTOAI EDIT — SHARED CODE FOUNDATION & CONTRACTS SPECIFICATION

**Document ID:** ARCH-016  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Active Branch:** `feature/stage2-milestone0a-shared-contracts`  
**Target Package:** `packages/contracts` (`@autoedit/contracts`)  
**Classification:** Core Code Architecture & Domain Contract Specification  
**Author:** Principal Software Architect, Senior TypeScript Engineer, Database Architect & Senior QA Lead  

---

## 1. Executive Summary & Objective

In accordance with Stage 2, Milestone 0A of the AutoAI Edit Master Architecture Blueprint, this document defines the implementation of `@autoedit/contracts`—the unified, reusable TypeScript contract foundation for the AutoAI Edit platform.

Milestone 0A is strictly restricted to **shared types, domain interfaces, and runtime Zod validation schemas**. It introduces zero breaking changes to existing production APIs, executes zero database migrations, provisions zero paid cloud infrastructure, and preserves all core product invariants (**Instant Preview Edit**, **Explainable AI**, **Non-Destructive Version History**).

> [!IMPORTANT]
> **Branch Separation Invariant:** The actual implementation source code, build configuration, and test suite for `@autoedit/contracts` (`packages/contracts/`) reside exclusively on the dedicated implementation branch `feature/stage2-milestone0a-shared-contracts` (commit `1657597`). The `docs/*` branches serve strictly as architectural governance and specification documents, and do NOT contain unmerged application source code.

---

## 2. Package Structure & Monorepo Integration

The shared contracts reside in a dedicated internal package within the repository:

```text
packages/contracts/
├── package.json           # Package definition (@autoedit/contracts v0.1.0)
├── tsconfig.json          # Strict TypeScript compiler options with declaration generation
├── vitest.config.ts       # Test harness configuration
├── dist/                  # Compiled JavaScript and .d.ts type declarations
├── src/
│   ├── index.ts           # Unified barrel export and contract validation helpers
│   ├── common.ts          # Tenant ownership, resource IDs, millisecond time ranges, envelopes
│   ├── media.ts           # MediaSource, MediaAsset, MediaSegment, MediaDiscontinuity
│   ├── live.ts            # LiveSession, StreamHealthEvent, ReconnectionEvent, protocols
│   ├── platforms.ts       # PlatformProvider, NormalizedChatEvent, capabilities
│   ├── highlight.ts       # HighlightSignal, HighlightCandidate, HighlightEvidence, scoring
│   ├── editing.ts         # EditTimelinePlan, EditOperation, CaptionStyle, RenderRequest
│   ├── processing.ts      # ProcessingJob, JobProgressEvent, JobFailure, IdempotencyKey
│   └── usage.ts           # UsageEvent, RetentionPolicy, SegmentPinReference
└── tests/
    └── contracts.test.ts  # Comprehensive validation test suite (21 unit tests)
```

### Dependencies
- **Runtime:** `zod` (`^3.23.8`) — Zero external HTTP or runtime baggage; lightweight validation only.
- **Dev Dependencies:** `typescript` (`^5.6.2`), `vitest` (`^2.1.1`).

---

## 3. Core Contract Domains & Invariants

All contracts enforce seven architectural rules:
1. **Explicit Tenant Ownership:** Every root entity (`MediaSource`, `MediaAsset`, `LiveSession`, `HighlightCandidate`, `EditTimelinePlan`, `ProcessingJob`, `UsageEvent`, `RetentionPolicy`, `SegmentPinReference`) requires a non-empty `tenantId`.
2. **Stable Resource Identifiers:** All IDs use length-bounded strings adhering to CUID / UUID conventions.
3. **Millisecond Timestamp Standard:** Media timings use integer milliseconds (`startMs`, `endMs`, `durationMs`, `timestampMs`) to eliminate floating-point drift across FPS boundaries.
4. **Source-Relative vs. Wall-Clock Separation:** Media presentations use epoch-relative milliseconds (`epochStartMs`), while historical event logs use standard ISO-8601 strings.
5. **Discriminated Unions for State:** State machines (`LiveSessionState`, `EditOperation`, `ProcessingJobQueue`, `PlatformProvider`) utilize strict TypeScript discriminated unions.
6. **Reference-Aware Retention:** Unbounded permanent pinning is eliminated; segments use reference counts (`pinReferenceCount`) and explicit pin leases (`SegmentPinReference`) with automated TTL expiry.
7. **Safe Serialization & Deserialization:** Contracts safely survive `JSON.stringify()` / `JSON.parse()` round-trips without data distortion.

---

## 4. Contract Inventory by Domain

### 4.1 Media Domain (`src/media.ts`)
- **`MediaSource`:** The unified root media representation unifying uploaded files, platform VOD imports, and live streams.
  - *Kinds:* `DIRECT_UPLOAD` | `PLATFORM_VOD` | `LIVE_RTMP` | `LIVE_SRT`.
  - *Statuses:* `INITIALIZING` | `INGESTING` | `READY` | `FAILED`.
- **`MediaAsset`:** Addressable binary object in cloud storage (S3/R2).
  - *Kinds:* `SOURCE_VIDEO` | `AUDIO` | `RENDER_OUTPUT` | `THUMBNAIL` | `MUSIC`.
- **`MediaSegment`:** Discrete 6-second fragmented chunk produced during rolling ingestion.
  - *Fields:* `id`, `sourceId`, `tenantId`, `sequenceNumber`, `epochStartMs`, `durationMs`, `s3Key`, `pinReferenceCount`, `pinExpiresAt`, `retentionState`, `hasDiscontinuity`.
  - *Retention States:* `EPHEMERAL` | `PINNED_LEASE` | `REFERENCED` | `EXPIRED` | `ARCHIVED`.
- **`MediaDiscontinuity`:** Encapsulates network reconnect or clock drift events (`clockDriftMs`, `epochOffsetMs`).
- **`SourceReference`:** Lightweight tuple referencing an origin media asset.

### 4.2 Live Streaming Domain (`src/live.ts`)
- **`LiveSession`:** Lifecycle tracker for live streaming broadcasts.
  - *States:* `INITIALIZING` | `LIVE` | `PAUSED` | `DISCONNECTED` | `SEALING` | `ENDED`.
  - *Protocols:* `RTMP` | `RTMPS` | `SRT`.
  - *Authentication:* SHA-256 hashed stream key (`streamKeyHash`).
- **`StreamHealthEvent`:** Real-time telemetry event (`bitrateBps`, `fps`, `droppedFrames`, `audioLevelDb`, `bufferLatencyMs`).
- **`ReconnectionEvent`:** Documents bridge recovery following network drops (`downtimeMs`, `sequenceDiscontinuity`).

### 4.3 Platform Connections Domain (`src/platforms.ts`)
- **`PlatformProvider`:** Supported third-party networks: `TWITCH` | `YOUTUBE` | `KICK`.
- **`PlatformConnectionCapability`:** `CHAT_READ` | `STREAM_STATUS` | `VOD_IMPORT` | `DIRECT_PUBLISH`.
- **`PlatformAuthorizationStatus`:** `CONNECTED` | `DISCONNECTED` | `EXPIRED` | `REVOKED` | `ERROR`.
- **`PlatformStreamReference`:** Identifies external platform channel and broadcast metadata.
- **`NormalizedChatEvent`:** Platform-agnostic chat event normalizing divergent IRC, YouTube, and Pusher payloads (`senderId`, `senderName`, `message`, `emotes`, `badges`, `isSubscriber`, `isModerator`).

### 4.4 Highlight Intelligence Domain (`src/highlight.ts`)
- **`HighlightSignal`:** Time-series telemetry points (`CHAT_VELOCITY`, `AUDIO_LOUDNESS`, `SPEECH_PACING`, `SEMANTIC_HOOK`, `CREATOR_BOOKMARK`).
- **`HighlightCandidate`:** Complete highlight proposal containing time bounds, composite score (0–100), hook quote, editorial reasoning, contributing signals, and evidence metrics.
- **`HighlightEvidence`:** Replayable audit trail (`chatSurgeMultiplier`, `peakLufs`, `speechWpm`, `hookText`, `silenceEliminatedSec`, `topEmotes`).
- **`AlgorithmVersion`:** `v1.0-heuristic` | `v1.1-multimodal` | `v2.0-custom`.

### 4.5 Editing Domain (`src/editing.ts`)
- **`EditTimelinePlan`:** Reusable editorial plan, 100% backward-compatible with existing `apps/api/src/ffmpeg/pipeline.ts` `EditPlan`.
- **`EditOperation`:** Discriminated union supporting:
  - `{ action: 'keep', startSec, endSec, startMs?, endMs? }`
  - `{ action: 'cut', startSec, endSec, reason? }`
  - `{ action: 'zoom', startSec, endSec, scale, pan }`
  - `{ action: 'speed', startSec, endSec, speedMultiplier }`
- **`CaptionStyle`:** Supports both core MVP styles:
  - `karaoke_bounce`: High-contrast yellow/white Montserrat with active-word cadence animation.
  - `minimalist_clean`: Crisp static white typography with subtle translucent backing.
  - Legacy styles: `modern_yellow`, `classic_white`, `bold_stroke`.
- **`RenderRequest`:** Cloud rendering job specification (`renderId`, `projectId`, `tenantId`, `format`, `timeline`).
- **`PreviewState`:** Real-time client preview synchronization state.
- **`VersionReference`:** Immutable version tree pointer (`versionId`, `parentVersionId`, `versionNumber`).

### 4.6 Processing & Queues Domain (`src/processing.ts`)
- **`ProcessingJob`:** Strongly typed background job representation across BullMQ queues (`analysis`, `render`, `n8n-dispatch`, `live-ingest`, `dead-letter`).
- **`JobProgressEvent`:** Progress tracking event (`stage`, `progressPercent`, `elapsedMs`).
- **`JobFailure`:** Classified failure payload (`MEDIA`, `TRANSCRIPTION`, `CLAUDE`, `RENDER`, `INFRA`, with `isRetryable` flag).
- **`IdempotencyKey`:** Unique deduplication token preventing duplicate transcoding or publishing runs.

### 4.7 Usage & Governance Domain (`src/usage.ts`)
- **`UsageEvent`:** Tenant usage metering event (`VIDEO_MINUTES_PROCESSED`, `TRANSCRIPTION_SECONDS`, `RENDER_SECONDS`, `STORAGE_BYTES_HOURS`, `LLM_TOKENS`).
- **`RetentionPolicy`:** Configurable storage policy specifying:
  - `ephemeralBufferMinutes`: Default 30-minute pilot buffer for unpinned live chunks.
  - `pinLeaseHours`: Default 72 hours for highlight pin leases.
  - `gracePeriodHours`: Default 24 hours before unreferenced chunk purge.
- **`SegmentPinReference`:** Reference-counted pin lease linking media chunks to highlight candidates or timeline clips, preventing storage leaks.

---

## 5. Backward Compatibility & Existing Code Reusability

`@autoedit/contracts` was designed to match existing working types in the repository without forcing immediate breaking refactors:

| Existing Working Contract Path | Existing Type / Interface | Reusable Contract in `@autoedit/contracts` | Compatibility Status |
|---|---|---|---|
| `apps/api/src/ffmpeg/pipeline.ts` | `EditPlan`, `KeepSegment` | `EditTimelinePlan`, `EditOperation` | **100% Drop-in Compatible** (Adds optional ms timestamps) |
| `apps/api/src/ffmpeg/pipeline.ts` | `CaptionCue` | `CaptionCue` | **100% Drop-in Compatible** (Adds optional word tokens) |
| `apps/api/src/ffmpeg/pipeline.ts` | `OutputFormat` (`'reel'|'short'|'landscape'`) | `OutputFormat` | **Identical Enum** |
| `apps/api/src/services/claude.service.ts` | `TimelineOp` | `EditOperation` | **Drop-in Compatible Discriminated Union** |
| `apps/api/src/services/claude.service.ts` | `ClaudeAnalysis.hook` | `HighlightCandidate.hook` | **Directly Compatible** |
| `apps/api/src/services/upload-session.service.ts` | `UploadSession` | `MediaAsset` / `MediaSource` | **Compatible Entity Mapping** |
| `apps/api/src/queue/queues.ts` | `AnalysisJobData`, `RenderJobData` | `ProcessingJob.payload` | **Directly Compatible** |

Existing production services (`apps/api/src/routes/*`, `apps/api/src/services/*`) continue running on their current types. They can adopt `@autoedit/contracts` progressively without disruption.

---

## 6. Proposed Milestone 0B Database Mapping

In accordance with the database policy, **no Prisma migrations were executed in Milestone 0A**. The proposed mapping between existing database models and future contracts is prepared for Milestone 0B review:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   EXISTING VS. PROPOSED PRISMA SCHEMA MAPPING          │
├────────────────────────────┬─────────────────────────────┬─────────────┤
│ Shared Contract Interface  │ Prisma Entity Status        │ Evolution   │
├────────────────────────────┼─────────────────────────────┼─────────────┤
│ TenantReference            │ Existing: User (model)      │ Unchanged   │
│ MediaAsset                 │ Existing: Asset (model)     │ Unchanged   │
│ EditTimelinePlan           │ Existing: EditTimeline      │ Unchanged   │
│ VersionReference           │ Existing: EditVersion       │ Unchanged   │
│ ProcessingJob              │ Existing: Job (model)       │ Unchanged   │
│ MediaSource                │ Proposed Addition (0B)      │ Additive    │
│ LiveSession                │ Proposed Addition (0B)      │ Additive    │
│ MediaSegment               │ Proposed Addition (0B)      │ Additive    │
│ RetentionPolicy            │ Proposed Addition (0B)      │ Additive    │
│ SegmentPinReference        │ Proposed Addition (0B)      │ Additive    │
│ NormalizedChatEvent        │ Proposed Addition (0B)      │ Additive    │
│ HighlightCandidate         │ Proposed Addition (0B)      │ Additive    │
└────────────────────────────┴─────────────────────────────┴─────────────┘
```

> [!IMPORTANT]
> **Milestone 0B Migration Policy:** When Milestone 0B is authorized, all additive entities will be introduced via reviewed migrations (`prisma migrate dev` / `prisma migrate deploy`). No columns on existing models will be removed or altered.

---

## 7. Verification & Automated Test Results

The `@autoedit/contracts` test suite (`packages/contracts/tests/contracts.test.ts`) verifies all 11 required contract behaviors:

1. **Valid and Invalid Payloads:** Passes complete `MediaSource` objects; rejects invalid enum values.
2. **Timestamp Ordering:** Enforces `endMs >= startMs`; rejects inverted ranges.
3. **Negative Durations Rejection:** Rejects negative millisecond durations and negative chunk sequences.
4. **Stream Reconnection Boundaries:** Validates positive `downtimeMs`; bounds audio levels to $\le 0\text{ dBFS}$.
5. **Media Discontinuities:** Validates sequence gap offsets and clock drift values.
6. **Chat Event Normalization:** Normalizes Twitch, YouTube, and Kick chat messages with optional emotes and badges.
7. **Highlight Evidence References:** Validates composite score bounds (0–100), hook quotes, and signal arrays.
8. **Missing Optional Data:** Correctly applies default reel formats and empty effect records.
9. **Invalid Ownership Identifiers:** Rejects empty or whitespace-only tenant IDs.
10. **Serialized Contract Compatibility:** Confirms lossless JSON round-trip validation.
11. **Retention Policy & Pin Leases:** Validates the 30-minute pilot buffer default and reference pin leases.

### Verification Summary:
- **`packages/contracts` Test Suite:** **21 tests passed** (100% pass rate).
- **`apps/api` Test Suite:** **43 tests passed** (baseline maintained, 4 skipped).
- **`packages/contracts` Build:** `tsc -p tsconfig.json` compiled with **0 errors**.
- **`apps/api` Build:** `tsc -p tsconfig.json` compiled with **0 errors**.
- **`apps/web` Build:** `next build` compiled all 10 routes with **0 errors**.

---

## 8. Proposed Future Contracts: Reference-Based AI Editing (Milestone 0C)

In accordance with [`ARCH-019: Reference-Based AI Editing`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/19-REFERENCE-BASED-AI-EDITING.md), the following schemas are planned for addition to `@autoedit/contracts` in Milestone 0C:

- `ReferenceMediaAsset`: Direct upload or public URL reference footage metadata, duration, dimensions, and Sha-256 content hash.
- `ReferenceAnalysisJob`: BullMQ background job state tracking Stage A video decomposition progress.
- `ReferenceStyleProfile`: Reusable style profile containing Average Shot Length (ASL), shot count, and extracted feature array.
- `ReferenceStyleFeature`: Individual style dimension (pacing, zooms, typography, color) with confidence score (0.0–1.0) and reproducibility flag.
- `ReferenceStyleSelection`: Granular creator toggles specifying which dimensions to apply.
- `ReferenceStyleApplicationRequest`: Request binding a style profile, user directives, and target project timeline with idempotency key.
- `StyleMatchReport`: Transparent explainability report itemizing matched, adapted, and unsupported characteristics.

> [!NOTE]
> **Status:** The above contracts are currently **Proposed Specifications** in `ARCH-019` and will be implemented in `packages/contracts/src/reference.ts` during Milestone 0C with dedicated Vitest suites.

---

## 9. Conclusion

`@autoedit/contracts` provides a production-grade, type-safe foundation for all future AutoAI Edit capabilities. It is fully compiled, tested, and ready to support Milestone 0B (Reviewed Database Evolution) and Milestone 1 (Cloud Worker Deployment).
