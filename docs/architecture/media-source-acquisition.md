# AutoAI Edit — Universal Media Source & Shared Ingestion Foundation (Step 3B.4)

## 1. Universal User Input Concept & Product Vision

AutoAI Edit targets independent clippers, fan pages, Shorts/Reels/TikTok editors, and creator communities. From the user's perspective, there is one seamless editing studio regardless of how footage enters the system:

1. User pastes a livestream/VOD URL (YouTube, Twitch, Kick) or uploads footage directly.
2. Backend resolves the input into a unified `UniversalMediaSource` contract and determines whether an approved, permitted acquisition method is available.
3. AI identifies highlight moments.
4. User edits in Auto, Prompt, Reference, or Manual mode on a private, non-destructive, versioned timeline.
5. User privately downloads the rendered MP4 and independently chooses whether and where to publish it.

Streamer account OAuth is **not** mandatory for independent clippers, and social media publishing remains outside the core editing pipeline.

---

## 2. Existing Ingestion Flow Audit (Pre-Step 3B.4)

Before Step 3B.4, AutoAI Edit supported direct user uploads only:

```
Browser Multipart Upload
  → POST /api/upload/init   (creates private Project + 24h Redis/memory UploadSession + S3/MinIO multipart init)
  → POST /api/upload/part   (verifies UploadSession ownership + project ownership → issues presigned part PUT URL)
  → POST /api/upload/complete (verifies session/ownership → completes multipart → creates 1:1 private Asset → probes metadata → enqueues BullMQ analysis)
  → analysis.worker.ts      (downloads via MediaStorageProvider → FFmpeg probe/silence/audio → FasterWhisperTranscriptionProvider → runAiProvider → persists Transcript, Analysis, EditTimeline, EditVersion)
  → render.worker.ts        (downloads source → FFmpeg render → uploads MP4 via storage.putObject())
  → Private Download        (authenticated project-scoped presigned GET URL)
```

Every `Project` currently links 1:1 (`sourceAssetId @unique`) to a private `Asset`, meaning identical external media requested by different users would have no shared deduplication, coordination, or base-clip caching boundary.

---

## 3. Canonical Source Identity

When multiple independent clippers submit URLs referring to the same stream or VOD, the system maps them to one stable, collision-resistant canonical identity:

```
<provider>:<sourceType>:<externalId>
```

| Input Example | Canonical Identity | Normalized URL |
| :--- | :--- | :--- |
| `https://youtu.be/GTA6Stream1?si=xyz` | `youtube:vod:GTA6Stream1` | `https://www.youtube.com/watch?v=GTA6Stream1` |
| `https://www.youtube.com/watch?v=GTA6Stream1&t=42s&utm_source=x` | `youtube:vod:GTA6Stream1` | `https://www.youtube.com/watch?v=GTA6Stream1` |
| `https://www.youtube.com/live/GTA6Stream1` | `youtube:live:GTA6Stream1` | `https://www.youtube.com/live/GTA6Stream1` |
| `https://www.twitch.tv/Shroud?referrer=raid` | `twitch:live:shroud` | `https://www.twitch.tv/shroud` |
| `https://www.twitch.tv/videos/2284910293?t=01h` | `twitch:vod:2284910293` | `https://www.twitch.tv/videos/2284910293` |
| `https://clips.twitch.tv/AmazingClutchPlay123` | `twitch:vod:clip_AmazingClutchPlay123` | `https://clips.twitch.tv/AmazingClutchPlay123` |
| `https://kick.com/xQc` | `kick:live:xqc` | `https://kick.com/xqc` |
| `https://kick.com/xqc/videos/9f8a7b6c-1234` | `kick:vod:9f8a7b6c-1234` | `https://kick.com/video/9f8a7b6c-1234` |
| Direct Upload (`asset_clx001`) | `upload:uploaded:asset_clx001` | *(private storage key)* |

### Key Identity Invariants
- **Tracking Parameter Stripping:** Harmless query parameters (`si`, `utm_*`, `feature`, `t`, `pp`, `list`, `ref`, `fbclid`, `gclid`) are ignored.
- **Provider Namespacing:** Prefixing with `<provider>:<sourceType>:` ensures YouTube, Twitch, Kick, direct uploads, and direct media IDs can never collide.
- **Livestream-to-VOD Separation:** A livestream (`youtube:live:<id>`, `twitch:live:<channel>`) and a finalized VOD (`youtube:vod:<id>`, `twitch:vod:<numericId>`) maintain distinct canonical identities and are never blindly merged.
- **Project Isolation:** `canonicalSourceId` is strictly separate from per-user `Project.id`.

---

## 4. Target Scaling Model: "One Stream, Thousands of Clippers"

Consider a target architectural workload: 1 streamer broadcasting a major launch (e.g. GTA 6), 1,000 independent clippers requesting the same source, and 5,000 downloads of one identical generated clip.

To scale economically without duplicating work, the pipeline is decoupled into three independent layers:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ LAYER 1: SHARED SOURCE ACQUISITION (1 active ingestion per source)      │
│   CanonicalSourceId → SharedIngestionCoordinator (Redis TTL + Fencing)  │
│   Output: Private shared source media / immutable 6s segments           │
├─────────────────────────────────────────────────────────────────────────┤
│ LAYER 2: SHARED SOURCE ANALYSIS & BASE CLIPS (1 analysis per revision)  │
│   Transcription + CPU-first Highlight Signals + Deterministic Base Clip │
│   Keyed by SharedCacheIdentity (SHA-256 of source + range + params)     │
├─────────────────────────────────────────────────────────────────────────┤
│ LAYER 3: PRIVATE PER-USER EDITING & EXPORTS (Isolated per User/Project) │
│   Private Project, EditTimeline, EditVersions, Prompts, Custom Renders  │
│   Custom edits render privately; identical base clips reuse Layer 2     │
└─────────────────────────────────────────────────────────────────────────┘
```

*(Note: These are architectural design targets. Actual throughput and savings must be measured under dedicated future load tests rather than assumed.)*

---

## 5. Shared Ingestion Coordination & Worker Recovery

Implemented in `apps/api/src/media/ingestion-coordinator.ts`:

- **Atomic Deduplication:** Uses single-key Redis Lua scripts (`RedisCoordinationStore`, with a semantics-identical `InMemoryCoordinationStore` for isolated unit tests) to coordinate requests per `canonicalSourceId`.
- **State Machine:** `PENDING` → `ACQUIRING` → `INGESTING` → `READY` | `FAILED` | `EXPIRED`.
- **Actions:**
  - `ACQUIRED_NEW`: First worker acquires the lease (`fencingToken = 1`).
  - `ATTACH_EXISTING`: Concurrent clippers attach to the active work item without spawning duplicate acquisition jobs.
  - `REUSE_READY`: Subsequent requests immediately reuse the completed artifact reference.
  - `ACQUIRED_RECOVERY`: If the owning worker crashes and `now >= leaseExpiresAtMs`, a recovery worker takes ownership with `fencingToken + 1` up to bounded `maxRetries`.
  - `FAILED_MAX_RETRIES`: Prevents infinite retry loops once `attempts > maxRetries`.
- **Fencing Safety:** Any delayed or zombie worker attempting `markIngesting`, `markReady`, or `renewLease` with a stale `fencingToken` is rejected with `LEASE_EXPIRED`. This provides **at-least-once execution with fencing**, rather than an unproven claim of distributed exactly-once execution.

---

## 6. Shared Cache Boundaries (SHARED vs PRIVATE)

Implemented in `apps/api/src/media/shared-cache.ts`:

| Scope | Artifacts Allowed | Storage Prefix | Sharing Rules |
| :--- | :--- | :--- | :--- |
| **`SHARED_PERMITTED`** | Permitted source media, immutable 6s segments, source transcription, highlight candidates, identical uncustomized base clips | `cache/shared/<kind>/<sourceHash>/<cacheKey>` | Reusable only when `sourceRightsStatus === 'PERMITTED_PUBLIC'` and parameters match exactly. |
| **`PRIVATE_USER`** | Direct uploads (`upload:*`), personalized prompt/manual edits (`customEditHash`), private projects, timelines, versions, custom exports | `cache/private/<ownerUserId>/<kind>/<sourceHash>/<cacheKey>` | Strictly scoped to `requesterUserId === ownerUserId`. Cross-user access throws `ACCESS_DENIED`. |

- **Cache Key Inputs:** Canonical JSON (sorted keys) hashed via SHA-256 over `artifactKind`, `canonicalSourceId`, `sourceRevision`, `timeRangeSec` (ms-rounded), `algorithmVersion`, `renderSettings`, `rightsScope`, and `ownerUserId`.
- **Private Storage:** Reuses `MediaStorageProvider` (`apps/api/src/storage/`). Cached objects are never publicly readable; authorized users receive short-lived presigned download URLs only after `assertCacheAccessAllowed()` passes.

---

## 7. CPU-First Live Highlight Detection & Rolling Media Buffer

Implemented in `apps/api/src/media/highlight-detector.ts`:

- **Configurable Rolling Media Buffer (`RollingMediaBufferTracker`):**
  - Default candidate window: **45s pre-event + 15s post-event** (configurable via `RollingBufferConfigSchema`, never hardcoded).
  - Divides rolling stream retention into 6-second immutable segments (`segmentDurationSec`, default 6s; `maxRetentionSec`, default 600s).
  - Computes the exact segment indices to pin when a spike is detected so pre-event build-up is preserved.
- **CPU-First Signal Fusion (`CpuFirstHeuristicDetector`):**
  - Ingests lightweight signals: `AUDIO_ENERGY`, `SPEECH_ACTIVITY`, `TRANSCRIPT_CONTEXT`, optional `CHAT_VELOCITY`, optional `CHAT_EXCITEMENT_KEYWORDS`, and optional `SELECTIVE_VISUAL`.
  - Dynamically normalizes weights across whichever signals are present — gracefully handling platforms that do not expose live chat, without requiring continuous paid vision AI.

---

## 8. Access, Rights & SSRF Safeguards

Implemented in `apps/api/src/media/url-safety.ts` and `canonical-source.ts`:

- **SSRF & Network Protection:**
  - Enforces `https:` only by default; blocks `file:`, `javascript:`, `data:`, `ftp:`, and embedded URL credentials.
  - Blocks `localhost`, `*.local`, `*.internal`, raw IPv4/IPv6 literals, RFC1918 private ranges, CGNAT, loopback, link-local, obfuscated decimal/hex/octal IPs, and AWS/GCP/Alibaba cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, `fd00:ec2::254`).
  - Provides `assertSafeResolvedIp()` and `assertSafeRedirectTarget()` for DNS and redirect-hop validation.
- **Rights vs Viewing Distinction:**
  - Pasting a public URL does not require streamer login, nor does it assume copying/recording is permitted.
  - External third-party platforms default to `acquisitionCapability: 'UNSUPPORTED'` and `rightsStatus: 'UNKNOWN'` until an approved acquisition method is explicitly enabled.
  - `assertAcquisitionPermitted()` and `assertCacheAccessAllowed()` fail closed on `UNSUPPORTED_ACQUISITION`, `DRM_RESTRICTED`, `ACCESS_DENIED`, and `RIGHTS_UNVERIFIED`.
  - Never bypasses DRM, paywalls, or login walls.

---

## 9. Storage Lifecycle, Cost Drivers & Future Schema Proposal

### Storage Lifecycle & Cleanup
- **Ephemeral rolling segments:** Expire automatically after `maxRetentionSec` unless pinned by a highlight candidate or active render lease.
- **Pinned segments & base clips:** Retained via TTL/reference counting and garbage-collected when unreferenced.
- **Private user uploads & exports:** Governed by existing user/project ownership and retention rules.

### Expected Cost Drivers
1. **Source Acquisition & Bandwidth:** Egress/ingress of high-bitrate 1080p60 streams (mitigated by 1 shared acquisition per canonical source).
2. **Transcription & Highlight Analysis:** Whisper CPU/GPU time and LLM tokens (mitigated by 1 shared analysis per source revision and CPU-first signal triage).
3. **FFmpeg Rendering & Object Storage:** CPU encode cycles and S3/R2 storage/egress (mitigated by caching identical permitted base clips and expiring unpinned rolling segments).

### Proposed Future Persistence Changes (Not Applied in Step 3B.4)
To preserve zero-migration compatibility across the current stacked PR chain, `apps/api/prisma/schema.prisma` was intentionally left unchanged in Step 3B.4. A future persistence milestone can add:
- `MediaSource` table (`canonicalId @unique`, `provider`, `sourceType`, `externalId`, `rightsStatus`, `ingestionStatus`, `primaryAssetId`).
- Optional `Project.mediaSourceId` foreign key alongside existing `Project.sourceAssetId`, preserving 100% backward compatibility with direct uploads.
- `SharedCacheEntry` table tracking `cacheKey @unique`, `storageKey`, `rightsScope`, `expiresAt`, and `referenceCount`.

---

## 10. Implemented vs Planned & Future Load Testing

| Capability | Status in Step 3B.4 | Next Milestone / Planned |
| :--- | :--- | :--- |
| Universal `UniversalMediaSource` Zod contracts | **Implemented** | Persist in PostgreSQL `MediaSource` model |
| Canonical URL identity (YouTube, Twitch, Kick, Upload) | **Implemented** | Add platform metadata probes via approved APIs |
| SSRF, private-network, metadata & redirect guards | **Implemented** | Integrate with outbound HTTP client DNS hook |
| Redis Lua + In-Memory Shared Ingestion Coordinator | **Implemented** | Wire to BullMQ source-acquisition worker queue |
| Shared vs Private Cache Key & Rights Guard | **Implemented** | Wire to analysis & render worker cache lookup |
| CPU-first Highlight Detector & Rolling Buffer contract | **Implemented** | Feed real FFmpeg audio RMS + permitted chat streams |
| Live-stream recorder / VOD downloader | **Deferred (Out of Scope)** | Separate reviewed acquisition milestone |
| Production multi-node load & cost benchmarking | **Deferred** | Dedicated staging load test (1,000+ real connections) |
