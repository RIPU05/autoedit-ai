# AUTOAI EDIT — APPLICATION SCREENS & USER EXPERIENCE SPECIFICATION

**Document ID:** ARCH-003  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** UX Architecture & Interface Specification

---

## 1. Complete Screen Map & Navigation Hierarchy

The AutoAI Edit frontend is built with Next.js 14 (App Router) and Tailwind CSS. The user interface is structured around a dual-mode workflow: **VOD Editing Studio** and **Live Broadcast Hub**.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        NEXT.JS 14 APPLICATION ROUTING                  │
└────────────────────────────────────────────────────────────────────────┘
  │
  ├── / (Landing Page: Value Proposition, Feature Tour, CTA) [SCR-001]
  ├── /login (Authentication: Email/Password & Google SSO) [SCR-002]
  │
  ├── [Authenticated Creator Layout]
  │     │
  │     ├── /dashboard (Project Catalog, Upload Trigger, Activity Feed) [SCR-003]
  │     │     └── [Modal: S3 Chunked Uploader] [SCR-004]
  │     │
  │     ├── /projects/[id] (Unified Studio Editor) [SCR-005]
  │     │     ├── [Sub-View: Instant Video Preview] [SCR-006]
  │     │     ├── [Sub-View: Interactive Visual Timeline] [SCR-007]
  │     │     ├── [Sub-View: Explainable AI Drawer] [SCR-008]
  │     │     ├── [Sub-View: Version History Sidebar] [SCR-009]
  │     │     ├── [Sub-View: A/B Split Comparison] [SCR-010]
  │     │     ├── [Sub-View: Social Repurposing Panel] [SCR-011]
  │     │     └── [Sub-View: Cloud Render & Export Center] [SCR-012]
  │     │
  │     ├── /settings (Creator Style Profile & Editing Preferences) [SCR-013]
  │     ├── /settings/integrations (Claude Key, n8n, Twitch, YouTube) [SCR-014]
  │     ├── /analytics (Processing Telemetry & Stage Timings) [SCR-015]
  │     ├── /admin/feedback (Creator Ratings & Feedback Review) [SCR-016]
  │     │
  │     └── [Proposed Stage 2 Livestream Routes]
  │           ├── /live (Livestream Ingest & OBS Configuration Hub) [SCR-017]
  │           └── /live/[sessionId] (Real-Time Stream Control Room) [SCR-018]
```

---

## 2. End-to-End User Journeys

### User Journey 1: Pre-Recorded Video Upload to Multi-Platform Publish
1. **Initiation:** Creator signs in (`/login`) and arrives on the Dashboard (`/dashboard`).
2. **Upload:** Creator clicks "New Project", drops a 45-minute 1080p MP4 podcast. The browser initiates direct-to-S3 presigned PUT chunking (`Uploader.tsx`) with verified session tokens.
3. **Queue & Cloud Processing:** Upon upload completion, the API server dispatches BullMQ `analysis` job. The Render background worker downloads the video, runs FFmpeg silence detection, invokes Modal Faster-Whisper GPU, and triggers Claude 3.5 Sonnet analysis.
4. **Studio Arrival:** Creator navigates to `/projects/[id]`. The Original AI Cut (`EDIT-004`) is pre-assembled.
5. **Evaluation:**
   - **Instant Preview Edit (`EDIT-001`):** Creator presses spacebar; uncut source video plays smoothly, virtually skipping detected dead air and displaying synchronized subtitles in real time without waiting for rendering.
   - **Explainable AI (`EDIT-002`):** Creator inspects the AI narrative drawer, reviewing hook mechanisms, virality scores, and editorial reasoning.
   - **A/B Comparison (`EDIT-010`):** Creator toggles side-by-side view to compare the 45-minute raw recording with the 60-second viral reel.
6. **Prompt Refinement:** Creator types *"Shorten the intro and make the cuts faster"*. The backend appends a new `EditVersion` to the version history tree (`EDIT-003`).
7. **Cloud Export:** Creator clicks "Render 9:16 Reel". The Render worker executes FFmpeg vertical crop and burned-in subtitle encoding. The completed clip appears in the Export Center with a direct download link and automated n8n webhook notification.

---

### User Journey 2: Direct OBS Livestream Broadcast to Automated Clipping
1. **Setup:** Creator visits `/live` (`SCR-017`), connects Twitch account, and copies their private RTMP ingest URL (`rtmp://ingest.autoedit.ai/live`) and Stream Key.
2. **Broadcast Start:** Creator pastes the stream key into OBS and clicks "Start Streaming". MediaMTX gateway receives the stream, authenticates the key, and begins streaming 6-second rolling chunks to S3.
3. **Live Control Room (`SCR-018`):** Creator (or moderator) opens `/live/[sessionId]`. Real-time stream telemetry, live chat messages, and rolling audio waveforms update dynamically via WebSockets.
4. **Automated Event Detection:**
   - At 01:14:20, a dramatic in-game clutch occurs. Chat velocity spikes +450% (`VOD-004`).
   - The multimodal highlight engine pins rolling segments (`LIVE-010`) and generates a live highlight candidate card.
   - Creator can optionally hit a "Bookmark" hotkey to pin the moment manually (`LIVE-009`).
5. **Stream End:** Creator stops streaming in OBS. The ingestion engine automatically seals the live session and transforms the pinned segments into a standard `Project` record.
6. **One-Click Studio Editing:** Creator immediately opens the project in `/projects/[id]`, where the top 5 stream highlights are ready for preview, timeline trimming, and batch export.

---

## 3. Screen Specifications (SCR-001 through SCR-018)

### SCR-001: Landing & Product Overview (`/`)
- **Purpose:** Public marketing gateway presenting value proposition, feature demonstrations, and onboarding call-to-action.
- **Target Users:** Unauthenticated visitors, content creators, podcast producers, streamers.
- **Primary Actions:** "Get Started Free" (redirects to `/login`), "Sign In", "View Demo".
- **Key Components:** Hero section with animated video comparison, feature cards highlighting the 3 Core Invariants, pricing tier comparison, footer.
- **API Calls:** None (Static pre-rendered Next.js page).
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/page.tsx`).

---

### SCR-002: Authentication & Onboarding (`/login`)
- **Purpose:** Secure user entry point supporting email/password authentication and Google OAuth SSO.
- **Target Users:** Returning users and new creators registering an account.
- **Primary Actions:** Toggle between "Sign In" and "Create Account", submit credentials, click "Continue with Google".
- **Key Components:** Responsive auth card, validation feedback, password visibility toggle, terms disclosure.
- **API Calls:** `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/google`.
- **States:**
  - *Loading:* Button spinner, inputs disabled.
  - *Error:* Inline alert displaying specific failure (e.g. "Too many attempts, please try again in 15 minutes", "Invalid password").
  - *Success:* Seamless redirect to `/dashboard`.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/login/page.tsx`).

---

### SCR-003: Project Management Dashboard (`/dashboard`)
- **Purpose:** Main hub listing creator projects, active rendering statuses, recent AI activity, and upload trigger.
- **Target Users:** Authenticated creators.
- **Primary Actions:** Click "New Project" (opens Uploader), search/filter projects, click a project card to open Studio.
- **Key Components:**
  - Metric summary cards (Total Projects, Rendered Clips, Minutes Processed).
  - Search and status filter bar (All, Analyzing, Rendering, Completed).
  - Project Grid with thumbnail preview, title, date, duration badge, and status pill.
  - Recent Activity Feed sidebar showing real-time background worker milestones.
- **API Calls:** `GET /api/projects`, `GET /api/account/activity`.
- **States:**
  - *Loading:* Skeleton cards with pulse animations.
  - *Empty:* "No projects yet. Upload your first video to see AI editing in action." with prominent upload button.
  - *Error:* "Failed to load projects. [Retry]" button.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/dashboard/page.tsx`).

---

### SCR-004: S3 Chunked Upload Manager (`Uploader.tsx`)
- **Purpose:** Modal dialog orchestrating direct client-to-S3 presigned PUT and multipart uploads with BOLA ownership verification.
- **Target Users:** Creators uploading new video files.
- **Primary Actions:** Drag-and-drop video file, browse files, enter project title, click "Start Processing".
- **Key Components:** Drag-and-drop dropzone, file metadata display (size, mime type), circular progress bar, cancel button.
- **API Calls:** `POST /api/projects` (create project shell), `POST /api/projects/:id/upload/initiate`, `POST /api/projects/:id/upload/complete`.
- **States:**
  - *Upload Progress:* Byte-level progress bar and percentage indicator.
  - *Verification:* "Finalizing upload and queuing AI analysis...".
  - *Error:* Clear failure reason (e.g. "File exceeds 5 GB limit", "Network interrupted, retry").
- **Existing Status:** **Implemented & Verified** (`apps/web/src/components/Uploader.tsx`).

---

### SCR-005: Studio Editor Workspace (`/projects/[id]`)
- **Purpose:** Comprehensive creative workstation combining video preview, visual timeline, AI reasoning, and export controls.
- **Target Users:** Creators reviewing and refining AI video edits.
- **Primary Actions:** Play/pause, scrub timeline, submit prompt edit, restore version, queue render.
- **Layout Architecture:**
  - *Top Header:* Project title, status indicator, back to dashboard, Export button.
  - *Center Main:* Instant Video Preview player (`SCR-006`) with overlay controls.
  - *Bottom Pane:* Interactive Visual Timeline (`SCR-007`) with audio waveform and cut blocks.
  - *Right Sidebar:* Tabbed inspector switching between Explainable AI (`SCR-008`), Version History (`SCR-009`), and Social Repurposing (`SCR-011`).
- **API Calls:** `GET /api/projects/:id`, `POST /api/projects/:id/edit`, `POST /api/projects/:id/render`.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/projects/[id]/page.tsx`).

---

### SCR-006: Instant Video Preview Player (`VideoPreview.tsx`)
- **Purpose:** Renders the edited timeline virtually in real time using HTML5 media events over uncut source media (`EDIT-001`).
- **Primary Actions:** Spacebar to toggle play/pause, J-K-L playback rate controls, toggle subtitle overlay on/off, toggle fullscreen.
- **Technical Behavior:** Translates `operations` array: when the playhead hits a deleted region (`action: 'cut'`), it instantaneously seeks ahead to the next active segment, creating a seamless edited preview without server transcoding.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/components/VideoPreview.tsx`).

---

### SCR-007: Interactive Visual Timeline (`VisualTimeline.tsx`)
- **Purpose:** Granular visual representation of audio amplitude, speech intervals, silence blocks, and clip trim points.
- **Primary Actions:** Drag playhead to scrub, click clip block to select, drag edge handles to adjust in/out points, click split icon to cut.
- **Key Components:** Timecode ruler, audio waveform track, video clip segments, silence markers, candidate highlight badges.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/components/VisualTimeline.tsx`).

---

### SCR-008: Explainable AI Narrative Drawer (within Studio)
- **Purpose:** Exposes transparent AI editorial reasoning and evidence signals (`EDIT-002`).
- **Key Components:**
  - *Editorial Strategy Badge:* Summary of narrative arc and target pacing.
  - *Hook Score Metric:* 0–100 virality rating with exact hook quote and timestamp.
  - *Evidence Breakdown:* Visual indicators showing why moments were kept (e.g. "Silence Cut: 4.2s dead air removed", "High Speech Velocity: 185 WPM").
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/projects/[id]/page.tsx`).

---

### SCR-009: Non-Destructive Version History Sidebar (`VersionSidebar.tsx`)
- **Purpose:** Tree-structured timeline version browser and rollback manager (`EDIT-003`).
- **Primary Actions:** Inspect past version snapshots, click "Restore this version", compare version diffs.
- **Key Components:** Version tree nodes showing version name ("Original AI cut", "Tighter pacing"), timestamp, prompt that created it, and change diff summary ("-12s duration, +2 zooms").
- **API Calls:** `GET /api/projects/:id/versions`, `POST /api/projects/:id/versions/:versionId/restore`.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/components/VersionSidebar.tsx`).

---

### SCR-010: A/B Split Comparison View (`CompareView.tsx`)
- **Purpose:** Synchronized dual-player comparing original uncut media against AI-edited output.
- **Primary Actions:** Toggle split-screen slider, synchronize playheads, toggle audio between raw and edited.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/components/CompareView.tsx`).

---

### SCR-011: Social Repurposing & Multi-Platform Copy (`RepurposePanel.tsx`)
- **Purpose:** Presents AI-generated platform-tailored copy, hooks, and hashtags for social sharing.
- **Key Components:** Platform tabs (YouTube Shorts, TikTok, Instagram Reels, LinkedIn), copy-to-clipboard buttons, hashtag chips.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/components/RepurposePanel.tsx`).

---

### SCR-012: Cloud Render & Export Center (within Studio)
- **Purpose:** Initiates cloud FFmpeg rendering and manages downloadable clip outputs.
- **Primary Actions:** Select format preset (9:16 Reel, 9:16 Short, 16:9 Landscape), click "Start Render", download completed MP4.
- **Key Components:** Active render progress bar (0–100%), format selector, list of completed export cards with file sizes and download buttons.
- **API Calls:** `POST /api/projects/:id/render`, `GET /api/projects/:id/renders`.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/projects/[id]/page.tsx`).

---

### SCR-013: Creator Style Profile (`/settings`)
- **Purpose:** Configures creator style preferences that shape AI editorial decisions (`EDIT-012`).
- **Primary Actions:** Adjust pacing slider (slow, balanced, fast), caption preference (on, minimal, off), editing style (viral, educational, documentary).
- **API Calls:** `GET /api/account/profile`, `PUT /api/account/profile`.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/settings/page.tsx`).

---

### SCR-014: Platform Connections & Integrations (`/settings/integrations`)
- **Purpose:** Manages encrypted third-party credentials and platform OAuth connections.
- **Primary Actions:** Connect/disconnect Claude API key, configure n8n webhook URL and secret, connect Twitch/YouTube accounts.
- **API Calls:** `GET /api/integrations`, `POST /api/integrations/claude`, `POST /api/integrations/n8n`, `DELETE /api/integrations/:provider`.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/settings/integrations/page.tsx`).

---

### SCR-015: Analytics & Telemetry Dashboard (`/analytics`)
- **Purpose:** Observability into system processing efficiency and pipeline stage durations.
- **Key Components:** Stage duration charts (upload, probe, transcription, analysis, render), error breakdown table.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/analytics/page.tsx`).

---

### SCR-016: In-App User Feedback Admin Portal (`/admin/feedback`)
- **Purpose:** Administrative interface reviewing user feedback, star ratings, and satisfaction metrics.
- **Existing Status:** **Implemented & Verified** (`apps/web/src/app/admin/feedback/page.tsx`).

---

### SCR-017: Live Broadcast Ingest Hub (`/live`) [PROPOSED STAGE 2]
- **Purpose:** Stream setup center providing private RTMP/SRT stream keys and OBS configuration guides.
- **Target Users:** Live streamers connecting OBS, vMix, or hardware encoders.
- **Primary Actions:** Generate/copy stream key, view OBS setup parameters, view active connected platforms.
- **Key Components:** Stream key field with copy/regenerate button, RTMP server URL, SRT connection string, OBS auto-configuration button.
- **Dependencies:** MediaMTX gateway (`LIVE-002`, `LIVE-004`).
- **Existing Status:** **Planned Only** (Specification finalized in ARCH-006).

---

### SCR-018: Real-Time Stream Control Room (`/live/[sessionId]`) [PROPOSED STAGE 2]
- **Purpose:** Live broadcast mission control displaying low-latency stream preview, real-time chat, and live highlight candidate cards.
- **Target Users:** Streamers and live moderators during active broadcasts.
- **Primary Actions:** Monitor stream health, click "Bookmark Moment", review and approve live highlight candidates.
- **Key Components:**
  - Low-latency HLS/WebRTC stream preview player.
  - Multi-platform live chat stream (Twitch, YouTube, Kick).
  - Real-time chat velocity graph with spike indicators.
  - Highlight candidate cards with 1-click "Pin & Export" buttons.
- **Dependencies:** WebSocket server, Live highlight engine (`LIVE-008`).
- **Existing Status:** **Planned Only** (Specification finalized in ARCH-006).
