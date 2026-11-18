# AutoAI Edit — Continuous Livestream Ingestion & Real-Time Highlight Generation (Step 3B.6)

## 1. What Changed from the Prerecorded Prototype (Step 3B.5 → Step 3B.6)

| Dimension | Step 3B.5 / 3B.5.1 (Prerecorded Fixture) | Step 3B.6 (Continuous Livestream) |
| :--- | :--- | :--- |
| **Source Arrival** | Full 30s fixture segmented upfront before analysis | Time-paced incremental segment delivery (`ControlledRealTimeStreamAdapter`); segment `i+1` does not exist on disk while segment `i` is ingested & analyzed |
| **Audio Analysis** | Batch scan over all segments after segmentation completes | `IncrementalAudioSignalTracker`: decodes strictly 1 newly arrived segment at a time with a bounded 120-bucket 35th-percentile rolling baseline |
| **Highlight Detection** | Single batch `evaluate()` pass returning top 1 highlight | `CpuFirstHeuristicDetector.evaluateIncremental()` with bounded sample retention & persistent cooldown across segments, detecting **multiple distinct highlights** during one active broadcast |
| **Clip Finalization** | Rendered only after entire fixture finished ingesting | Non-blocking background extraction triggered immediately once `checkCandidateWindowReadiness()` reports pre-event + post-event footage available—**while the stream stays LIVE** |
| **Late / Remote Clippers** | Waited for full source + clip completion | Attached remote instances can receive `first_highlight` while `streamStatus === 'LIVE'`, or reuse all cached highlights via `REUSE_READY` after stream ends with 0 FFmpeg renders |
| **Interrupted Streams** | Restarted clip stage from scratch | Persists already-finalized highlights to MinIO before failing; recovery worker (`ACQUIRED_RECOVERY`) reuses cached highlights with 0 duplicate renders |

---

## 2. Real Incremental Time-Paced Segment Arrival

Implemented in `apps/api/src/media/live/controlled-stream.adapter.ts`:

- **3-Event Controlled 60s Fixture (`ensureControlledMultiEventLiveFixture`):** Generates a deterministic `1280x720 @ 30fps` H.264/AAC MP4 (`-g 30` 1-second keyframes) with quiet baseline (`-32 dBFS`, `220Hz`) and **three distinct events** separated by quiet intervals (`6–26s`, `29–46s`, `49–60s`):
  1. **Early event (`4–6s`):** Loud spike (`880Hz + 1320Hz`) testing start-of-stream pre-event clamping (`0s`) and rapid early detection.
  2. **Midstream loud event (`26–29s`):** Multi-harmonic burst (`660Hz + 1320Hz + 1760Hz`) testing full pre-event + post-event rolling buffer capture while live.
  3. **Later modulated event (`46–49s`):** Distinct 3Hz amplitude-modulated harmonic pattern (`550Hz + 1100Hz`) testing multi-highlight extraction and late-stream retention.
- **No Premature Full-File Processing (`ControlledRealTimeStreamAdapter`):**
  - On every paced tick (`segmentPaceMs`, default `250ms`), slices **only segment `i`** on demand via FFmpeg input-seeking (`-ss <startSec> -i fixturePath -t <segDur> -c copy -avoid_negative_ts make_zero`).
  - Uses a **bounded producer-consumer queue (`maxQueueSize`)** with backpressure: if consumption slows, the producer pauses instead of buffering unbounded files.
  - Exposes `onStart`, `onSegment`, `onEnd`, `onError`, `AbortSignal` cancellation (`SIGKILL` on active FFmpeg slice), deterministic replay (`startFromSegmentIndex`, `maxSegments`), and deterministic fault injection (`injectCorruptAtIndex`, `injectMissingAtIndex`, `reorderSwapIndex`, `failAtSegmentIndex`).
  - **Security Boundary Preserved:** Explicit opt-in test adapter requiring `policy.enabled === true` and `IMMUTABLE_BROADCAST` identity. Normal external HTTP URL routes (`resolveMediaSourceFromUrl`) never accept local filesystem paths and preserve all SSRF/private-network protections.

---

## 3. Continuous Rolling Buffer & Readiness API

Extended in `apps/api/src/media/live/rolling-segment-buffer.ts`:

- **`appendIncomingSegment()`:** Copies each arriving segment into the buffer scratch directory, validates via `ffprobe` + SHA-256 (skipping corrupt segments safely without crashing), tracks sequence gaps (`gapsDetected`) and out-of-order late segments (`lateSegmentsReceived`), updates `peakDiskBytes`, and calls `evictExpired()` automatically while protecting pinned segments.
- **Readiness API (`getBufferedTimeRange()` & `checkCandidateWindowReadiness()`):**
  - `preEventAvailable`: Earliest covering valid segment reaches `windowStartSec` (or index `0` when clamped at `0s`).
  - `postEventAvailable`: `latestBufferedSec >= windowEndSec` while live, or `streamEnded && latestBufferedSec > eventTimestampSec`.
  - `hasMissingGap`: Flags interior gaps exceeding `max(1.0s, segmentDurationSec * 0.75)` so clips are not extracted from incomplete windows prematurely.
  - `canFinalize`: True as soon as pre-event + post-event footage is buffered—**without waiting for the stream to end**.

---

## 4. Incremental CPU-First Detection & Non-Blocking Clip Finalization

Implemented across `audio-signal-extractor.ts`, `highlight-detector.ts`, and `continuous-live-session.ts`:

1. **Incremental Per-Segment Audio Analysis (`IncrementalAudioSignalTracker`):**
   - Decodes **strictly 1 newly arrived segment** to 16kHz mono PCM in memory (`segmentsAnalyzedCount === validSegmentsReceived`, never re-analyzing history).
   - Maintains a bounded `120`-bucket rolling RMS history and uses the **35th-percentile** as the online quiet baseline (preventing an early highlight from inflating the baseline).
   - Runs 100% on CPU with zero continuous vision AI or paid APIs, working natively on audio-only streams and supporting optional synthetic chat signals.
2. **Bounded Incremental Detector (`CpuFirstHeuristicDetector.evaluateIncremental`):**
   - Prunes samples older than `maxRetentionSec` (and caps retained samples) to keep memory strictly O(1) over multi-hour streams.
   - Persists `lastEmittedEventSec` and `evaluatedBucketKeys` across incremental calls so one prolonged event spanning adjacent segments emits **strictly 1 candidate**, while distinct events separated by `cooldownSec` emit multiple highlights.
3. **Concurrent Clip Finalization While Streaming (`ContinuousLiveSessionService`):**
   - As soon as a candidate is detected, relevant segments are pinned (`pinSegments`).
   - On each subsequent segment arrival, `triggerReadyCandidates()` checks `checkCandidateWindowReadiness()` and keeps post-event segments pinned.
   - Once `canFinalize === true`, background extraction launches asynchronously (bounded by `maxConcurrentClipExtractions`, default `2`) so **segment ingestion never pauses for FFmpeg clip rendering**.
   - Each clip acquires Layer C Redis coordination (`buildClipWorkId`), extracts via `extractAndVerifyHighlightClip`, validates codecs/duration via `ffprobe`, uploads an immutable versioned MP4 (`/v/gen-<token>-<sha12>.mp4`) + `.manifest.json` to MinIO, updates the **Live Session Manifest** (`streamStatus: 'LIVE'`), invokes `onHighlightReady`, and unpins segments in `finally`.

---

## 5. Shared Source Ingestion, Late Joining & Recovery

- **One Ingestion Owner per Broadcast:** All clippers across independent `SharedLiveProcessingService` instances coordinate on `sessionWorkId = buildSourceWorkId(canonicalId, '<rev>_live_s<segDur>_<renderHash>')` in Redis. Strictly **1** worker wins `ACQUIRED_NEW`; all others receive `ATTACH_EXISTING` or `REUSE_READY` and never start FFmpeg.
- **Remote Live Discovery & Late Joiners:**
  - Remote instances using `waitMode: 'first_highlight'` poll the MinIO session manifest (with in-flight read coalescing) and receive verified Highlight #1 **while `streamStatus === 'LIVE'`**.
  - Late-joining clippers arriving after completion hit `REUSE_READY`, verify clip manifests/ETags, and receive short-lived presigned URLs with **0** FFmpeg runs.
- **Worker Reliability & Interrupted-Stream Recovery:**
  - Continuous non-overlapping lease heartbeat renews `sessionWorkId` every `max(150ms, leaseMs / 3)` ms; lease loss or caller `AbortSignal` immediately triggers `ownerAbort` → `SIGKILL` on active FFmpeg processes and cleans up scratch directories.
  - If an active owner fails mid-stream after finalizing Highlight #1, it persists `streamStatus: 'FAILED'` with already-completed highlights in MinIO. A recovery worker wins `ACQUIRED_RECOVERY` (`fencingToken++`), reuses Highlight #1 from MinIO (`reusedFromCache: true`, 0 duplicate renders), and finishes the remaining highlights.
- **Private Isolation:** Personalized user edits (`renderPrivateUserEdit`) remain strictly under `cache/private/<ownerUserId>/...` with `ACCESS_DENIED` across users; unauthorized/DRM sources fail closed before touching Redis or MinIO.

---

## 6. Exact Measured Local Prototype Results

Measured on local Docker Redis (`redis://localhost:6379`) + local Docker MinIO (`http://127.0.0.1:9002`, bucket `autoedit-local`) + `ffmpeg-static`:

| Metric | Controlled Local Measurement |
| :--- | :--- |
| Fixture | 60.0s, `1280x720 @ 30fps`, `h264/aac`, 3 events (`4–6s`, `26–29s`, `46–49s`), 15 × 4s segments paced at `220ms` |
| **First Segment Arrival → First Detection** | **507 ms** |
| **First Detection → First Clip Ready (MinIO + `ffprobe`)** | **1,076 ms** |
| **Segment Ingestion Rate** | **2.69 segments/sec** (paced test stream) |
| **Distinct Events Detected / False Positives** | **3 detected / 0 false positives** across all quiet intervals |
| **Highlights Ready While Stream Still Active** | **2 / 3 ready while LIVE** (Highlight #1 finalized at segment **5 / 15**) |
| **Ingestion Continued During Clip Render** | **Yes (`true`)** |
| **Incremental Analysis Passes** | **15** (`segmentsAnalyzedCount === validSegmentsReceived`, strictly 1 pass/segment) |
| **FFmpeg Clip Extractions (3-Event Stream)** | **3** (1 per distinct highlight; 0 duplicate renders) |
| **Continuous Lease Heartbeat Renewals** (`leaseMs=1200ms`) | **13 renewals** |
| **Peak Buffer Scratch Disk Usage** | **54.94 MB** (bounded `< 64 MB`; **0 files remaining** after cleanup) |
| **Peak Node Heap Used** | **42.2 MB** |
| **Multi-Instance Fan-In (1,000 clippers across 2 instances)** | **9,543 ms** total; **1** ingestion owner, **3** total clip renders, remote `first_highlight` delivered with `streamStatus = LIVE`, late joiner `REUSE_READY` (0 renders) |

> **Controlled Measurement vs. Production Projection:** All timings above come from local Docker Redis/MinIO and a 60s paced fixture (`220ms` per 4s segment ≈ 18x faster than real time). In real 1x live broadcasts with 4s HLS/DASH segments, detection-to-clip-ready latency is dominated by `postEventSec` (waiting for post-event wall-clock footage to happen, e.g. 4–15s) plus ~1s of FFmpeg extraction and S3 upload.

---

## 7. Durable Publication Safety Review (Required Section 9 Analysis)

### Current Prototype-Only Guarantee & Exact Crash/Restart Race
In Steps 3B.5.1 and 3B.6, manifest publication executes:
1. Upload immutable MP4 to `<storageKey>/v/gen-<fencingToken>-<sha12>.mp4`.
2. Renew Redis lease (`coordinator.renewLease`) to verify active ownership.
3. Read existing `.manifest.json` from MinIO and reject if `existing.fencingToken >= fencingToken`.
4. Write `.manifest.json` (`putObject`) and mark Redis `READY`.

**Why this is NOT full cross-Redis-loss transactional CAS:**
- **Race Window A (Redis Restart / Key Eviction):** If Redis restarts or evicts a coordination key mid-flight, a new worker starts at `fencingToken = 1`. Meanwhile, a paused worker from before the restart may still hold `fencingToken = 2` (or both hold `1`) and pass the manifest check or race between step 3 (`GetObject`) and step 4 (`PutObject`).
- **Race Window B (S3/MinIO Read-Modify-Write):** Even though S3/MinIO supports `IfNoneMatch: '*'` for immutable one-shot object creation (protecting `/v/gen-<token>-<sha12>.mp4` against accidental overwrites), S3 `PutObject` conditional `IfMatch` compares opaque ETags rather than enforcing a monotonic numeric predicate (`fencing_token < $new`), and still cannot coordinate monotonic token generation across Redis wipes.
- **Label:** The current Redis + MinIO manifest fencing is explicitly **prototype-only** (strong fencing while Redis keys remain resident; NOT cross-Redis-loss linearizable CAS). Immutable versioned MP4 objects ensure invalid/partial MP4s are never served and prior healthy objects are never corrupted in place.

### Narrowly Scoped PostgreSQL CAS Design (Next Persistence Milestone — No Migration in Step 3B.6)
When adding persistent cache metadata in PostgreSQL, replace the S3 `.manifest.json` overwrite pointer with a single atomic SQL compare-and-swap row:

```sql
-- Planned table for next persistence milestone (NOT applied in Step 3B.6)
CREATE TABLE shared_cache_artifacts (
  cache_key         TEXT PRIMARY KEY,
  canonical_source  TEXT NOT NULL,
  artifact_kind     TEXT NOT NULL,
  rights_scope      TEXT NOT NULL,
  owner_user_id     TEXT,
  fencing_token     BIGINT NOT NULL,
  object_key        TEXT NOT NULL,
  content_sha256    TEXT NOT NULL,
  etag              TEXT,
  size_bytes        BIGINT NOT NULL,
  probe_metadata    JSONB NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atomic linearizable publication (strictly monotonic fencing_token):
INSERT INTO shared_cache_artifacts (
  cache_key, canonical_source, artifact_kind, rights_scope, owner_user_id,
  fencing_token, object_key, content_sha256, etag, size_bytes, probe_metadata
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (cache_key) DO UPDATE
SET
  fencing_token  = EXCLUDED.fencing_token,
  object_key     = EXCLUDED.object_key,
  content_sha256 = EXCLUDED.content_sha256,
  etag           = EXCLUDED.etag,
  size_bytes     = EXCLUDED.size_bytes,
  probe_metadata = EXCLUDED.probe_metadata,
  updated_at     = NOW()
WHERE shared_cache_artifacts.fencing_token < EXCLUDED.fencing_token
RETURNING fencing_token, object_key;
```

- Pair this with a PostgreSQL sequence (`nextval('ingestion_fencing_seq')`) so fencing tokens remain globally monotonic even across Redis restarts, and return `0 rows` to reject any stale worker atomically inside PostgreSQL.

---

## 8. Next Steps Toward Permitted Live/VOD Acquisition & 100 Free Beta Users

### Next Platform Acquisition Steps
1. **Persistent Rights & Broadcast Registry:** Store authoritative `MediaSource`, `BroadcastSession`, and `SharedCacheArtifact` rows in PostgreSQL (replacing test-only policy objects).
2. **Permitted Platform Adapters:** Add compliant YouTube/Twitch/Kick VOD and broadcast metadata resolution & authorized stream-segment ingestion adapters behind `AcquisitionCapability` checks (no DRM/paywall bypass, no unauthorized scraping).
3. **Real-Time API Notification:** Expose SSE / WebSocket highlight-ready notifications from API nodes backed by Redis Pub/Sub so web clients see new live highlights without tight polling.

### What Changes for 100 Initial Free Beta Users (Affordable Non-GPU, Non-K8s Stack)
- **Topology:** 1 Vercel frontend + 1 API server + 1–2 affordable CPU worker VPS instances (e.g., 4–8 vCPU, 8–16 GB RAM, NVMe scratch disk) + managed Postgres + Redis + Cloudflare R2 (zero egress fees for cached base MP4 downloads!).
- **Concurrency Guardrails:** Limit concurrent live stream ingesters per worker (e.g., 4–8 streams per 4-vCPU box, since stream-copy segmentation + 16kHz PCM energy extraction uses very little CPU), cap `maxConcurrentClipExtractions = 2` per worker, enforce per-user render quotas and `maxDiskBytes` rolling buffer caps (`128–256 MiB` per active stream).
- **Garbage Collection:** Run a lightweight periodic cleanup cron to delete superseded immutable `/v/gen-*` objects older than 24 hours and expire unreferenced free-tier cache clips after a configurable TTL (e.g., 7 days).
