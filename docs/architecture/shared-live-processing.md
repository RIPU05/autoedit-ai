# AutoAI Edit — Distributed Shared Livestream Ingestion & Highlight Cache Prototype (Steps 3B.5 & 3B.5.1)

## 1. Overview & What Each Milestone Proved

### What Step 3B.5 (Same-Instance Prototype) Proved
Step 3B.5 proved the single-process end-to-end media mechanics on real local FFmpeg, Redis, and MinIO:
- Real FFmpeg stream-copy segmentation into a rolling buffer (`FfmpegRollingSegmentBuffer`).
- Real CPU-first audio energy + spike detection (`extractAudioSignalsFromSegments` + `CpuFirstHeuristicDetector`).
- Real FFmpeg highlight clip extraction with stream-copy/re-encode fallback and `ffprobe` validation (`extractAndVerifyHighlightClip`).
- Private MinIO storage via `SharedArtifactCacheService` with fail-closed rights checks and isolated `PRIVATE_USER` edits.
- Same-instance fan-in of 1,000 clippers using an in-process `activeRuns` Map paired with Redis coordination.

However, independent review identified four distributed-systems gaps when running **multiple independent service instances or separate OS processes**:
1. Cross-instance `ATTACH_EXISTING` could fall through into `executeRealProcessing()` when the owner promise was not in the local process's `activeRuns` Map.
2. Coordination keyed only on `canonicalSourceId` conflated source acquisition with downstream algorithm/render-setting clip variants.
3. Missing-artifact recovery bypassed fencing with `fencingToken: undefined`, allowing concurrent repair races and stale-worker overwrites, and reused fabricated probe metadata (`sha256: cacheKey`) on Redis key loss.
4. No continuous lease heartbeat or FFmpeg child-process cancellation existed for long-running FFmpeg work.

### What Step 3B.5.1 (Distributed Hardening) Proves
Step 3B.5.1 resolves all four distributed gaps and proves coordination across **multiple independent `SharedLiveProcessingService` instances** AND **two separate Node OS processes** sharing **only** live local Redis and live local MinIO (with completely separate process-local memory and scratch directories).

```
Authorized Broadcast Input (ControlledLocalStreamAdapter; external SSRF intact)
  → assertAcquisitionPermitted + createTrustedCacheAuthContext (fail-closed BEFORE Redis/MinIO)
  → Layer A: Source Acquisition   workId = <canonicalId>::src::<rev>_s<segDur>
       • 1 owner runs FFmpeg segmentation ONCE → uploads immutable segments + SourceManifest to MinIO
       • Remote instances wait via bounded Redis polling or reuse verified SourceManifest
  → Layer B: Source Analysis      workId = <canonicalId>::ana::<hash16(rev,algo,threshold,cooldown,buf)>
       • 1 owner runs CPU audio analysis ONCE → uploads AnalysisManifest (HighlightWindowCandidate) to MinIO
       • Reuses Layer A segments from MinIO (0 duplicate source FFmpeg segmentation)
  → Layer C: Derived Base Clip    workId = <canonicalId>::clip::<clipCacheKey[0..24]>
       • 1 owner runs FFmpeg clip extraction + ffprobe ONCE → uploads immutable /v/gen-<token>-<sha12>.mp4
       • Verifies active lease + monotonic manifest fencingToken → atomically publishes .manifest.json
       • Marks Redis READY only AFTER durable MP4 + verified manifest exist
       • 999 concurrent clippers across instances wait via bounded Redis polling → verify manifest + ETag → signed URL
```

---

## 2. Cross-Instance Coordination Strategy

Implemented in `apps/api/src/media/live/shared-live-pipeline.ts` (`runCoordinatedStage` & `waitForCoordinatedChange`):

- **Strict Ownership Rule:** Only a worker receiving `ACQUIRED_NEW`, `ACQUIRED_RECOVERY`, or `ACQUIRED_REPAIR` (each carrying a positive monotonic `fencingToken`) may execute FFmpeg or write artifacts.
- **No `ATTACH_EXISTING` Fall-Through:** When Redis returns `ATTACH_EXISTING`, the caller **never** enters `executeAsOwner()`. Instead, it enters a bounded cross-instance polling loop (`waitForCoordinatedChange`) with exponential backoff (`25ms → 40ms → 64ms → ... → 200ms` max).
- **Zero Process-Local Ownership or Artifact Caches:** `SharedLiveProcessingService` stores no `activeRuns` ownership map and no `readyCandidates` metadata map. All durable state (`SourceManifest`, `AnalysisManifest`, `ClipManifest`) lives in MinIO.
- **In-Flight-Only Read Coalescing:** To prevent 500 concurrent waiters waking up inside one Node process on the exact same tick from saturating S3/MinIO sockets, `localPollCoalescer` and `localDurableCheckCoalescer` coalesce simultaneous in-flight reads and delete their entry immediately in `finally` (zero TTL caching, fresh live checks on every subsequent call).
- **Owner Crash & Lease Expiry Recovery:** If the active owner transitions to `FAILED` / `EXPIRED`, or its `leaseExpiresAtMs <= Date.now()`, or the Redis key disappears, waiters break out and re-enter `requestIngestion()`. Redis Lua guarantees strictly **one** waiter wins `ACQUIRED_RECOVERY` with an incremented `fencingToken`.
- **Cancellation & Timeouts:** Waiters honor both `waitTimeoutMs` (`MediaSourceError` code `COORDINATION_TIMEOUT`) and caller `AbortSignal` (`REQUEST_CANCELLED`), releasing timers and listeners immediately without spawning FFmpeg.

---

## 3. Source vs. Analysis vs. Derived Clip Identity

Implemented in `apps/api/src/media/ingestion-coordinator.ts` and `shared-live-pipeline.ts`:

| Layer | Redis Coordination Work ID | Durable MinIO Artifact Kind | Parameters Included | Reused When |
| :--- | :--- | :--- | :--- | :--- |
| **A. Source** | `buildSourceWorkId(canonicalId, rev_segDur)` → `<id>::src::<rev>` | `SOURCE_SEGMENT` (`.manifest.json` + `/v/gen-<tok>-seg-*.mp4`) | `canonicalSourceId`, `sourceRevision`, `segmentDurationSec` | Downstream `renderSettings`, `algorithmVersion`, or clip windows differ |
| **B. Analysis** | `buildAnalysisWorkId(canonicalId, opts)` → `<id>::ana::<hash16>` | `HIGHLIGHT_ANALYSIS` (`.manifest.json`) | `sourceRevision`, `algorithmVersion`, `scoreThreshold`, `cooldownSec`, `bufferConfig`, synthetic signal hash | Downstream `renderSettings` differ for the same broadcast & algorithm |
| **C. Base Clip** | `buildClipWorkId(canonicalId, clipCacheKey)` → `<id>::clip::<key24>` | `BASE_CLIP` (`.manifest.json` + `/v/gen-<tok>-<sha12>.mp4`) | `sourceRevision`, `timeRangeSec`, `algorithmVersion`, `renderSettings` | Identical base clip requested across clippers/instances |
| **Private Edit** | No shared coordination | `BASE_CLIP` under `cache/private/<ownerUserId>/...` | `ownerUserId`, `customEditHash`, window, filter | Strictly same `ownerUserId` only (`ACCESS_DENIED` across users) |

All three scoped work IDs remain 100% backward-compatible with `CacheableSourceIdSchema` and continue to reject channel-only discovery IDs (`:channel:`).

---

## 4. Worker Lease Heartbeat & FFmpeg Cancellation

Implemented across `shared-live-pipeline.ts` (`runOwnerWithHeartbeat`), `rolling-segment-buffer.ts`, and `highlight-clip-extractor.ts`:

- Active owners schedule a non-overlapping renewal timer every `Math.max(100, Math.floor(leaseMs / 3))` ms, calling `coordinator.renewLease(...)` and incrementing `metrics.heartbeatRenewals`.
- Renewal stops immediately in `finally` on completion, failure, lease loss, or cancellation.
- If lease renewal fails (`LEASE_EXPIRED`) or the caller's `AbortSignal` fires, an internal `ownerAbort` `AbortController` immediately signals both `FfmpegRollingSegmentBuffer` and `extractAndVerifyHighlightClip`, sending `SIGKILL` to the active FFmpeg child process, cleaning up scratch files, and preventing any further object/manifest writes or `markReady` calls.

---

## 5. Coordinated Recovery, Atomic Publication & Stale-Worker Fencing

Implemented in `ingestion-coordinator.ts` (`INVALIDATE_READY_LUA`) and `shared-live-pipeline.ts`:

- **No `fencingToken: undefined` Bypass:** Missing or corrupt artifact recovery never bypasses coordination ownership.
- **Conditional Atomic Invalidation (`invalidateReadyArtifact`):** When a `REUSE_READY` (or waiter `READY`) check finds a missing or corrupt object in MinIO, callers invoke `coordinator.invalidateReadyArtifact({ canonicalSourceId, expectedArtifactRef, expectedFencingToken, repairWorkerId, leaseMs, maxRetries })`.
  - The single-key Redis Lua script verifies `rec.state == 'READY' && rec.artifactRef == expectedArtifactRef && rec.fencingToken == expectedToken`.
  - Strictly **one** caller wins `ACQUIRED_REPAIR` (state → `ACQUIRING`, `fencingToken` incremented).
  - Concurrent repair callers receive `CONFLICT_ALREADY_RECOVERING` and wait via bounded cross-instance polling without duplicating FFmpeg.
- **Immutable Objects + Atomic Manifest Cutover:**
  - MP4 files are written to immutable versioned keys: `<storageKey>/v/gen-<fencingToken>-<contentSha256_12>.mp4`.
  - If a replacement fails before manifest write, the previous healthy object and `.manifest.json` remain completely intact.
  - Before writing `.manifest.json`, the owner verifies active Redis lease (`renewNow()`) AND verifies any existing `.manifest.json` has `existing.fencingToken < fencingToken`. Stale workers cannot overwrite newer generations either in object storage or in the manifest.

---

## 6. Cache Validation & Real Media Verification

Implemented in `shared-live-pipeline.ts` (`loadAndVerifyClipManifest`) and `highlight-clip-extractor.ts` (`probeAndValidateClipMp4FromBuffer`):

- **Never Trust Size Alone or Fabricate Metadata:**
  - Every `ClipManifest` stores the real `ProbedClipMetadata` produced by `ffprobe` and real SHA-256 of the MP4 file bytes (`clipMeta.sha256` is strictly distinct from `cacheKey`).
  - On reuse, `loadAndVerifyClipManifest` validates: (1) manifest schema & candidate schema, (2) `clipMeta.sha256 !== cacheKey`, (3) authorized object-key prefix, (4) MinIO `HEAD` existence + exact `Content-Length === clipMeta.sizeBytes`, and (5) `ETag === manifest.etag` (catching even same-byte-length object corruption in O(1)).
  - On Redis-key-loss cold cache rehydration (or whenever `verifyMediaIntegrity: true`), full MP4 bytes are fetched and validated via SHA-256 + `probeAndValidateClipMp4FromBuffer` (`ffprobe`).
  - Corrupt objects are never served (`ARTIFACT_CORRUPT` on direct download; automatic atomic invalidation & regeneration on shared highlight requests).

---

## 7. Measured Local Prototype Results (Step 3B.5.1)

Measured on local Docker Redis (`redis://localhost:6379`) + local Docker MinIO (`http://127.0.0.1:9002`, bucket `autoedit-local`) + `ffmpeg-static`:

| Scenario / Measurement | Observed Result |
| :--- | :--- |
| Controlled Fixture | 30.0s, `1280x720 @ 30fps`, `h264/aac`, audio spike at `16.0–19.0s` |
| Extracted Base Highlight MP4 | `9,181,225 bytes` (~8.76 MiB), `10.016s`, `1280x720`, `h264/aac`, `stream-copy`, real `sha256=bc56ff731241...` |
| **1,000 Concurrent Clippers across 2 Independent Instances** (`500` instA + `500` instB) | `14.36s` total; **1** `ACQUIRED_NEW`, **999** `ATTACH_EXISTING`/`REUSE_READY`; **1** source job, **1** analysis pass, **1** FFmpeg render (`instA=1, instB=0`) |
| **2 Separate OS Node Processes** (parent + spawned child PID) | `5.54s` total; **1** source job, **1** analysis pass, **1** FFmpeg render across both PIDs; identical `cacheKey`, `objectKey`, and `sha256` |
| **5,000 Authorized Cached Download Requests** (across 2 instances) | `5.12s` total (`heapDelta=46.3 MB`); **0** additional FFmpeg renders; short-lived `600s` signed URLs |
| **16 Concurrent Missing-Object Repair Requests** (8 instA + 8 instB) | Strictly **1** `ACQUIRED_REPAIR` winner, **1** repair FFmpeg render, new immutable `gen-N` object published |
| **Same-Length Corrupt MP4 Overwrite** | Detected immediately (`corruptArtifactsDetected >= 1`), rejected on direct download (`ARTIFACT_CORRUPT`), atomically repaired & re-verified by `ffprobe` |
| **Long-Running Lease Heartbeat** (`leaseMs=600ms`, `1,100ms` work) | `heartbeatRenewals >= 3`, remote waiter stayed attached with `0` duplicate renders |
| Redis Clip Coordination Record Size (at 1,000 clippers) | `< 450 bytes` (`attachedCount: 1000`, constant O(1)) |

> **Honest Scope Disclaimer for the 5,000-Download Test:** The 5,000-request test measures **authorized cache lookups, manifest/metadata validation, and short-lived presigned URL issuance** on one local developer machine. It does **not** transfer 5,000 × 8.76 MiB (~43.8 GiB) of actual MP4 video bytes over a network and is **not** a CDN-scale delivery or multi-node bandwidth benchmark.

---

## 8. Remaining Limitations of Redis-Only Coordination

1. **Redis Restart / Eviction Durability:** Redis coordination keys are volatile (`PX recordTtlMs`, in-memory state). If Redis restarts or evicts a key mid-flight, another worker may acquire a fresh `fencingToken = 1`. Because MinIO manifests store monotonic `fencingToken` and immutable object keys, a fresh cold start will still rehydrate an already-published valid artifact without re-rendering, **but** true distributed mutual exclusion across Redis data loss requires durable transactional leases (e.g., PostgreSQL advisory/row locks or Raft-backed coordination).
2. **Polling Latency vs. Event-Driven Wakeup:** Bounded exponential backoff polling (`25–200ms`) is simple, reliable, and resilient to missed pub/sub messages, but adds small wakeup latency (~25–200ms) and periodic Redis `GET` load under many distinct active streams. Pairing Redis Pub/Sub or BullMQ completion events with a slower fallback poll is recommended at higher stream counts.
3. **Manifest Check-Then-Put Non-Atomicity in S3/MinIO:** Checking `existingManifest.fencingToken < fencingToken` followed by `putCachedManifest` prevents stale writes across normal timing windows, but standard S3 `PutObject` without conditional `If-Match` / DB CAS cannot provide strict linearizability if two workers somehow held concurrent leases after a Redis wipe. Recording active generation pointers in PostgreSQL (`UPDATE ... WHERE fencing_token < $new`) closes this theoretical window completely.
4. **Test-Only Rights Policy:** `ControlledLocalStreamAdapter` supplies an opt-in test policy. Production must hydrate `TrustedCacheAuthContext` strictly from authoritative PostgreSQL `MediaSource` / `Project` ownership and rights records.

---

## 9. What Remains for a Continuously Running Live Ingestion Service

1. **Authoritative PostgreSQL Persistence:** Persist `MediaSource`, `BroadcastSession`, `SharedCacheArtifact` (with CAS `fencingToken`), and `UserProject` rows so rights, ownership, and manifest generation pointers are transactionally durable.
2. **Permitted Platform Acquisition Adapters:** Implement compliant, rights-verified YouTube, Twitch, and Kick VOD/broadcast acquisition adapters behind `AcquisitionCapability` checks (without bypassing DRM, paywalls, or platform restrictions).
3. **Continuous Live Worker Daemon:** Long-lived BullMQ/worker processes that continuously ingest rolling HLS/DASH segments while a broadcast is `LIVE_NOW`, emit sliding-window `HighlightWindowCandidate` records in real time, and garbage-collect old immutable object generations after a grace window.
4. **CDN / Edge Delivery:** Put a CDN (CloudFront / Cloudflare R2 + signed edge URLs) in front of private object storage to serve thousands of concurrent real MP4 byte downloads at low egress cost.
