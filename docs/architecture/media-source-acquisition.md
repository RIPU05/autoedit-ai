# AutoAI Edit — Universal Media Source & Shared Ingestion Foundation (Step 3B.4 & 3B.4.1)

## 1. Universal User Input Concept & Product Vision

AutoAI Edit targets independent clippers, fan pages, Shorts/Reels/TikTok editors, and creator communities. From the user's perspective, there is one unified studio workflow:

1. User pastes a livestream/VOD URL (YouTube, Twitch, Kick) or uploads footage directly.
2. Backend resolves the input into a `UniversalMediaSource` contract and determines whether an approved, permitted acquisition method is available.
3. AI identifies highlight moments.
4. User edits in Auto, Prompt, Reference, or Manual mode on a private, non-destructive, versioned timeline.
5. User privately downloads the rendered MP4 and independently chooses whether and where to publish it.

Streamer account OAuth is **not** mandatory for independent clippers, and social media publishing remains outside the core editing pipeline.

---

## 2. Existing Ingestion Flow Audit

AutoAI Edit's active production ingestion pipeline handles direct user uploads:

```
Browser Multipart Upload
  → POST /api/upload/init     (private Project + 24h UploadSession + S3/MinIO multipart init)
  → POST /api/upload/part     (verifies UploadSession + project ownership → presigned part PUT URL)
  → POST /api/upload/complete (verifies session/ownership → completes multipart → creates 1:1 private Asset → enqueues BullMQ analysis)
  → analysis.worker.ts        (MediaStorageProvider download → FFmpeg probe/silence/audio → FasterWhisperTranscriptionProvider → runAiProvider → Transcript/Analysis/EditTimeline/EditVersion)
  → render.worker.ts          (downloads source → FFmpeg render → storage.putObject())
  → Private Download          (authenticated project-scoped presigned GET URL)
```

---

## 3. Channel Identity vs Broadcast Identity vs Canonical VOD Identity

A critical distinction in live media is the difference between a **mutable channel** (which hosts many separate broadcasts over time) and an **immutable broadcast session** (one specific livestream):

| Scope (`identityScope`) | Canonical ID Format | Example | Cacheable / Coordinatable? |
| :--- | :--- | :--- | :--- |
| **`CHANNEL_DISCOVERY`** | `<provider>:channel:<channel>` | `twitch:channel:shroud`, `kick:channel:xqc` | **NO** — Discovery input only. Blocked from ingestion locks and immutable cache reuse (`BROADCAST_UNRESOLVED`). |
| **`IMMUTABLE_BROADCAST`** | `<provider>:broadcast:<session>` | `youtube:broadcast:dQw4w9WgXcQ`, `twitch:broadcast:shroud:41928374650` | **YES** — Uniquely identifies one verified broadcast session. |
| **`IMMUTABLE_VOD`** | `<provider>:vod:<id>` | `youtube:vod:dQw4w9WgXcQ`, `twitch:vod:2284910293`, `kick:vod:9f8a7b6c-1234` | **YES** — Stable canonical VOD or clip identity. |
| **`IMMUTABLE_UPLOAD`** | `upload:uploaded:<assetId>` | `upload:uploaded:asset_clx001` | **YES (Private Only)** — Always `USER_OWNED`, isolated per user. |

### Key Identity Rules
1. **Consecutive Broadcasts Never Collide:** When a streamer ends broadcast `41928374650` and starts broadcast `41928399999`, binding each verified session via `bindVerifiedBroadcastSession()` yields distinct canonical IDs (`twitch:broadcast:shroud:41928374650` vs `twitch:broadcast:shroud:41928399999`).
2. **Never Fabricated:** If a platform broadcast session ID has not yet been verified, the source remains `CHANNEL_DISCOVERY` / `PENDING` (`BROADCAST_UNRESOLVED`). Timestamps or random UUIDs are never substituted for real broadcast identities.
3. **Livestream-to-VOD Separation:** A YouTube `/live/<id>` (`youtube:broadcast:<id>`) and `/watch?v=<id>` (`youtube:vod:<id>`), or a Twitch live broadcast and its later VOD, stay separate until explicitly associated.
4. **Canonical VOD Normalization:** Harmless tracking params (`si`, `utm_*`, `feature`, `t`, `pp`, `list`, `ref`, `fbclid`, `gclid`) and URL variants (`youtu.be/`, `m.youtube.com`, `/shorts/`, `/embed/`, `m.twitch.tv/<ch>/video/<id>`) normalize to one canonical VOD ID.

---

## 4. Target Scaling Model: "One Stream, Thousands of Clippers"

Target workload: 1 streamer broadcasting a major release → 1 shared acquisition → 1 shared analysis → 1,000 clippers → 5,000 downloads of one identical cached base clip.

- **Layer 1 (Shared Acquisition):** 1 active ingestion lease per immutable `CacheableSourceId`.
- **Layer 2 (Shared Source Analysis & Base Clips):** 1 transcription, 1 highlight analysis, and cached deterministic base clips for identical permitted parameters.
- **Layer 3 (Private User Editing):** Independent private `Project`, `EditTimeline`, `EditVersion`, prompts, and personalized exports (`PRIVATE_USER`).

*(These are architecture targets, not claims of already-measured production throughput or cost reduction.)*

---

## 5. Explicit Rights, Direct Media Defaults & SSRF Safeguards

Implemented in `apps/api/src/media/url-safety.ts` and `apps/api/src/media/canonical-source.ts`:

- **Host Allowlisting ≠ Copying/Sharing Rights:** Adding a host to `approvedDirectMediaHosts` ONLY establishes a safe network destination (SSRF boundary). Direct-media URLs strictly default to `rightsStatus: 'UNKNOWN'` and `acquisitionCapability: 'UNSUPPORTED'` unless explicit server-verified `directMediaAuthorization` is supplied.
- **Separate Authorization Gates:**
  1. **Acquisition (`assertAcquisitionPermitted`):** Requires immutable identity (rejects `CHANNEL_DISCOVERY`), approved `acquisitionCapability`, and verified `rightsStatus` (`USER_OWNED` or `PERMITTED_PUBLIC`). Blocks `DRM_RESTRICTED`, `DENIED`, `REQUIRES_AUTHORIZATION`, `UNSUPPORTED_ACQUISITION`, and `RIGHTS_UNVERIFIED`.
  2. **Shared Cross-User Cache Reuse:** Requires `source.rightsStatus === 'PERMITTED_PUBLIC'` **AND** explicit server policy `allowSharedCacheReuse === true` **AND** non-upload source. Public viewing accessibility alone never implies redistribution permission.
- **SSRF Protection:** Enforces HTTPS by default; blocks `file:`, `javascript:`, `data:`, `ftp:`, embedded credentials, `localhost`, `*.local`, `*.internal`, raw IPv4/IPv6 literals, RFC1918/loopback/CGNAT/link-local ranges, obfuscated decimal/hex/octal IPs, cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, `fd00:ec2::254`), and unsafe redirects (`assertSafeResolvedIp`, `assertSafeRedirectTarget`).

---

## 6. Server-Trusted Cache Authorization & Identity Validation

Implemented in `apps/api/src/media/shared-cache.ts`:

- **Server-Trusted Context (`TrustedCacheAuthContext`):** Symbol-branded frozen object constructed via `createTrustedCacheAuthContext()` from server-resolved `UniversalMediaSource` metadata and authenticated JWT/session `requesterUserId`. Plain object literals forged by untrusted callers claiming `PERMITTED_PUBLIC` are rejected with `ACCESS_DENIED` before touching storage.
- **Authoritative Key Reconstruction:** `SharedArtifactCacheService` always reconstructs `cacheKey` and `storageKey` internally via `resolveAuthorizedCacheIdentity(auth, descriptor)`. Callers cannot supply or substitute another user's private `storageKey`. `assertVerifiedCacheIdentity()` additionally rejects any candidate identity that deviates from the server-reconstructed identity.
- **Strict SHARED vs PRIVATE Separation:**
  - `SHARED_PERMITTED` (`cache/shared/<kind>/<sourceHash>/<cacheKey>`): Strictly requires broadcast/VOD identity (`CacheableSourceIdSchema`), verified `PERMITTED_PUBLIC` rights, explicit `allowSharedCacheReuse`, and zero `customEditHash`.
  - `PRIVATE_USER` (`cache/private/<ownerUserId>/<kind>/<sourceHash>/<cacheKey>`): Bound to `ownerUserId === requesterUserId`. Direct uploads (`upload:*`) and personalized edits (`customEditHash`) are forced into `PRIVATE_USER`.
- **No Secret/Key Leakage:** Rights and ownership checks run BEFORE `getObjectMetadata`, `putObject`, and `createDownloadUrl`. Raw storage keys and signed URLs are never returned to unauthorized callers.
- **Remaining Trust Assumptions & Future DB Requirements:** Symbol branding on `TrustedCacheAuthContext` protects against accidental or malicious plain-object forgery within the running Node.js process, **not** against unverified persistence inputs. HTTP routes MUST NEVER pass untrusted user-supplied `UniversalMediaSource` JSON directly into `createTrustedCacheAuthContext()`. Until PostgreSQL persistence (`MediaSource`, `SharedCacheEntry`) is introduced, `source` must be resolved server-side (defaulting external URLs and direct-media hosts to `UNKNOWN`), and once DB persistence is added, `source.rightsStatus` and `ownerUserId` MUST be hydrated exclusively from authoritative server-side database rows.

---

## 7. Shared Ingestion Coordination & Redis Expiration Limitations

Implemented in `apps/api/src/media/ingestion-coordinator.ts`:

- **Explicit Lua/TypeScript Positional Contract:** `buildRequestIngestionLuaArgs` (6 ARGV: `canonicalId`, `workerId`, `leaseMs`, `maxRetries`, `nowMs`, `recordTtlMs`) and `buildMutateLeaseLuaArgs` (9 ARGV: `mode`, `workerId`, `fencingToken`, `nextState`, `leaseMs`, `artifactRef`, `lastError`, `nowMs`, `recordTtlMs`) pair with runtime Lua `assert(...)` guards so positional argument shifts fail loudly rather than corrupting state.
- **Constant-Size O(1) Work Ownership:** The coordination record stores `{ canonicalSourceId, state, ownerWorkerId, fencingToken, attempts, maxRetries, leaseExpiresAtMs, updatedAtMs, attachedCount, artifactRef?, lastError? }`. Per-user subscriber lists are deliberately excluded so 1,000+ clippers never bloat Redis lock payloads.
- **Validated State Machine (Enforced in both In-Memory & Redis Lua):**
  - Only `ACQUIRING → INGESTING | READY | FAILED` and `INGESTING → READY | FAILED` are permitted.
  - `READY` requires a non-empty `artifactRef` and is **immutable** (stale or active workers cannot overwrite, fail, or release a `READY` record).
  - `FAILED` and `EXPIRED` records are never reused as `REUSE_READY`; they undergo bounded recovery (`attempts <= maxRetries`) with incremented `fencingToken`, terminating at `FAILED_MAX_RETRIES`.
  - Channel-only IDs (`:channel:`) are rejected with `BROADCAST_UNRESOLVED`.
- **Redis Record TTL vs Artifact Retention & Failure Semantics:**
  - Redis coordination keys carry a finite `recordTtlMs` (default 24h), which is independent of durable object-storage artifact retention.
  - If a Redis key expires or is evicted under memory pressure / Redis restart, the coordination state resets (`getState` returns `null`, and the next acquisition starts at `fencingToken = 1`).
  - Therefore, Redis coordination provides **at-least-once coordination with monotonic fencing while the key is resident**, NOT guaranteed distributed exactly-once across Redis data loss or eviction. Future acquisition workers must check durable object storage / PostgreSQL before re-downloading after a Redis key expiry.

---

## 8. CPU-First Live Highlight Detection & Rolling Media Buffer

Implemented in `apps/api/src/media/highlight-detector.ts`:
- `RollingMediaBufferTracker`: Configurable rolling window (default 45s pre-event + 15s post-event, 6s segments, 600s max retention — never hardcoded) calculating pinned segment indices.
- `CpuFirstHeuristicDetector`: Pure-CPU weighted fusion over `AUDIO_ENERGY`, `SPEECH_ACTIVITY`, `TRANSCRIPT_CONTEXT`, optional `CHAT_VELOCITY`, optional `CHAT_EXCITEMENT_KEYWORDS`, and optional `SELECTIVE_VISUAL`. Requires immutable `CacheableSourceId`, gracefully handles platforms without live chat, and avoids continuous paid vision AI.

---

## 9. Implemented vs Planned Functionality

| Capability | Status (Step 3B.4.1) | Future Milestone (Planned) |
| :--- | :--- | :--- |
| Channel vs Broadcast vs VOD identity separation | **Implemented** | Platform API session lookup to bind verified broadcast IDs |
| Fail-closed SSRF, metadata, DNS IP & redirect guards | **Implemented** | Wire into outbound HTTP client DNS hook |
| Strict `UNKNOWN` rights default for direct-media hosts | **Implemented** | Rights/ownership ledger in PostgreSQL |
| Server-trusted symbol-branded cache authorization | **Implemented** | Hydrate from PostgreSQL `MediaSource` & `SharedCacheEntry` |
| O(1) Redis Lua + in-memory ingestion coordinator | **Implemented** | Wire to BullMQ acquisition worker & durable storage pre-check |
| CPU-first highlight detector & rolling buffer contracts | **Implemented** | Feed real FFmpeg audio RMS + permitted chat streams |
| Live-stream recorder, VOD downloader, UI redesign | **Deferred (Out of Scope)** | Separate reviewed milestones |
| Production multi-node load & cost benchmarking | **Deferred** | Dedicated staging load test (1,000+ real connections) |
