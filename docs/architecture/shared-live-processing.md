# AutoAI Edit — Working Shared Livestream Ingestion & Highlight Cache Prototype (Step 3B.5)

## 1. Overview & Working Pipeline

Step 3B.5 delivers an end-to-end working shared video-ingestion, CPU-first highlight detection, FFmpeg MP4 clip generation, and private MinIO/S3 cache reuse prototype using controlled, authorized local test media. Unlike Step 3B.4's contracts and coordination primitives, this milestone processes real H.264/AAC video bytes through FFmpeg, probes every generated MP4 with `ffprobe`, stores real playable MP4s in private MinIO, and proves multi-clipper deduplication on live local Redis + MinIO.

```
Controlled Authorized Broadcast Fixture (30s 1280x720 H.264/AAC, spike at 16–19s)
  → ControlledLocalStreamAdapter (explicit opt-in test adapter; external SSRF intact)
  → assertAcquisitionPermitted + createTrustedCacheAuthContext (fail-closed BEFORE lock/FFmpeg)
  → SharedIngestionCoordinator (Redis Lua atomic 1-owner lease + monotonic fencing token)
      ├─ 1 Owner (ACQUIRED_NEW / ACQUIRED_RECOVERY):
      │   1. FfmpegRollingSegmentBuffer (real FFmpeg stream-copy segmentation + ffprobe check + pinning)
      │   2. extractAudioSignalsFromSegments (FFmpeg 16kHz s16le PCM → per-second RMS dBFS & spike delta)
      │   3. CpuFirstHeuristicDetector (1 shared CPU analysis pass; optional injected chat signals)
      │   4. Durable MinIO pre-check (avoids re-render if Redis TTL expired while MP4 still exists)
      │   5. extractAndVerifyHighlightClip (FFmpeg concat/trim stream-copy w/ H.264/AAC fallback + ffprobe)
      │   6. SharedArtifactCacheService.putCachedArtifact (private MinIO object under cache/shared/...)
      │   7. coordinator.markReady (fenced by fencingToken; only AFTER durable MinIO write & validation)
      └─ 999 Concurrent Clippers (ATTACH_EXISTING / REUSE_READY):
          • Zero duplicate FFmpeg runs; wait on owner or verify durable MinIO object
          • Receive authorized presigned download URL for the exact same verified MP4
```

---

## 2. Controlled Test Media Fixture & Security Boundary

Implemented in `apps/api/src/media/live/controlled-stream.adapter.ts`:
- `ensureControlledLiveFixture()` deterministically generates a 30-second `1280x720 @ 30fps` H.264/AAC MP4 (`-g 30` 1-second keyframes for clean segment alignment) with quiet baseline audio (`-32 dBFS`, `220Hz`) and one loud highlight spike (`-4 dBFS`, `880Hz + 1320Hz`) during `16.0s–19.0s`.
- `ControlledLocalStreamAdapter` requires explicit `policy.enabled = true` and a verified `IMMUTABLE_BROADCAST` session identity.
- **SSRF Preserved:** Normal external URL ingestion (`resolveMediaSourceFromUrl`) continues to reject `file://`, loopback `127.0.0.1`, private networks, and cloud metadata endpoints. Local media access exists strictly inside this opt-in test adapter.

---

## 3. Real FFmpeg Rolling Segment Buffer & Disk Lifecycle

Implemented in `apps/api/src/media/live/rolling-segment-buffer.ts`:
- Slices incoming video bytes via FFmpeg (`-f segment -segment_time <N> -reset_timestamps 1 -c copy`) into ordered `.mp4` segments (`seg_000000.mp4`, ...).
- Probes every segment with `ffprobe` (`durationSec`, `width`, `height`, `sizeBytes`, `sha256`). Corrupt or 0-byte segments are marked `valid: false` (`corruptSegmentsSkipped++`) without crashing the worker.
- **Configurable Parameters:** `segmentDurationSec`, `maxRetentionSec`, `preEventSec`, `postEventSec`, `maxDiskBytes` (default 256 MiB), and `maxStreamDurationSec` (default 3600s).
- **Start-of-Stream & Post-Event Safety:** Clamps early events cleanly at `0s`; `isWindowReady(windowEndSec)` ensures clip extraction waits until required post-event footage has arrived (or end-of-stream is signaled).
- **Pinning & Safe Eviction:** Active clip jobs call `pinSegments(indices, leaseId)` and `unpinLease(leaseId)` in `finally`. `evictExpired()` deletes unpinned segments outside `maxRetentionSec` or exceeding `maxDiskBytes` from disk while never deleting pinned footage. `cleanupAll()` removes all temporary files on completion, failure, or cancellation.

---

## 4. CPU-First Audio Highlight Signals

Implemented in `apps/api/src/media/live/audio-signal-extractor.ts`:
- Decodes each buffered segment's audio via FFmpeg to 16kHz mono signed 16-bit PCM (`s16le`) in memory (zero temp WAV files).
- Computes per-second `rmsDb`, `peakDb`, median stream baseline (`baselineRmsDb`), and relative `deltaOverBaselineDb`.
- Feeds normalized `AUDIO_ENERGY` and `SPEECH_ACTIVITY` samples directly into `CpuFirstHeuristicDetector`.
- Supports typed injected synthetic chat signals (`CHAT_VELOCITY`, `CHAT_EXCITEMENT_KEYWORDS`) in tests without claiming real YouTube/Twitch/Kick live chat integration or running continuous vision models.
- **Measured Fixture Accuracy:** On the 30-second fixture (`16–19s` spike), baseline measures below `-20 dBFS`, spike exceeds `+15 dB` above baseline, yielding **1 true positive candidate** in `[15.5s, 19.5s]` and **0 false positives** across quiet intervals `[0–15s]` and `[20–30s]`.

---

## 5. Real Highlight MP4 Generation & Validation

Implemented in `apps/api/src/media/live/highlight-clip-extractor.ts`:
- Concatenates pinned buffered segments via FFmpeg concat demuxer and trims to `[windowStartSec, windowEndSec]`.
- **Stream-Copy First with Re-Encode Fallback:** Attempts fast `-c copy -movflags +faststart` first; if stream-copy fails or probed duration drifts outside bounds (or a custom video filter is requested), falls back automatically to frame-accurate `libx264` + `aac` re-encoding.
- **Deep `ffprobe` Validation (`probeAndValidateClipMp4`):** Rejects missing/0-byte files, missing video/audio streams, invalid/NaN durations, or duration drift beyond tolerance. Never trusts `.mp4` file extensions alone.

---

## 6. Shared Cache Reuse, Rights Authorization & Redis Lease Guarantees

Implemented in `apps/api/src/media/live/shared-live-pipeline.ts`:
- **Shared Cache Keys:** Reuses `SharedArtifactCacheService` + `TrustedCacheAuthContext`. Identical base clips map to the same `cacheKey` under `cache/shared/base_clip/...` in private MinIO. Different event windows, revisions, algorithm versions, or render settings produce distinct cache keys.
- **Private User Edits:** `renderPrivateUserEdit()` stores user-specific `customEditHash` clips strictly under `cache/private/<ownerUserId>/...`. Cross-user access is denied with `ACCESS_DENIED`.
- **Redis Lease & Fencing Guarantees:**
  - Atomic Redis Lua scripts guarantee 1 active work owner with O(1) compact lock record (`< 350 bytes` even at `attachedCount = 1000`).
  - Owner renews lease during FFmpeg processing and fences `markReady` with `fencingToken` ONLY AFTER durable MinIO write & probe validation succeed.
  - Stale workers whose lease expired during FFmpeg are rejected with `LEASE_EXPIRED` and cannot publish over a recovery worker.
- **Failure Recovery Verified:**
  - Storage write failure / worker crash → marks `FAILED`, cleans temp files, next worker recovers via `ACQUIRED_RECOVERY`.
  - Redis key loss / TTL expiry → next worker checks durable MinIO before FFmpeg clip extraction and reuses the existing MP4 without re-rendering.
  - Missing MinIO object while Redis says `READY` → `checkCachedArtifact` detects missing object, triggers recovery (`recoveryRuns++`), regenerates valid MP4, and re-uploads to MinIO.

---

## 7. Measured Local Prototype Results

Measured on local Docker Redis (`redis://localhost:6379`) + local Docker MinIO (`http://127.0.0.1:9002`, bucket `autoedit-local`) + `ffmpeg-static`:

| Measurement | Observed Value |
| :--- | :--- |
| Controlled Fixture | 30.0s, `1280x720 @ 30fps`, `h264/aac` |
| Extracted Base Highlight MP4 | `9,181,225 bytes` (~8.76 MiB), `10.016s`, `1280x720`, `h264/aac`, `stream-copy` |
| 1,000 Concurrent Clippers Fan-In | `~5.97s` total; **1** `ACQUIRED_NEW`, **999** `ATTACH_EXISTING`/`REUSE_READY`; **1** source job, **1** analysis pass, **1** FFmpeg render |
| 5,000 Authorized Cached Download Requests | `~4.12s` total (signing 5,000 authorized presigned URLs + MinIO existence verification); **0** additional FFmpeg renders |
| Redis Coordination Record Size (at 1,000 clippers) | `< 350 bytes` (`attachedCount: 1000`, constant O(1)) |

> **Important Scope Disclaimer:** These tests prove **functional deduplication, authorization enforcement, and real FFmpeg/MinIO/Redis integration** on a single local machine. They are **not** a production multi-node bandwidth or throughput benchmark and do not claim measured production cost savings percentages.

---

## 8. Limitations & Requirements Before Production

1. **Test-Only Rights Fixtures:** Step 3B.5 authorizes controlled test media via an explicit test-only policy object. Production **must** replace this with persistent authoritative rights & ownership records in PostgreSQL (`MediaSource`, `SharedCacheEntry`).
2. **Real Platform Acquisition (Deferred):** YouTube, Twitch, and Kick live/VOD acquisition adapters (using approved, rights-compliant platform methods without bypassing DRM/paywalls) are intentionally out of scope for Step 3B.5.
3. **Distributed Multi-Node Fan-In:** In-process single-flight waiters (`activeRuns`) deduplicate concurrent requests inside one API/worker node; multi-node production deployments should pair `RedisCoordinationStore` with Redis Pub/Sub or BullMQ job-completion notifications so remote nodes await completion without polling.
4. **CDN / Edge Delivery:** Serving 5,000+ simultaneous actual MP4 byte transfers in production requires a CDN/edge cache in front of signed S3/R2 origin URLs.
