# AutoAI Edit — Local AI Fallback & Transcription Reliability (Step 2C)

This document details the reliability architecture introduced in **Step 2C** for speech transcription and natural-language prompt editing when external or paid AI services are unavailable.

---

## 1. Speech Transcription Architecture

Speech transcription is handled via the local Docker sidecar service `autoedit-local-whisper` (`faster-whisper`), running at `http://127.0.0.1:9000` with the `base` model.

### 1.1 Live Transcription
- **Endpoint:** `POST http://127.0.0.1:9000/transcribe`
- **Output:** Returns detected language, duration, full-text segments, and word-level timestamps with confidence scores.
- **Persistence:** Saved to `Transcript` table with `model: 'base'` and associated word arrays.

### 1.2 Offline / Failure Handling
When Whisper is unavailable (connection refused, request timeout, HTTP 500):
- **Bounded Retries:** Requests are wrapped in bounded exponential backoff retries (`retry(..., 3)`).
- **Explicit Unavailable State:** If all retries fail, `analysisWorker` records `model: 'unavailable'`, `segments: []`, and `words: []`.
- **No Fabricated Transcripts:** The system never invents fake words or simulated timestamps.
- **Transcript-Dependent Operations Disabled:** Burned-in subtitles (`effects.subtitles`) are automatically set to `false`.
- **Degraded Silence-Only Analysis:** If the audio stream is intact and FFmpeg detects non-silent intervals, the system generates an active-audio edit plan subtracting detected silences, clearly labeled in summary and strategy.
- **Corrupt Media Protection:** If media headers or audio streams are unreadable or corrupt, FFprobe and `extractAudio` fail immediately, ensuring corrupt media is never falsely marked as successful.

---

## 2. Deterministic Prompt Editing (Without Paid Claude)

When `AI_PROVIDER=fallback` or when Claude is unavailable (HTTP 401, quota limits, connection failures), AutoAI Edit activates a deterministic editing engine implemented in `apps/api/src/services/deterministic-edit.service.ts`.

### 2.1 Supported Commands

| Command Category | Examples / Trigger Patterns | Action on Timeline |
|---|---|---|
| **Remove Silence** | `"remove silences"`, `"cut silence"`, `"remove pauses"` | Subtracts detected silence intervals from active clips; fails with clear error if no silences detected. |
| **Trim Start / Beginning** | `"trim first 3 seconds"`, `"cut the intro"`, `"trim start by 5s"` | Trims the beginning of the timeline by N seconds, clamping and dropping completely cut clips. |
| **Trim End / Outro** | `"cut last 4 seconds"`, `"trim the outro"`, `"trim end by 3s"` | Trims the end of the timeline by N seconds, clamping the final clip duration. |
| **Aspect Ratio: Vertical (9:16)** | `"make it vertical"`, `"convert to 9:16"`, `"format as Reel/Short"` | Updates target aspect ratio metadata to `9:16` for vertical short-form rendering. |
| **Aspect Ratio: Landscape (16:9)** | `"make it horizontal"`, `"switch to 16:9"`, `"convert to landscape"` | Updates target aspect ratio metadata to `16:9` for widescreen video rendering. |
| **Toggle Subtitles / Captions** | `"enable subtitles"`, `"turn off captions"`, `"burn in captions"` | Toggles `effects.subtitles`. **Crucial:** Enabling subtitles requires an available transcript; if no transcript exists, rejects with an explicit structured error. |
| **Crop / Zoom Motion** | `"add dynamic zoom"`, `"set zoom factor to 1.2"`, `"disable zoom"` | Toggles `effects.zooms` and sets per-clip zoom factor (bounded between 1.0 and 1.3) for Ken Burns effects. |
| **Transitions / Crossfade** | `"enable crossfade"`, `"hard cuts"` | Sets `effects.transitions` to `'fade'` (0.25s audio/video crossfade) or `'none'`. |

### 2.2 Unsupported Instructions
If an instruction cannot be deterministically mapped (e.g. `"make 3D hologram explosion"`, `"translate to French"`):
- The system **never pretends** the edit succeeded.
- Returns HTTP 400 Bad Request with code `UNSUPPORTED_PROMPT` and a list of supported editing operations.

---

## 3. AI Provider Failover & Credential Protection

### 3.1 Claude HTTP 401 & Rate Limit Failover
- In `apps/api/src/ai/providers.ts` and `apps/api/src/services/claude.service.ts`:
  - Catches `401 Unauthorized`, `AuthenticationError`, `429 RateLimit`, and connection timeouts.
  - Caches invalid API keys in-memory (`markApiKeyInvalid`) to prevent repeated hammering of external APIs.
  - Automatically falls back to deterministic timeline generation.
  - Never leaks API keys, secrets, or tokens in logs or error messages.

### 3.2 Strict Fallback Mode
When `AI_PROVIDER=fallback`:
- Zero paid API requests are made.
- Anthropic SDK calls are completely bypassed.
- Analysis, prompt editing, clip explanations, and social copy generation execute purely deterministically.

---

## 4. Version History Preservation & Renderer Compatibility

- **Immutable Edit Versions:** Every prompt edit creates an immutable `EditVersion` row linked via `parentVersionId` to form a non-destructive version chain. Prior versions are never mutated.
- **Renderer Contract:** All deterministic timeline outputs are validated through `validateTimeline()`, ensuring all segment boundaries are strictly within `[0, durationSec]`, with positive duration (`>= 100ms`), and normalized indexing compatible with fluent-ffmpeg renderer pipelines.
