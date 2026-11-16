# AUTOAI EDIT — LIVESTREAM INGESTION ARCHITECTURE

**Document ID:** ARCH-006  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Video Ingestion & Streaming Infrastructure Specification

---

## 1. Dual-Path Ingestion Topology

To support content creators across diverse streaming workflows, AutoAI Edit defines two distinct, production-viable ingestion pathways that converge into a unified `MediaSource` representation:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       DUAL-PATH INGESTION ARCHITECTURE                                 │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

    [PATH A: CONNECTED PLATFORMS]                                [PATH B: DIRECT BROADCAST (OBS)]
    (Twitch / YouTube / Kick)                                    (OBS / vMix / Hardware Encoders)
               │                                                                │
               ▼                                                                ▼
   ┌───────────────────────┐                                        ┌───────────────────────┐
   │ Platform OAuth & APIs │                                        │ Secure RTMP / SRT     │
   │ - EventSub / Webhooks │                                        │ rtmp://ingest.../live │
   │ - Live Chat Stream    │                                        │ Stream Key Auth       │
   │ - Stream Status       │                                        └───────────┬───────────┘
   └───────────┬───────────┘                                                    │
               │                                                                ▼
               │                                                    ┌───────────────────────┐
               │                                                    │ MediaMTX Edge Gateway │
               │                                                    │ - Key Authentication  │
               │                                                    │ - 6s Chunk Segmenter  │
               │                                                    └───────────┬───────────┘
               │                                                                │
               ▼                                                                ▼
   ┌───────────────────────┐                                        ┌───────────────────────┐
   │ Chat & Event Pipeline │                                        │ Rolling Chunk Buffer  │
   │ - Velocity Detector   │                                        │ - S3 Ephemeral Store  │
   │ - Emote Spike Engine  │                                        │ - PTS Time Alignment  │
   └───────────┬───────────┘                                        └───────────┬───────────┘
               │                                                                │
               └───────────────────────────────┬────────────────────────────────┘
                                               │
                                               ▼
               ┌────────────────────────────────────────────────────────────────┐
               │         UNIFIED MEDIASOURCE & REPLAYABLE EVENT TIMELINE        │
               │   Pinned Highlight Segments + Normalized Word Transcripts      │
               └────────────────────────────────────────────────────────────────┘
```

---

## 2. Link-First Media Access Framework (Decoupled from User Identity)

### 2.1 Product Paradigm: Media Access Independent of Account Ownership
AutoAI Edit is designed as **one unified application** for independent clippers, esports enthusiasts, gaming creators, stream moderators, and everyday video editors. 

A central architectural mandate is that **platform account connection (OAuth) is NOT mandatory for ordinary use**:
- Any user can paste a supported public livestream or video URL (Twitch, YouTube, Kick) or upload their own MP4/MOV file.
- The user is **never** required to prove ownership of the broadcasted channel simply to analyze chat spikes, inspect public telemetry, or draft edits.
- Platform OAuth authentication is requested **only where a specific action strictly requires it** (e.g., streaming to AutoAI Edit via personal OBS stream key, accessing private subscriber-only VODs, managing brand channel assets, or dispatching direct social media uploads).

### 2.2 Granular Platform Access Matrix (6-Facet Boundary Analysis)
To prevent legal exposure, rate-limit bans, and architectural failure, the system strictly separates media capabilities into six distinct facets across each platform:

| Platform | 1. Public Metadata | 2. Public Chat Access | 3. Platform-Native Clip Creation | 4. Authorized Source Media Retrieval | 5. Standalone MP4 Rendering | 6. Required Rights & Permissions |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Twitch** | **Public & Open:** Channel status, stream title, game category, viewer count, and VOD metadata via Helix/GQL without user auth. | **Public & Open:** Real-time chat messages via Twitch IRC WebSocket (`irc.chat.twitch.tv:6667`) on public channels without broadcaster auth. | **OAuth Required:** Twitch Clip API (`POST /clips`) requires authorized user token with `clips:edit` scope, or manual web clip creation. | **Restricted / No Direct API:** Twitch does not provide a raw MP4 download API. Subscriber VODs require creator OAuth. Never assume public stream is freely downloadable. | **Conditional:** Only rendered if video chunks were ingested via OBS (Path B) or uploaded as authorized MP4/MOV by creator/clipper. | Broadcaster owns broadcast copyright. Clippers must comply with Twitch ToS and creator fair use permissions. |
| **YouTube** | **Public & Open:** Video title, description, tags, duration, and channel metadata via YouTube Data API v3 (`videos.list`). | **Restricted Quota:** `liveChatMessages.list` available via API key, but heavily constrained by 10,000 units/day default project quota. | **Web Only:** YouTube native clips are web-only shareable bookmarks; no direct raw media export via API. | **Strictly Forbidden via API:** YouTube Data API does NOT permit raw video file downloads. Downloading third-party videos violates YouTube ToS Section 5.B. | **Conditional:** Rendered only if video was ingested via direct OBS stream (Path B) or uploaded as local MP4/MOV by the user. | Video uploader retains copyright. Re-use requires creator licensing or Creative Commons attribution. |
| **Kick** | **Public & Open:** Public channel status, stream title, category, and viewer metrics via Kick public endpoints. | **Public & Open:** Real-time chat via Pusher WebSocket (`chatrooms.{id}.v2`) with zero account login. | **Web Only:** Kick native clips created via browser interface; no official third-party clip API. | **Unofficial / Fragile:** Public HLS manifests exist on Kick CDNs, but are unauthenticated, volatile, and gated by Cloudflare Turnstile bot challenges. | **Conditional:** Rendered only if video was ingested via OBS or uploaded by user as MP4/MOV. | Streamer owns broadcast copyright. Commercial clipping requires broadcaster approval. |
| **Direct OBS / Uploads (Native Path)** | **Native & Complete:** Exact framerate, resolution, audio channels, and bitrate extracted directly via FFprobe. | **Optional / Paired:** Chat stream can be linked from any public channel URL (Twitch/Kick) or uploaded as a chat JSON/CSV log. | **Native:** Instant candidate clips extracted with millisecond PTS accuracy directly from rolling chunk buffer. | **100% Authorized & Direct:** Full-quality source media streamed directly to cloud MediaMTX or uploaded to S3. | **100% Unrestricted:** Cloud FFmpeg renders high-fidelity 720p/1080p/4K MP4 exports on demand with zero platform gates. | User possesses full ownership and rights over their own direct broadcast or uploaded source files. |

> [!IMPORTANT]
> **The Golden Rule of Media Ingestion:**
> **Never assume a playable public URL is automatically downloadable or redistributable.** If a creator or clipper connects a public channel URL for chat activity analysis but does not provide an authorized video stream (via OBS ingest or file upload), AutoAI Edit generates an interactive **Chat Activity & Spike Timeline**, but **will never promise, fabricate, or attempt unauthorized scraping of raw video files**.

---

## 3. Path A: Platform Connectors & Chat Telemetry

---

## 4. Path B: Direct Live Broadcast (OBS, RTMP/RTMPS, SRT)

Direct live ingestion gives AutoAI Edit 100% control over video quality, timestamp precision, and zero-latency segment access.

### 1. Ingestion Gateway (MediaMTX)
- **Technology:** [MediaMTX](https://github.com/bluenviron/mediamtx) (formerly rtsp-simple-server)—a zero-dependency, high-throughput media server written in Go supporting RTMP, RTMPS, SRT, and WebRTC.
- **Protocol Configuration:**
  - **RTMPS (Primary):** `rtmps://ingest.autoedit.ai:443/live` (TLS encrypted).
  - **SRT (Low-Latency Option):** `srt://ingest.autoedit.ai:8890` (Caller mode, AES-128 encryption).
- **Stream Key Authentication:**
  - When OBS connects, MediaMTX triggers an internal HTTP authentication webhook:
    `POST https://api.autoedit.ai/api/live/auth/stream-key`
  - The API extracts the stream key, computes its SHA-256 hash, verifies the user's quota, and returns HTTP 200 (Accept) or HTTP 403 (Reject).

### 2. Rolling Buffer & 6-Second Segmentation
- As frames arrive, MediaMTX segments the incoming H.264/AAC elementary stream into **6-second fragmented MP4 chunks** (`.m4s` / `.ts`):
  ```text
  chunks/session_{id}/00000.m4s  (0.0s - 6.0s)
  chunks/session_{id}/00001.m4s  (6.0s - 12.0s)
  chunks/session_{id}/00002.m4s  (12.0s - 18.0s)
  ```
- Each chunk is written to a local SSD tmpfs cache and asynchronously streamed to AWS S3 / Cloudflare R2 with standard S3 lifecycle metadata.

### 3. Segment Pinning & 30-Minute Rolling Retention
To avoid storing hundreds of gigabytes of unedited dead air from a multi-hour stream:
1. **Configurable Rolling Buffer Window (30-Minute Pilot):** Unpinned segments older than **30 minutes** are purged by an automated cleanup cron (`INFRA-007`). This pilot window minimizes ephemeral storage overhead while providing ample runway for live highlight identification. Retention duration is configurable per user tier.
2. **Reference-Aware Retention & Pin Leases (`LIVE-010`):** When a highlight candidate is flagged (e.g. at timestamp 45:10) or bookmarked by the creator, the system increments the chunk's `pinReferenceCount` and attaches a `SegmentPinReference` lease. Segments with active references (`pinReferenceCount > 0`) are protected from rolling buffer eviction. If an edit project is deleted or the creator releases the candidate, references decrement, and zero-reference chunks enter an expiration grace period rather than accumulating indefinitely.
3. **Session Sealing (`LIVE-013`):** When the broadcast concludes, pinned chunks are linked to an active `Project` record for immediate clipping, previewing, and rendering in the Unified Studio.

---

## 5. Disconnection & Reconnection Recovery

Streaming creators frequently encounter brief Wi-Fi hiccups or OBS crashes. AutoAI Edit implements a robust **Session Bridging Policy**:

```
[OBS Streaming: 1080p 60fps] ──► [Chunk 120] ──► [Chunk 121]
                                                    │
                                     * INTERNET CONNECTION DROPS *
                                     * (OBS attempts reconnect)  *
                                                    │
[OBS Reconnected after 18s]  ──► [Chunk 122] (discontinuity=true)
```

1. **Grace Period Window:** When the stream drops, the `LiveSession` status transitions to `DISCONNECTED`. The session remains open for a **180-second grace period**.
2. **Seamless Session Resumption:** If OBS reconnects with the same stream key within 180 seconds, the session state returns to `LIVE` without creating a fragmented second session.
3. **PTS Timestamp Discontinuity Handling:**
   - Chunk 122 receives `hasDiscontinuity: true`.
   - The FFmpeg concatenation pipeline applies the `aresample=async=1` filter and inserts synchronized presentation timestamps, preventing audio drift in rendered highlights.
4. **Graceful Timeout:** If no reconnect occurs within 180 seconds, the session transitions to `SEALING`, flushes pending chunks, and transitions to `ENDED`.

---

## 6. Storage Economics & Ingestion Cost Projections

*(Note: Storage figures are heuristic engineering projections based on 6.0 Mbps 1080p60 H.264 streams; empirical bandwidth and storage will be calibrated during Milestone 3 beta testing).*

| Stream Duration | Raw Bitrate (1080p60) | Total Ingest Volume | Unpinned Buffer (30m Window) | Pinned Highlights (~10 clips) | Est. S3 Ephemeral Cost |
|---|---|---|---|---|---|
| **1 Hour** | 6.0 Mbps | 2.70 GB | 1.35 GB (Purged) | ~250 MB | $0.03 |
| **3 Hours** | 6.0 Mbps | 8.10 GB | 1.35 GB (Purged) | ~450 MB | $0.08 |
| **6 Hours** | 6.0 Mbps | 16.20 GB | 1.35 GB (Purged) | ~700 MB | $0.15 |

> [!TIP]
> By combining a 30-minute rolling buffer segment purge with Cloudflare R2 (which features $0.00 egress fees), AutoAI Edit slashes live stream storage overhead by over 88% compared to storing raw monolithic VODs.
