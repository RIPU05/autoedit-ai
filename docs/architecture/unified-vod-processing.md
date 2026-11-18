# AutoAI Edit — Unified VOD Ingestion, Shared Highlights & Private Editing Integration (Step 3B.8)

## 1. Unified Live + VOD + Upload Architecture

AutoAI Edit uses **one unified backend processing engine** across livestreams, recorded VODs, and direct user uploads—never separate platform-specific editing workflows:

```
Universal Media Source Identity (MediaSource in PostgreSQL)
  ├─ Continuous Live Broadcast (Step 3B.6: ContinuousLiveSessionService)
  ├─ Finite Recorded VOD       (Step 3B.8: UnifiedVodProcessingService)
  │    • YouTube recorded video           (youtube:vod:<id>)
  │    • YouTube completed livestream VOD (youtube:vod:<id> + associatedLiveSourceId)
  │    • Twitch VOD                       (twitch:vod:<id>)
  │    • Kick VOD                         (kick:vod:<id>)
  │    • Authorized direct-media recording(direct_media:vod:<id>)
  └─ Private Direct Upload                (upload:uploaded:<id>, strictly PRIVATE_USER)
          │
          ▼  (1) Server-Authoritative Rights Check (PostgreSQL MediaSource + MediaRightsGrant)
          ▼  (2) Layer A: SOURCE_MEDIA (immutable MP4 in MinIO + PostgreSQL CAS)
          ▼  (3) Layer B: TRANSCRIPTION (optional local faster-whisper) + HIGHLIGHT_ANALYSIS
                 (reuses FfmpegRollingSegmentBuffer + extractAudioSignalsFromSegments + CpuFirstHeuristicDetector)
          ▼  (4) Layer C: BASE_CLIP (real FFmpeg + ffprobe validated MP4, PostgreSQL CAS)
          ▼  (5) Private Per-User Editing Sessions (Project + EditTimeline + immutable EditVersion tree)
                 • Modes: Auto, Prompt, Reference, Manual
                 • Uncustomized base clips reuse SHARED_PERMITTED cache (0 extra FFmpeg runs)
                 • Personalized edits store strictly under PRIVATE_USER (`cache/private/<userId>/...`)
```

**Shared components reused directly without duplication:**
- `DurableMediaRegistryService` + `DurableArtifactPublisher` (PostgreSQL `MediaSource`, `MediaRightsGrant`, `SharedCacheArtifact`, `SharedArtifactAttempt`, row-locked CAS)
- `SharedIngestionCoordinator` + `RedisCoordinationStore` (fast-path fan-in deduplication)
- `FfmpegRollingSegmentBuffer`, `extractAudioSignalsFromSegments`, `CpuFirstHeuristicDetector`
- `extractAndVerifyHighlightClip`, `probeAndValidateClipMp4`
- `transcribeRich`, `transcriberHealthy` (`apps/api/src/services/transcribe.service.ts`)
- Existing `Project`, `EditTimeline`, and `EditVersion` tables & ownership model

---

## 2. Controlled VOD Acquisition Path & Lifecycle

Implemented in `apps/api/src/media/vod/controlled-vod.adapter.ts` and `apps/api/src/media/vod/unified-vod-pipeline.ts`:

1. **Resolve Immutable VOD Identity:** Registers or retrieves the unique `MediaSource` row (`youtube:vod:...`, `twitch:vod:...`, `kick:vod:...`, `direct_media:vod:...`, or `upload:uploaded:...`). Completed livestream VODs preserve distinct identities while optionally linking back via `associatedLiveSourceId`.
2. **Check Authoritative Rights:** Resolves server-trusted `TrustedCacheAuthContext` from PostgreSQL before touching Redis, MinIO, or FFmpeg. Disabled or unsupported adapters fail gracefully with `UNSUPPORTED_ACQUISITION`.
3. **Reuse Verified Source if Present:** Checks PostgreSQL `SharedCacheArtifact` (`SOURCE_MEDIA`) + MinIO `HEAD`/`ETag`/`Content-Length`. If present, valid, and unexpired, reuses immediately with **0** re-imports.
4. **Acquire, Probe & Fingerprint:** Otherwise acquires real media bytes via `ControlledVodAcquisitionAdapter.acquireAndValidate(guard)`, enforcing `maxSourceFileBytes` and `maxVodDurationSec`, probing codecs/streams/duration via `ffprobe`, and computing genuine SHA-256 `mediaFingerprint`.
5. **Immutable Upload & PostgreSQL CAS Commit:** Uploads to `<prefix>/v/gen-<gen>-<sha12>.mp4` and promotes atomically via `DurableArtifactPublisher.commitPublishedArtifact` with `expiresAt = now + cacheRetentionMs`.

---

## 3. Shared Highlight Analysis & Local Whisper Transcription

- **Optional Local Whisper (`TRANSCRIPTION`):** When `enableLocalWhisper: true`, extracts 16kHz mono WAV once, calls `transcribeRich()` against the local faster-whisper sidecar (`http://127.0.0.1:9000`), caches `TranscriptionResult` durably in PostgreSQL + MinIO under `TRANSCRIPTION`, and extracts lightweight `TRANSCRIPT_CONTEXT` excitement/keyword signals (`insane`, `clutch`, `prompt`, `highlight`, exclamation marks, speech-rate bursts).
- **CPU-First Multi-Candidate Analysis (`HIGHLIGHT_ANALYSIS`):** Segments the cached `SOURCE_MEDIA` into temporary scratch segments (`FfmpegRollingSegmentBuffer`, cleaned up in `finally`), runs `extractAudioSignalsFromSegments` + `CpuFirstHeuristicDetector`, and stores **multiple distinct `HighlightWindowCandidate`s** with configurable `highlightLengthSec`, `preRollSec`, `postRollSec`, `cooldownSec`, and `scoreThreshold`.
- **Zero Duplicate Work:** 100 or 1,000 clippers requesting identical VOD parameters run local Whisper **once** (`whisperTranscriptionCount = 1`) and FFmpeg audio analysis **once** (`analysisPassCount = 1`).

---

## 4. Real Base Clip Generation, Rights Hardening & PostgreSQL CAS

- **Real MP4 Base Clips (`BASE_CLIP`):** Extracts the candidate window from the verified `SOURCE_MEDIA` in MinIO, validates via `ffprobe` (`h264/aac`, duration, resolution, real `contentSha256 !== cacheKey`), uploads immutable `/v/gen-<gen>-<sha12>.mp4`, and promotes via PostgreSQL CAS.
- **Distinct Keys for Distinct Variants:** Different candidate windows, different `renderSettings` (`640x360@24fps` vs `1280x720@30fps`), and different `sourceRevision` (`v2` vs `v1`) always produce separate `SharedCacheArtifact` rows and separate MinIO objects.
- **Step 3B.8 Rights & Publication Hardening:**
  - `assertValidServerGrantProvenance()` enforces an explicit server provenance allowlist (`USER_DIRECT_UPLOAD`, `TEST_CONTROLLED_GRANT`, `EXPLICIT_PLATFORM_GRANT`, `ADMIN_VERIFIED_GRANT`) and server `grantedBy` namespace (`system:*`, `admin:*`, `test:*`), rejecting untrusted end-user grant payloads (`ACCESS_DENIED`).
  - `verifyServerRightsInsideTx()` re-verifies `MediaSource` and active `MediaRightsGrant` rows **inside the row-locked PostgreSQL `commitPublishedArtifact` transaction**. If sharing rights are revoked while a worker is mid-render/mid-upload, commit **atomically fails closed with `ACCESS_DENIED`**, marks the attempt `ABANDONED` for delayed cleanup, and never publishes the artifact.

---

## 5. Private User Project, Timeline & Version Integration

Implemented in `UnifiedVodProcessingService.createPrivateEditingSessionFromVod()` and `applyPrivateTimelineEdit()`:

- Multiple independent users create their **own private `Project`** (`Project.mediaSourceId` → shared `MediaSource`), their **own private `EditTimeline`** (seeded from shared highlight candidates), and their **own immutable `EditVersion` tree** (`parentVersionId` snapshots across `auto`, `prompt`, `reference`, and `manual` modes).
- Editing another user's `Project` fails with `ACCESS_DENIED`.
- Uncustomized base clips reuse the shared `SHARED_PERMITTED` cache (`0` extra renders); customized edits (`customEditHash`) render and persist strictly under `PRIVATE_USER` (`cache/private/<userId>/...`).
- User A's `PRIVATE_USER` renders and `private_user_upload` VODs are completely inaccessible to User B (namespace lookup returns `SOURCE_UNAVAILABLE` with zero existence leak; direct object-key access returns `ACCESS_DENIED`).

---

## 6. First-100-Free-Users Cost & Resource Controls

Implemented in `VodResourceGuard` (`apps/api/src/media/vod/controlled-vod.adapter.ts`) with practical defaults for 100 initial free users on low-cost non-GPU, non-K8s infrastructure:

| Control | Default (`DEFAULT_FREE_BETA_VOD_POLICY`) | Enforcement Mechanism |
| :--- | :--- | :--- |
| Maximum imported VOD duration | `3,600s` (60 min) | Checked via `ffprobe` before upload (`UNSUPPORTED_ACQUISITION`) |
| Maximum source file size | `500 MiB` | Checked via `fs.stat` & probe before upload (`UNSUPPORTED_ACQUISITION`) |
| Maximum concurrent CPU jobs | `2` per worker node | In-process async semaphore (`withCpuSlot`) |
| Per-user queue fairness | `1` concurrent uncached job/user | Per-user slot tracking inside `withCpuSlot` |
| Daily free-tier clip quota | `20` new uncached clips/user/day | Redis daily atomic counter (`INCR` + `EXPIRE 86400`); **cached reuse does not consume new renders** |
| Worker timeout | `120,000 ms` | Bounded FFmpeg/Whisper timeouts + `AbortSignal` `SIGKILL` |
| Cache retention | `7 days` | Persisted on `SharedCacheArtifact.expiresAt`; expired entries rejected on read |
| Temp segment & orphan cleanup | Immediate scratch `finally` + delayed DB grace cleanup | `buffer.cleanupAll()` + `cleanupAbandonedGenerations()` |

---

## 7. Local Measurements (1,000-User Deduplication & Failure Safety)

Measured on local Docker PostgreSQL (`autoedit_local`), Redis (`6379`), MinIO (`http://127.0.0.1:9002`), local faster-whisper (`http://127.0.0.1:9000`), and `ffmpeg-static`:

| Scenario | Verified Local Result |
| :--- | :--- |
| 60s 3-Event Twitch VOD Import & Probe | `h264/aac`, `1280x720`, `60s`, real SHA-256 fingerprint; 2nd user `reusedFromCache = true` (`sourceImportCount = 1`) |
| Shared Local Whisper + 3-Event Analysis | **3/3** distinct highlights detected; **1** Whisper run & **1** analysis pass across multiple users |
| **1,000 Concurrent VOD Clippers (2 instances)** | **7,686 ms** total; **1** source import, **1** analysis pass, **1** FFmpeg base clip render; all 1,000 received identical `cacheKey` & `objectKey` |
| Rights Revocation Racing Inside Commit Tx | Atomically rejected inside locked PostgreSQL transaction (`ACCESS_DENIED`); artifact never published (`publishedGeneration = 0`) |
| Crashes During Import & Transcription | Aborted cleanly; recovery worker succeeded cleanly on next generation |
| Redis Wipe + Corrupt Source/Clip Repair + Cache Expiry | Survived Redis wipe with `0` renders; corrupt source & clip repaired cleanly; expired `expiresAt` rejected (`SOURCE_UNAVAILABLE`) |

---

## 8. What Is Working vs. Still Simulated & Production Blockers

### Genuinely Working Today
- Real H.264/AAC MP4 probing, fingerprinting, segmentation, CPU audio spike extraction, real local faster-whisper transcription, multi-candidate highlight detection, FFmpeg MP4 clip extraction, and `ffprobe` validation.
- Durable PostgreSQL `MediaSource`, `MediaRightsGrant`, `SharedCacheArtifact`, `SharedArtifactAttempt`, row-locked CAS publication, in-transaction revocation checks, Redis fast-path deduplication, MinIO immutable storage, short-lived signed URLs, private `Project`/`EditTimeline`/`EditVersion` integration, and bounded resource/quota controls.

### Still Simulated / Out of Scope for Step 3B.8
- **Media Acquisition Transport:** `ControlledVodAcquisitionAdapter` reads authorized local fixtures rather than downloading from YouTube, Twitch, or Kick.
- **Public HTTP Universal-URL Route:** Backend services are ready and tested; wiring the public `/api/sources/vod` HTTP route and frontend universal URL input box are intentionally deferred.

### Remaining Production Blockers Before Beta Launch
1. Compliant, rights-verified platform acquisition adapters for YouTube, Twitch, and Kick (respecting terms, no DRM/paywall bypass).
2. Authenticated HTTP routes wiring `UnifiedVodProcessingService` and `ContinuousLiveSessionService` into `apps/api/src/app.ts` with rate limiting and BullMQ job dispatch.
3. Scheduled background cleanup cron calling `cleanupAbandonedGenerations()` and expired cache sweeps.
4. Production database migration review & approval, Cloudflare R2/CDN edge delivery, and production observability alerts.
