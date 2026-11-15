# AUTOAI EDIT — EDITING STUDIO & VIDEO RENDERING PIPELINE

**Document ID:** ARCH-008  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Video Engineering & Media Processing Specification

---

## 1. Studio Architecture: Virtual Preview vs. Headless Cloud Render

AutoAI Edit decouples the **interactive editing experience** from the **final export rendering pipeline**. Rendering a 60-second 1080x1920 video with multiple filtergraphs takes 20–30 seconds on a cloud CPU; requiring creators to wait for a transcode after every trim would destroy creative velocity.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   VIRTUAL CLIENT PREVIEW (0s LATENCY)                  │
│       - Raw unedited source video streamed from S3/CDN                 │
│       - TimelineEditor.tsx reads operations: [{action: 'cut'}]         │
│       - HTML5 'timeupdate' listener seeks over cut intervals           │
│       - Web VTT / SVG overlays render subtitles dynamically            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Creator Approves Edit & Clicks "Export"
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   HEADLESS CLOUD RENDER (FFMPEG ENGINE)                │
│       - apps/api/src/ffmpeg/pipeline.ts builds single-pass filtergraph │
│       - 9:16 Vertical crop/pad + Smart reframing                       │
│       - EBU R128 audio normalization (-14 LUFS)                        │
│       - Burned-in ASS subtitles with high-contrast outline             │
│       - Background music loop + Voice ducking                          │
│       - H.264 CRF 23 + Faststart flag for instant mobile streaming    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Timeline Semantics & Data Structure

The `EditTimeline` model represents the complete editable state of a project as a deterministic JSON structure (`apps/api/src/ffmpeg/pipeline.ts`):

```typescript
export interface EditTimelinePlan {
  projectId: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  operations: EditOperation[];
  effects: {
    subtitles?: {
      enabled: boolean;
      style: 'karaoke_bounce' | 'minimalist_clean' | 'modern_yellow' | 'classic_white' | 'bold_stroke';
      fontSize: number;
      uppercase: boolean;
    };
    audio?: {
      normalizeLoudness: boolean;
      targetLufs: number; // default: -14 LUFS
      musicTrackS3Key?: string;
      musicVolume: number; // default: 0.12
    };
    video?: {
      aspectRatio: '9:16' | '16:9' | '1:1';
      reframeStrategy: 'center_crop' | 'blur_pad' | 'face_track';
      dynamicZooms: boolean;
    };
  };
  outputs: Array<{
    format: 'reel' | 'short' | 'landscape';
    width: number;
    height: number;
  }>;
}

export type EditOperation =
  | { action: 'keep'; startSec: number; endSec: number }
  | { action: 'cut'; startSec: number; endSec: number; reason: string }
  | { action: 'zoom'; startSec: number; endSec: number; scale: number; pan: 'center' | 'left' | 'right' }
  | { action: 'speed'; startSec: number; endSec: number; speedMultiplier: number };
```

---

## 3. Sub-Second Boundary Snapping & PTS Accuracy

1. **Frame-Accurate In/Out Cuts:**
   - Raw H.264 video contains keyframes (I-frames) only every 1–2 seconds. Slicing video at container packet boundaries (`-c copy`) results in frozen frames or audio-video desynchronization.
   - AutoAI Edit enforces **full re-encoding of cut transitions** using FFmpeg `select` and `aselect` filter expressions, guaranteeing frame-accurate cuts to within $\pm 16.6\text{ms}$ (at 60fps) without audio pops.
2. **Audio-Video Lip-Sync Assurance:**
   - The audio filtergraph enforces `aresample=async=1000:min_hard_comp=0.100000:first_pts=0`, dynamically stretching or squeezing micro-samples to lock audio strictly to video presentation timestamps.

---

## 4. Subtitle Synchronization & Caption Styling (MVP Core Styles)

AutoAI Edit supports multiple caption styles in its MVP render configuration to satisfy diverse creator genres:

### 1. Karaoke Animated Subtitles (`karaoke_bounce`) — Default
- **Visuals:** Montserrat ExtraBold, high-contrast yellow/white fill with a 3.5px black outline and dynamic active-word scaling/color fill tracking Faster-Whisper word timestamps.
- **Audience:** High-energy TikTok, YouTube Shorts, and Instagram Reels (gaming, comedy, creator vlogs).

### 2. Clean Minimalist Subtitles (`minimalist_clean`)
- **Visuals:** Inter SemiBold or Helvetica, clean crisp white text with a subtle translucent dark background box, static per sentence or line without bouncing animations.
- **Audience:** Corporate interviews, educational tutorials, podcasts, and LinkedIn thought-leadership videos.

### Faster-Whisper to ASS Subtitle Pipeline:
1. **Timestamp Extraction:** Faster-Whisper yields word-level timestamps (`start`, `end`, `word`).
2. **Chunking & Line Breaks:** Subtitles are grouped into readable visual chunks of **3 to 5 words per line** to maximize legibility on 9:16 mobile screens.
3. **Advanced SubStation Alpha (ASS) Styling:**
   Burned-in subtitles use ASS format, specifying typography, margins, and outline strokes:
   ```ini
   [V4+ Styles]
   Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
   Style: Default,Montserrat ExtraBold,24,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,1,3.5,1.0,2,40,40,180,1
   ```
   - **Primary Color:** High-contrast yellow (`&H0000FFFF`) or clean white.
   - **Outline Stroke:** 3.5px black border ensuring readability over bright video backgrounds.
   - **Vertical Margin:** 180px offset from bottom to avoid overlapping TikTok / Instagram UI icons and captions.

---

## 5. Vertical Reframing & Aspect Ratio Conversion

Standard horizontal camera footage (1920x1080 16:9) is converted to vertical reel format (1080x1920 9:16) via three configurable strategies:

### Strategy 1: Center-Crop Reframing (Default Production Mode)
Extracts the center 9:16 vertical slice and scales to full 1080x1920 resolution:
```text
[0:v] crop=ih*9/16:ih:(iw-ow)/2:0, scale=1080:1920:flags=lanczos, format=yuv420p [v_out]
```

### Strategy 2: Blurred Background Padding (For Wide Action / Screen Shares)
Places the full 16:9 frame centered in the vertical canvas, filling top and bottom margins with a heavily blurred, darkened version of the video:
```text
[0:v] split=2 [bg][fg];
[bg] scale=1080:1920:flags=bilinear, boxblur=25:5, eq=brightness=-0.15 [bg_blur];
[fg] scale=1080:-1:flags=lanczos [fg_scale];
[bg_blur][fg_scale] overlay=(W-w)/2:(H-h)/2 [v_out]
```

### Strategy 3: Dynamic Speaker Face Tracking (Roadmap `PROD-004`)
- Detects the primary speaker's face bounding box using OpenCV / MediaPipe face tracking.
- Smooths horizontal pan transitions with a moving average filter to smoothly track moving speakers without jittery camera jumps.

---

## 6. EBU R128 Audio Loudness Normalization & Voice Ducking

Mobile social platforms (YouTube Shorts, Instagram, TikTok) aggressively compress or penalize audio with inconsistent loudness. AutoAI Edit implements a **Dual-Stage Audio Pipeline**:

1. **Integrated Loudness Target:** Target $-14.0\text{ LUFS}$ with a maximum true peak of $-1.5\text{ dBTP}$ and a loudness range of $7.0\text{ LU}$.
2. **FFmpeg Loudnorm Filter:**
   ```text
   loudnorm=I=-14:TP=-1.5:LRA=7:dual_mono=true
   ```
3. **Automated Voice Ducking:**
   When background music is enabled (`PROD-007`), the background music track is fed through an audio sidechain compressor (`sidechaincompress`), dynamically ducking music volume by $-16\text{ dB}$ whenever speech is present and smoothly fading music up by $+6\text{ dB}$ during speech pauses.

---

## 7. Render Presets & Encoding Specifications

All video outputs are encoded to meet strict mobile playback and social platform ingestion requirements:

| Preset Name | Target Use Case | Resolution | Frame Rate | Video Codec | CRF / Bitrate | Audio Codec | Faststart Flag | Avg 60s Render Time |
|---|---|---|---|---|---|---|---|---|
| **Fast Draft** | Quick internal preview | 720x1280 (9:16) | 30 fps | libx264 (ultrafast) | CRF 28 | AAC 96 kbps | Enabled | ~12 seconds |
| **Production Balanced** | Standard Shorts & Reels | 1080x1920 (9:16) | 30/60 fps | libx264 (medium) | CRF 23 | AAC 128 kbps | Enabled | ~25 seconds |
| **High Fidelity** | Master YouTube / 4K | 2160x3840 (9:16) | 60 fps | libx264 (slow) | CRF 18 | AAC 192 kbps | Enabled | ~90 seconds |

> [!IMPORTANT]
> **Web & Mobile Streaming (`+faststart`):** Every FFmpeg export command appends `-movflags +faststart`. This moves the MP4 file index (`moov` atom) to the front of the file, allowing mobile browsers and social feeds to begin playback instantly without waiting for the full video to download.
