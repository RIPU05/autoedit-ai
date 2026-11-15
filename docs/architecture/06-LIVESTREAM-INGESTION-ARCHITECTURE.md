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

## 2. Path A: Connected Platforms (Twitch, Kick, YouTube)

### Reality Check & API Boundary Analysis
A common misconception in video SaaS development is assuming that authenticating via platform OAuth grants unrestricted direct access to raw livestream MP4 files. Platform capabilities must be strictly evaluated against documented terms and APIs:

| Platform | OAuth & Identity | Live Stream Status | Real-Time Chat Ingestion | Completed VOD Metadata | Raw Video Download Permitted? |
|---|---|---|---|---|---|
| **Twitch** | **Fully Supported** (OAuth2 `user:read:email`, `channel:read:subscriptions`) | **Supported** via EventSub (`stream.online`, `stream.offline`) | **Supported** via Twitch IRC WebSocket / EventSub (`channel.chat.message`) | **Supported** via `Get Videos` API (Title, duration, thumbnail) | **RESTRICTED / NO DIRECT API.** Twitch does not provide a direct MP4 download endpoint. Downloading subscriber-only or arbitrary VODs without creator partner scopes violates ToS unless using authorized creator exports. |
| **YouTube** | **Fully Supported** (Google OAuth2 `youtube.readonly`, `youtube.force-ssl`) | **Supported** via YouTube Data API v3 (`liveBroadcasts.list`) | **Supported** via `liveChatMessages.list` (Subject to strict 10,000 unit/day quota) | **Supported** via `videos.list` | **RESTRICTED.** YouTube does not provide raw MP4 video streams via API. Media must be ingested directly from OBS or uploaded by the creator. |
| **Kick** | **Partially Documented** (Public developer portal in beta) | **Supported** via public channel polling | **Supported** via Pusher WebSocket listener (`chatrooms.{id}.v2`) | **Supported** via public channel recordings API | **UNOFFICIAL / FRAGILE.** Direct HLS stream extraction exists on Kick CDNs, but has no guaranteed long-term API contract. |

### Architectural Directive for Path A:
1. **Chat & Telemetry First:** Path A is primarily leveraged to ingest **metadata, stream status, and real-time chat excitement events**.
2. **Media Pairing:** For video footage, creators on Twitch/YouTube/Kick either:
   - Stream simultaneously to AutoAI Edit via OBS multi-streaming (Path B).
   - Or upload the completed stream recording directly to AutoAI Edit once the broadcast concludes.

---

## 3. Path B: Direct Live Broadcast (OBS, RTMP/RTMPS, SRT)

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

### 3. Segment Pinning & Rolling Retention
To avoid storing hundreds of gigabytes of unedited dead air from a 6-hour stream:
1. **Rolling Buffer Window:** Unpinned segments older than **90 minutes** are purged by an automated cleanup cron (`INFRA-007`).
2. **Segment Pinning (`LIVE-010`):** When a highlight candidate is flagged (e.g. at timestamp 45:10), the system flags chunks 450 through 465 as `isPinned: true`. Pinned chunks are permanently retained and exempt from deletion.
3. **Session Sealing (`LIVE-013`):** When the broadcast concludes, pinned chunks are linked to an active `Project` record for immediate clipping and rendering in the Studio.

---

## 4. Disconnection & Reconnection Recovery

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

## 5. Storage Economics & Ingestion Cost Model

| Stream Duration | Raw Bitrate (1080p60) | Total Ingest Volume | Unpinned Buffer (90m Window) | Pinned Highlights (~10 clips) | Est. S3 Ephemeral Cost |
|---|---|---|---|---|---|
| **1 Hour** | 6.0 Mbps | 2.70 GB | 2.70 GB | ~250 MB | $0.06 |
| **3 Hours** | 6.0 Mbps | 8.10 GB | 4.05 GB (Purged) | ~450 MB | $0.18 |
| **6 Hours** | 6.0 Mbps | 16.20 GB | 4.05 GB (Purged) | ~700 MB | $0.37 |

> [!TIP]
> By combining rolling buffer segment purging with Cloudflare R2 (which features $0.00 egress fees), AutoAI Edit slashes live stream storage overhead by over 75% compared to storing raw monolithic VODs.
