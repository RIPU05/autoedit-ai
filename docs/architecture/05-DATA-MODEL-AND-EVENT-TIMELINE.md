# AUTOAI EDIT — UNIFIED DATA MODEL & EVENT TIMELINE SPECIFICATION

**Document ID:** ARCH-005  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Database Architecture & Schema Specification

---

## 1. Unified Data Modeling Strategy

AutoAI Edit unifies pre-recorded VOD editing and real-time live broadcast clipping into a single relational and event data architecture. Rather than building separate database tables and workflows for live streams, the architecture maps both modes into an immutable **MediaSource** and a replayable **Event Timeline**.

### Core Tenancy & Ownership Invariants:
1. **Strict User Tenancy:** Every `Project`, `MediaSource`, `LiveSession`, `EditTimeline`, and `Render` is strictly owned by a parent `User` record (`userId`).
2. **Immutable Version Tree:** `EditVersion` snapshots are strictly append-only; historical versions are never updated or mutated in place.
3. **Replayable Evidence Trail:** Every highlight candidate or AI cut stores foreign keys and timestamp ranges linking back to the exact `MediaSegment`, `Transcript` word offsets, and `ChatEvent` velocity spikes that justified the cut.

---

## 2. Entity Specifications & Conceptual Contracts

### 1. `MediaSource` (Core Media Entity)
- **Role:** Represents the root media origin—whether an uploaded 4K file, an authorized platform VOD, or a live broadcast stream.
- **Fields:**
  - `id`: CUID primary key.
  - `projectId`: References `Project.id`.
  - `kind`: `DIRECT_UPLOAD` | `PLATFORM_VOD` | `LIVE_RTMP` | `LIVE_SRT`.
  - `sourceUrl`: Remote origin URL or primary S3 key.
  - `durationSec`: Total source duration (null while live).
  - `status`: `INGESTING` | `READY` | `FAILED`.

### 2. `LiveSession` (Real-Time Broadcast Entity)
- **Role:** Tracks a direct broadcast session initiated via OBS or platform live connector.
- **Fields:**
  - `id`: CUID primary key.
  - `userId`: References `User.id`.
  - `streamKeyHash`: SHA-256 hashed stream key for RTMP authentication.
  - `status`: `INITIALIZING` | `LIVE` | `DISCONNECTED` | `SEALING` | `ENDED`.
  - `startedAt`, `endedAt`: ISO timestamps.
  - `pinnedSegments`: Count of media chunks saved from auto-deletion.
  - `mediaSourceId`: Foreign key to `MediaSource`.

### 3. `MediaSegment` (Granular Video Chunk)
- **Role:** Discrete 6-second video chunks produced during rolling live broadcasts or sliced VOD imports.
- **Fields:**
  - `id`: CUID primary key.
  - `mediaSourceId`: References `MediaSource.id`.
  - `sequenceNumber`: Monotonically increasing index (0, 1, 2...).
  - `epochStartMs`: Presentation timestamp relative to broadcast epoch zero.
  - `durationMs`: Precise chunk duration in milliseconds (~6000ms).
  - `s3Key`: S3 object storage path (`chunks/{sourceId}/{seq}.ts`).
  - `isPinned`: Boolean flag. Pinned chunks are excluded from rolling-buffer cleanup.
  - `hasDiscontinuity`: Boolean flag indicating stream drop or clock reset.

### 4. `ChatEvent` (Normalized Interactive Event)
- **Role:** Normalized chat message captured from Twitch IRC, YouTube Live, or Kick.
- **Fields:**
  - `id`: CUID primary key.
  - `mediaSourceId`: References `MediaSource.id`.
  - `platform`: `TWITCH` | `YOUTUBE` | `KICK`.
  - `timestampMs`: Stream-synchronized millisecond offset.
  - `senderId`, `senderName`: User details from platform.
  - `message`: Full text payload.
  - `emotes`: Array of detected emote tokens (`["KEKW", "POG"]`).
  - `sentimentScore`: Computed excitement index (0.0 to 1.0).

### 5. `HighlightSignal` & `HighlightCandidate`
- **Role:** Algorithmic evidence signals (chat spikes, audio loudness, speech density) aggregated into candidate clip proposals.
- **Fields (`HighlightCandidate`):**
  - `id`: CUID primary key.
  - `projectId`: References `Project.id`.
  - `startSec`, `endSec`: Sub-second boundary markers.
  - `compositeScore`: Ranked virality score (0.0 to 100.0).
  - `hookQuote`: The single most provocative opening statement.
  - `evidenceSummary`: Human-readable explanation (`EDIT-002`).
  - `signalsJson`: Array of contributing signal weights.
  - `status`: `PROPOSED` | `ACCEPTED` | `REJECTED` | `RENDERED`.

---

## 3. Replayable Timeline & Time Synchronization Strategy

### Epoch Normalization & Discontinuity Handling
When a creator broadcasts via OBS over fluctuating Wi-Fi, network drops cause stream discontinuities and clock drift. AutoAI Edit enforces **Epoch Normalization**:

```
Live Stream Clock: 00:00:00 (Epoch T0)
[Chunk 0: 0.0s - 6.0s] ─────────► S3 Key: chunks/session_1/00000.ts
[Chunk 1: 6.0s - 12.0s] ────────► S3 Key: chunks/session_1/00001.ts
   *** OBS Network Drop (14 seconds of lost frames) ***
[Chunk 2: 26.0s - 32.0s] ───────► S3 Key: chunks/session_1/00002.ts (discontinuity=true)
```

1. **Presentation Timestamp Normalization:** The ingest gateway records both wall-clock UTC arrival time and video presentation timestamps (PTS).
2. **Chat Alignment:** Chat messages arriving over WebSockets carry UTC timestamps. The synchronization engine computes:
   $$\text{StreamOffsetMs} = \text{ChatUTC} - \text{SessionStartUTC}$$
   This ensures that a flurry of "OMG HE HIT THAT" chat messages matches the exact video frame where the event occurred, regardless of client player latency.
3. **Discontinuity Flags:** When an FFmpeg render crosses a discontinuity gap, the command builder automatically inserts a smooth crossfade or black frame bridge instead of throwing an invalid presentation timestamp crash.

---

## 4. Proposed Prisma Schema Additions (Non-Destructive Diff)

The following schema diff preserves all 18 existing Prisma models while introducing live stream ingestion, chat event normalization, and multimodal highlight candidate models:

```prisma
// =============================================================================
// AUTOAI EDIT — PROPOSED LIVE INGESTION & HIGHLIGHT SCHEMA EXTENSIONS
// (Stage 1 Architecture Draft — No migration applied)
// =============================================================================

enum MediaSourceKind {
  DIRECT_UPLOAD
  PLATFORM_VOD
  LIVE_RTMP
  LIVE_SRT
}

model MediaSource {
  id              String          @id @default(cuid())
  projectId       String?         @unique
  kind            MediaSourceKind @default(DIRECT_UPLOAD)
  sourceUrl       String?
  durationSec     Float?
  status          String          @default("READY")
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  project         Project?        @relation("ProjectMediaSource", fields: [projectId], references: [id], onDelete: Cascade)
  segments        MediaSegment[]
  chatEvents      ChatEvent[]
  highlightSignals HighlightSignal[]
  liveSession     LiveSession?

  @@index([kind, status])
}

enum LiveSessionStatus {
  INITIALIZING
  LIVE
  DISCONNECTED
  SEALING
  ENDED
}

model LiveSession {
  id              String            @id @default(cuid())
  userId          String
  mediaSourceId   String            @unique
  title           String
  streamKeyHash   String            @unique
  status          LiveSessionStatus @default(INITIALIZING)
  ingestEndpoint  String
  startedAt       DateTime?
  endedAt         DateTime?
  totalBytes      BigInt            @default(0)
  pinnedSegments  Int               @default(0)
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt

  user            User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  mediaSource     MediaSource       @relation(fields: [mediaSourceId], references: [id], onDelete: Cascade)

  @@index([userId, status])
}

model MediaSegment {
  id               String      @id @default(cuid())
  mediaSourceId    String
  sequenceNumber   Int
  epochStartMs     Int         // Offset from stream start in milliseconds
  durationMs       Int         // Duration of chunk (e.g. 6000ms)
  s3Key            String
  bucket           String
  sizeBytes        Int
  isPinned         Boolean     @default(false)
  hasDiscontinuity Boolean     @default(false)
  createdAt        DateTime    @default(now())

  mediaSource      MediaSource @relation(fields: [mediaSourceId], references: [id], onDelete: Cascade)

  @@unique([mediaSourceId, sequenceNumber])
  @@index([mediaSourceId, epochStartMs])
  @@index([isPinned, createdAt])
}

model ChatEvent {
  id            String      @id @default(cuid())
  mediaSourceId String
  platform      String      // TWITCH | YOUTUBE | KICK
  timestampMs   Int         // Synchronized stream offset in ms
  senderId      String
  senderName    String
  message       String
  emotes        Json        @default("[]")
  sentiment     Float       @default(0.0) // 0.0 to 1.0 excitement rating
  createdAt     DateTime    @default(now())

  mediaSource   MediaSource @relation(fields: [mediaSourceId], references: [id], onDelete: Cascade)

  @@index([mediaSourceId, timestampMs])
}

enum SignalType {
  CHAT_SPIKE
  AUDIO_PEAK
  SPEECH_EXCITEMENT
  SILENCE_BURST
  MANUAL_BOOKMARK
  SCENE_CHANGE
}

model HighlightSignal {
  id            String      @id @default(cuid())
  mediaSourceId String
  type          SignalType
  timestampMs   Int
  magnitude     Float       // Normalized signal intensity (0.0 to 10.0)
  meta          Json?
  createdAt     DateTime    @default(now())

  mediaSource   MediaSource @relation(fields: [mediaSourceId], references: [id], onDelete: Cascade)

  @@index([mediaSourceId, timestampMs])
}

model HighlightCandidate {
  id               String   @id @default(cuid())
  projectId        String
  startSec         Float
  endSec           Float
  durationSec      Float
  compositeScore   Float    // Overall virality score (0-100)
  hookQuote        String?
  editorialReason  String?  // Explainable AI narrative
  signalsJson      Json     // Array of contributing signal weights
  status           String   @default("PROPOSED") // PROPOSED | ACCEPTED | RENDERED
  createdAt        DateTime @default(now())

  project          Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, compositeScore])
}
```

---

## 5. Idempotency & Deduplication Guarantees

1. **S3 Multipart Chunk Uploads:**
   - S3 part numbers and ETags are stored with upload session IDs. Duplicate completion calls respond with cached completion payloads rather than spawning duplicate BullMQ jobs (`tests/upload-authorization.test.ts`).
2. **Chat Event Deduplication:**
   - Ingested chat messages are hashed: `SHA256(platform + senderId + timestampMs + message)`. Duplicate messages arriving from network reconnects are rejected before insertion.
3. **Queue Job Idempotency:**
   - Every BullMQ job ID is formatted as `${queueName}:${projectId}:${actionId}` (e.g. `analysis:proj_123:init`). BullMQ enforces job uniqueness, guaranteeing that rapid double-clicks on "Render" never trigger duplicate transcoding tasks.
