# AutoAI Edit — Durable Media Source Registry & Atomic Shared Artifact Publication (Step 3B.7)

## 1. Existing Architecture Audit & What Was Reused

Before introducing PostgreSQL persistence, we audited `apps/api/prisma/schema.prisma`, existing migrations (`init_full`, `add_ollama_error_category`, `backend_integrations`, `n8n_event_log_fields`), upload/render BOLA enforcement, `TrustedCacheAuthContext`, `SharedArtifactCacheService`, `SharedIngestionCoordinator`, `SharedLiveProcessingService`, and `ContinuousLiveSessionService`.

**Reused untouched (zero breaking changes):**
- `User`, `Project`, `Asset`, `Analysis`, `EditTimeline`, `EditVersion`, `Render`, `Job`, `Transcript`, `IntegrationAccount`, and upload session authorization (`upload-session.service.ts`).
- `CacheableSourceIdSchema`, `SharedCacheIdentity`, `buildSharedCacheIdentity`, `resolveAuthorizedCacheIdentity`, and Symbol-branded `TrustedCacheAuthContext`.
- `SharedIngestionCoordinator` + `RedisCoordinationStore` (kept as fast-path coordination).
- `FfmpegRollingSegmentBuffer`, `extractAudioSignalsFromSegments`, `CpuFirstHeuristicDetector`, `extractAndVerifyHighlightClip`, `probeAndValidateClipMp4`, and `MediaStorageProvider` (MinIO/S3).

---

## 2. Database Schema Rationale

Implemented in `apps/api/prisma/schema.prisma` (migration `20261118072748_durable_media_registry_and_cas`):

1. **`MediaSource`:** Durable canonical registry supporting **both** continuous live broadcast sessions (`IMMUTABLE_BROADCAST`, `LIVE`), recorded VODs (`IMMUTABLE_VOD`, `VOD`), and direct user uploads (`IMMUTABLE_UPLOAD`, `UPLOADED`). Stores lightweight metadata only (never media blobs, credentials, or secrets). Nullable `Project.mediaSourceId` lets many users' private `Project` rows reference one shared eligible `MediaSource` while keeping every user's `Project`, `EditTimeline`, `EditVersion`, and `Render` isolated.
2. **`MediaRightsGrant`:** Auditable permission grant ledger recording `grantScope` (`ACQUISITION_ONLY`, `SHARED_REUSE`, `PRIVATE_OWNER`), `allowAcquisition`, `allowSharedReuse`, `provenance`, `grantedBy`, `expiresAt`, and `revokedAt`/`revokedReason`.
3. **`SharedCacheArtifact`:** Authoritative logical artifact registry keyed by unique deterministic `cacheKey` (covering `SOURCE_SEGMENT`, `HIGHLIGHT_ANALYSIS`, `BASE_CLIP`, etc.). Holds the durable monotonic generation counter (`latestReservedGen`), active attempt pointer (`activeAttemptId`), and the authoritative published immutable object pointer (`publishedGeneration`, `publishedObjectKey`, `contentSha256`, `etag`, `sizeBytes`, `mediaMetadata`).
4. **`SharedArtifactAttempt`:** Per-generation worker attempt ledger (`UNIQUE(artifactId, generation)`) tracking `workerId`, `leaseExpiresAt`, `state` (`RESERVED`, `UPLOADED`, `COMMITTED`, `ABANDONED`, `SUPERSEDED`, `FAILED`), uploaded immutable `objectKey`, and `cleanupEligibleAfter`/`cleanedUpAt` for safe delayed garbage collection.

---

## 3. Source Identity Rules & Live/VOD Relationships

- **Immutable Canonical IDs Only:** `DurableMediaRegistryService.registerOrGetMediaSource()` validates `canonicalId` with `CacheableSourceIdSchema` and rejects mutable channel-only discovery IDs (`:channel:`) with `BROADCAST_UNRESOLVED`.
- **Single Shared Record:** Multiple users registering the same immutable broadcast (`twitch:broadcast:<channel>:<sessionId>`) or VOD (`youtube:vod:<id>`) converge atomically on one unique `MediaSource` row without duplicating records or altering server grants.
- **Distinct Broadcasts & Live/VOD Separation:**
  - Two broadcasts on the same channel share `channelId` (`twitch:channel:shroud`) while retaining strictly distinct `canonicalId` and `broadcastId` values.
  - A recorded VOD later created from a livestream remains a distinct `MediaSource` (`sourceType = VOD`, distinct `canonicalId`), optionally linked via `associatedLiveSourceId` without mixing live and VOD cache keys.
- **Direct User Uploads:** Require `ownerUserId`, default to `rightsStatus = USER_OWNED`, `rightsScope = PRIVATE_USER`, `acquisitionCapability = DIRECT_UPLOAD`, and cannot be granted `SHARED_REUSE` (`ACCESS_DENIED`).

---

## 4. Rights, Permission Provenance & Shared/Private Boundaries

- **Network Allowlisting ≠ Content Rights:** Registering any public external URL (`youtube`, `twitch`, `kick`, `direct_media`) defaults fail-closed to `rightsStatus = UNKNOWN`, `acquisitionCapability = UNSUPPORTED`, `rightsScope = NONE`, `rightsProvenance = UNVERIFIED`.
- **Server-Authoritative `TrustedCacheAuthContext`:** `DurableMediaRegistryService.resolveServerTrustedAuth()` loads `MediaSource` + active (non-revoked, non-expired) `MediaRightsGrant` rows from PostgreSQL and builds the frozen, Symbol-branded `TrustedCacheAuthContext`. Untrusted client JSON can never assert `PERMITTED_PUBLIC`, `ownerUserId`, or `storageKey`.
- **Immediate Revocation:** `revokeSourceRights()` marks grants `revokedAt = NOW()` and downgrades `MediaSource.rightsStatus`/`rightsScope` inside a transaction. Every subsequent cache read, publication, and download immediately fails with `ACCESS_DENIED`.
- **Strict Private Isolation:** `PRIVATE_USER` artifacts are keyed under `cache/private/<ownerUserId>/...` and verified against both `TrustedCacheAuthContext` and `SharedCacheArtifact.ownerUserId`. Cross-user access to private uploads, private clips, or another user's `Project` fails with `ACCESS_DENIED`.

---

## 5. PostgreSQL Transactional Compare-and-Swap (CAS) Algorithm

Implemented in `apps/api/src/media/durable-artifact-publisher.ts`:

```
1. RESERVE GENERATION (PostgreSQL TX + Exclusive Row Lock)
   - INSERT INTO "SharedCacheArtifact" (...) ON CONFLICT ("cacheKey") DO NOTHING
   - SELECT "id" FROM "SharedCacheArtifact" WHERE "cacheKey" = $key FOR UPDATE
   - If PUBLISHED and !forceRepair -> return ALREADY_PUBLISHED
   - If forceRepair and publishedGeneration > expectedPublishedGeneration -> return ALREADY_PUBLISHED
   - If activeAttempt exists and leaseExpiresAt > NOW() -> return ALREADY_IN_PROGRESS
   - Else: mark any expired attempt SUPERSEDED, increment nextGen = latestReservedGen + 1
           (NEVER resets on Redis flush/restart!), insert SharedArtifactAttempt(gen=nextGen, RESERVED),
           set activeAttemptId = attempt.id, state = (publishedGeneration > 0 ? 'REPAIRING' : 'PENDING')
           (preserving publishedObjectKey & publishedGeneration 100% intact during repair!).

2. PROCESS & UPLOAD IMMUTABLE OBJECT (Outside DB TX — zero DB lock held during FFmpeg/S3 I/O)
   - Run FFmpeg + ffprobe validation + compute genuine content SHA-256 (never cacheKey).
   - Upload immutable bytes to `<storageKeyPrefix>/v/gen-<gen>-<sha12>.<ext>`.
   - Record `objectKey`, `contentSha256`, `etag`, `sizeBytes` on SharedArtifactAttempt (state = UPLOADED).

3. CONDITIONAL CAS PROMOTION (PostgreSQL TX + Exclusive Row Lock)
   - Re-verify server rights/grants (blocks commit if rights were revoked mid-render!).
   - SELECT "id" FROM "SharedCacheArtifact" WHERE "id" = $artifactId FOR UPDATE
   - Require ALL of:
       artifact.activeAttemptId === attemptId
       && artifact.latestReservedGen === generation
       && artifact.publishedGeneration < generation
       && attempt.workerId === workerId
       && attempt.state IN ('RESERVED', 'UPLOADED')
   - If ANY check fails (stale worker after Redis wipe, race loser, superseded attempt):
       mark attempt SUPERSEDED with cleanupEligibleAfter = NOW() + graceMs; throw LEASE_EXPIRED.
       Published pointer is NEVER overwritten.
   - If ALL checks pass:
       mark prior COMMITTED attempts SUPERSEDED (with grace window),
       mark current attempt COMMITTED,
       update SharedCacheArtifact (state='PUBLISHED', publishedGeneration=gen,
       activeAttemptId=null, publishedObjectKey, contentSha256, etag, sizeBytes, mediaMetadata).

4. FAILURE / CANCELLATION / TX ROLLBACK
   - DB error inside commit tx rolls back atomically; abortPublicationAttempt marks attempt
     FAILED/ABANDONED for delayed cleanup and restores state='PUBLISHED' if a prior published
     object exists (preserving the healthy artifact!).

5. DELAYED SAFE ORPHAN CLEANUP
   - cleanupAbandonedGenerations() deletes ONLY attempts where state IN (ABANDONED, SUPERSEDED, FAILED)
     AND cleanupEligibleAfter <= NOW() AND objectKey !== artifact.publishedObjectKey
     AND zero COMMITTED attempts reference objectKey.
```

---

## 6. Redis vs. PostgreSQL Responsibilities

| Responsibility | Redis (`SharedIngestionCoordinator`) | PostgreSQL (`DurableMediaRegistry` + `DurableArtifactPublisher`) |
| :--- | :--- | :--- |
| Authoritative Rights, Grants & Revocation | Never | **Source of Truth** |
| Authoritative Current Published Artifact Pointer | Never | **Source of Truth** |
| Monotonic Publication Generation & CAS | Fast-path only | **Source of Truth (survives Redis flush/restart)** |
| High-Fanout Waiter Deduplication (1,000 clippers) | **Primary fast path** (sub-ms Lua + coalesced polling) | Fallback & authoritative reservation |
| Permanent Storage of MP4 Media Blobs | Never | Never (MinIO/S3 immutable objects only) |

---

## 7. Cache Read Authorization, Corrupt Handling & Signed URL Caveat

On every read (`getAuthorizedPublishedArtifact` / `inspectAuthorizedPublishedArtifact`):
1. Authenticate `requesterUserId` and load authoritative `MediaSource` + active `MediaRightsGrant`s from PostgreSQL.
2. Reconstruct deterministic `SharedCacheIdentity` from server-trusted context + descriptor (no user-supplied keys).
3. Load authoritative `SharedCacheArtifact` from PostgreSQL (never serving uncommitted `PENDING` rows).
4. Verify object existence, `Content-Length === sizeBytes`, and `ETag === artifact.etag` in MinIO (plus SHA-256 + `ffprobe` when `verifyMediaIntegrity: true`). Missing/corrupt objects throw `SOURCE_UNAVAILABLE` / `ARTIFACT_CORRUPT` and trigger single-winner conditional repair passing the exact observed `publishedGeneration`.
5. Issue a **short-lived** signed private-object download URL (default **300 seconds / 5 minutes**).

> **Signed URL Revocation Limitation:** Standard S3/MinIO/R2 presigned URLs remain valid until their signature expires even if database rights are revoked seconds later. Keeping TTL short (`300s`), re-checking PostgreSQL rights on every download-URL request, and never caching signed URLs long-term limits exposure to the remaining seconds of an already-issued URL.

---

## 8. Migration Safety & Rollback Considerations

- Migration file: `apps/api/prisma/migrations/20261118072748_durable_media_registry_and_cas/migration.sql`.
- **100% Additive:** Adds 10 new enums, 4 new tables (`MediaSource`, `MediaRightsGrant`, `SharedCacheArtifact`, `SharedArtifactAttempt`), 1 nullable column `Project.mediaSourceId`, and indexes/foreign keys with `ON DELETE SET NULL` on `Project`/`User`.
- **Zero Impact on Existing Data:** Existing `User`, `Project`, `Asset`, `EditVersion`, `Render`, and upload sessions are untouched.
- **Safe Rollback:** If ever reverted before production use, drop the 4 new tables, drop `Project.mediaSourceId`, and drop the 10 new enums with zero loss to existing user/project data.
- **Not Applied to Production:** Applied strictly to local Docker PostgreSQL (`autoedit_local`) for verification.

---

## 9. Verified Local Test Results

Measured on local Docker PostgreSQL (`autoedit_local`), local Docker Redis (`6379`), local Docker MinIO (`http://127.0.0.1:9002`), and `ffmpeg-static`:

| Scenario Verified | Observed Local Result |
| :--- | :--- |
| Public URL default rights | `UNKNOWN` / `UNSUPPORTED` / `NONE` — fails closed (`RIGHTS_UNVERIFIED`) |
| Same VOD & same broadcast across multiple users | 1 `MediaSource`, 1 `SharedCacheArtifact`, 1 FFmpeg render; `reusedFromDbCache = true` |
| Two broadcasts on same channel + associated VOD | Strictly distinct `MediaSource` rows & cache keys |
| Different clip render settings (`640x360` vs `1280x720`) | Reuses upstream `SOURCE_SEGMENT` & `HIGHLIGHT_ANALYSIS` (`0` extra upstream runs); creates distinct `SharedCacheArtifact` |
| Redis wiped between acquisition & commit + stale worker | PostgreSQL CAS atomically rejects stale `gen=1` worker (`LEASE_EXPIRED`); `gen=2` preserved |
| Concurrent DB reservation race | `SELECT ... FOR UPDATE` grants strictly 1 `RESERVED` + 1 `ALREADY_IN_PROGRESS` |
| Process restart + Redis key wipe | New service instance reuses PostgreSQL+MinIO `gen=2` with `0` FFmpeg renders |
| 16 concurrent missing-object repair requests (Redis wiped) | Strictly **1** repair winner (`gen=2`), **1** FFmpeg render across 2 instances |
| Same-length corrupt MP4 overwrite | Rejected (`ARTIFACT_CORRUPT`), never served, repaired to `gen=3` |
| DB commit tx rollback & worker cancellation | Preserves previously published valid `gen=3` intact & `ffprobe`-valid |
| Safe delayed retention cleanup | Deletes unreferenced orphan/superseded objects; never deletes active `publishedObjectKey` |
| Rights revocation after clip creation | Immediately blocks reads & requests (`ACCESS_DENIED`) |
| **DB-Backed 1,000 Concurrent Clippers (2 instances)** | **6,325 ms**; **1** source job, **1** analysis pass, **1** FFmpeg render, `publishedGeneration = 1` |
| **5,000 Authorized Cached Download Requests** | **4,380 ms** (`heapDelta = 54.5 MB`), **0** additional FFmpeg renders |

> **Verified vs. Projected:** These tests prove functional correctness, linearizable PostgreSQL CAS, rights enforcement, and bounded local memory/pool usage on one machine. They are **not** a multi-node production bandwidth or CDN egress benchmark.

---

## 10. Implications for 100 Free Beta Users & Next Requirements

- **Affordable Beta Footprint:** One managed PostgreSQL database (small plan), one Redis instance, 1–2 modest CPU worker VPS nodes, and Cloudflare R2 easily support 100 free beta users because 1,000 clippers sharing an eligible clip generate only O(1) FFmpeg runs and O(1) PostgreSQL rows.
- **Remaining Requirements for Real Platform Acquisition:**
  1. Permitted YouTube, Twitch, and Kick metadata/VOD/stream acquisition adapters behind explicit `AcquisitionCapability` & rights verification (zero DRM/paywall bypass).
  2. Authenticated HTTP API endpoints for submitting universal URLs, linking Projects to `MediaSource`, and requesting short-lived signed downloads of eligible shared artifacts.
  3. Periodic background job calling `cleanupAbandonedGenerations()` and expired cache retention cleanup.
  4. CDN / edge caching in front of private R2/S3 signed URLs for high-bandwidth real MP4 delivery.
