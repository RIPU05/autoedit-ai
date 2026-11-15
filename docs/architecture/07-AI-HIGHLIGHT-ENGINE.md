# AUTOAI EDIT — MULTIMODAL AI HIGHLIGHT ENGINE

**Document ID:** ARCH-007  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** AI Systems Architecture & Signal Processing Specification

---

## 1. Engine Philosophy: Inexpensive Signals First, Deep Models Last

Video AI clipping systems that stream every minute of a 6-hour video directly through an LLM are economically non-viable: a 6-hour stream contains ~360 minutes of audio, costing $50+ in continuous token fees and saturating API rate limits.

AutoAI Edit employs a **Tiered Multimodal Sieve**:
1. **Tier 1 (Deterministic & Inexpensive Signals):** High-throughput mathematics detect candidate clusters based on chat velocity spikes, audio loudness peaks, and speech density without incurring LLM costs ($0.00 compute).
2. **Tier 2 (Acoustic & Semantic Transcripts):** Faster-Whisper GPU runs only on audio streams, generating word-level timestamps and segment confidence.
3. **Tier 3 (Multi-Agent LLM Reasoning):** Claude 3.5 Sonnet / Ollama evaluates only the top candidate clusters, extracting viral hooks, narrative context, and editorial reasoning.

```
Raw Livestream / VOD (100% of duration)
  │
  ▼
[TIER 1: DETERMINISTIC FILTERING] (Fast C++ / Math)
  - Chat Velocity Spikes (Messages / sec > 3x moving avg)
  - Audio Loudness (EBU R128 momentary peaks > -12 LUFS)
  - Silence Boundaries (FFmpeg silencedetect)
  │
  ▼ (Reduces search space to ~15% of total runtime)
[TIER 2: ACOUSTIC & WORD TRANSCRIPTION] (Faster-Whisper GPU)
  - Word Timestamps & Speech Pacing (WPM > 175)
  - Emote Density & Keyword Clustering
  │
  ▼ (Reduces search space to ~5% top candidate clusters)
[TIER 3: MULTI-AGENT LLM REASONING] (Claude 3.5 Sonnet)
  - Hook Extraction & Virality Scoring
  - Narrative Arc Validation (Setup → Climax → Punchline)
  - Explainable AI Synthesis (Editorial Strategy)
  │
  ▼
Final Curated Highlights (1% of duration: 5–10 viral short-form clips)
```

---

## 2. Signal Definitions & Mathematical Contracts

Every moment in a video or broadcast is evaluated across 6 time-series signal dimensions normalized on a scale of $0.0 \le S_i(t) \le 1.0$:

### 1. Chat Velocity & Surge ($S_{\text{chat}}$)
- **Calculation:** Evaluated over a 15-second sliding window against a 5-minute exponentially weighted moving average (EWMA):
  $$\text{VelocityRatio}(t) = \frac{\text{Count}_{15s}(t)}{\text{EWMA}_{300s}(t) + \epsilon}$$
- **Emote Weighting:** Messages containing recognized excitement emotes (`KEKW`, `OMEGALUL`, `POG`, `W`, `LUL`, `???`) receive a $1.5\times$ multiplier.
- **Normalized Score:**
  $$S_{\text{chat}}(t) = \min\left(1.0, \frac{\text{VelocityRatio}(t)}{4.0}\right)$$

### 2. Audio Loudness & Energy Peak ($S_{\text{audio}}$)
- **Calculation:** Evaluated via FFmpeg `ebur128` momentary loudness $M(t)$ and root-mean-square energy:
  $$S_{\text{audio}}(t) = \begin{cases} 0.0 & \text{if } M(t) < -24 \text{ LUFS} \\ \frac{M(t) - (-24)}{-6 - (-24)} & \text{if } -24 \le M(t) \le -6 \text{ LUFS} \\ 1.0 & \text{if } M(t) > -6 \text{ LUFS} \end{cases}$$

### 3. Speech Excitement & Pacing ($S_{\text{speech}}$)
- **Calculation:** Words per minute (WPM) computed from Faster-Whisper word timestamps over a 10-second interval:
  $$S_{\text{speech}}(t) = \min\left(1.0, \max\left(0.0, \frac{\text{WPM}(t) - 120}{220 - 120}\right)\right)$$

### 4. Semantic Significance & Hook Quality ($S_{\text{semantic}}$)
- **Calculation:** Extracted by LLM evaluating transcript context against viral hook archetypes (controversy, revelation, conflict, high-stakes question).
- **Normalized Score:** Evaluated directly as a $0.0 \text{ to } 1.0$ confidence rating.

### 5. Silence & Dead Air Penalty ($P_{\text{silence}}$)
- **Calculation:** If a silence gap exceeding 1.2 seconds is detected, a heavy negative penalty is applied to prevent cutting during awkward pauses:
  $$P_{\text{silence}}(t) = 0.5 \text{ (if in detected silence interval)}$$

### 6. Manual Creator Bookmark ($S_{\text{bookmark}}$)
- **Calculation:** If the creator or moderator pressed a stream deck hotkey or dashboard bookmark button within $\pm 30\text{s}$, $S_{\text{bookmark}} = 1.0$.

---

## 3. Candidate Scoring & Context Expansion Algorithm

### Composite Scoring Equation:
$$\text{Score}(t) = w_{\text{chat}} S_{\text{chat}}(t) + w_{\text{audio}} S_{\text{audio}}(t) + w_{\text{speech}} S_{\text{speech}}(t) + w_{\text{semantic}} S_{\text{semantic}}(t) + w_{\text{bm}} S_{\text{bookmark}}(t) - P_{\text{silence}}(t)$$

*Default Weight Vectors:*
- **Live Streams with Chat:** $w_{\text{chat}} = 0.35, w_{\text{audio}} = 0.20, w_{\text{speech}} = 0.15, w_{\text{semantic}} = 0.20, w_{\text{bm}} = 0.30$
- **Pre-Recorded Uploads (No Chat):** $w_{\text{chat}} = 0.00, w_{\text{audio}} = 0.25, w_{\text{speech}} = 0.30, w_{\text{semantic}} = 0.45, w_{\text{bm}} = 0.00$

### Context Expansion & Dynamic Boundaries:
A raw signal peak (e.g. an in-game headshot at $t=142\text{s}$) is not a standalone clip. High engagement short-form videos require **narrative arc context**:
1. **Pre-Roll (The Setup):** Expand backwards by $8 \text{ to } 15\text{ seconds}$ to capture the context or question that led to the moment. Snap backwards to the nearest completed sentence boundary or silence cut.
2. **Post-Roll (The Climax & Resolution):** Expand forward by $10 \text{ to } 20\text{ seconds}$ to capture the reaction, laughter, or conclusion. Snap forward to the nearest natural sentence conclusion.
3. **Clamping & Duration Guardrails:**
   - Minimum Clip Length: **18 seconds** (shorter clips lack sufficient narrative weight).
   - Maximum Clip Length: **60 seconds** (optimal for YouTube Shorts / TikTok retention algorithms).

### Candidate Deduplication & Merging:
- **Collision Detection:** If Candidate A $[t_1, t_2]$ and Candidate B $[t_3, t_4]$ are separated by less than **12 seconds**, they are automatically merged into a single cohesive highlight cluster $[t_1, \max(t_2, t_4)]$ to prevent fragmented duplicate cuts.

---

## 4. Multi-Agent LLM Synthesis & Explainability

When top candidate clusters are selected, they are passed to the multi-agent AI pipeline (`apps/api/src/services/claude.service.ts`):

```
                        ┌───────────────────────────────────────┐
                        │   Selected Candidate Transcript Window│
                        └───────────────────┬───────────────────┘
                                            │
                        ┌───────────────────▼───────────────────┐
                        │      Multi-Agent Prompt Pipeline      │
                        └───────┬───────────┬───────────┬───────┘
                                │           │           │
            ┌───────────────────┘           │           └───────────────────┐
            ▼                               ▼                               ▼
  ┌───────────────────┐           ┌───────────────────┐           ┌───────────────────┐
  │  Director Agent   │           │    Hook Agent     │           │  Social Copy Agent│
  │ - Narrative Flow  │           │ - Identify Hook   │           │ - 3 Viral Titles  │
  │ - Trim Offsets    │           │ - Hook Rating     │           │ - Hashtag Sets    │
  │ - Virality Score  │           │ - Curiosity Gap   │           │ - Video Captions  │
  └─────────┬─────────┘           └─────────┬─────────┘           └─────────┬─────────┘
            │                               │                               │
            └───────────────────────┬───────┴───────────────────────────────┘
                                    │
                                    ▼
                      ┌───────────────────────────┐
                      │ Explainable AI Narrative  │
                      │ (Saved in EditVersion &   │
                      │ displayed in Studio UI)   │
                      └───────────────────────────┘
```

### Explainable Evidence Output Schema:
Every clip stores an evidence record directly consumed by the UI (`SCR-008`):
```json
{
  "compositeScore": 88.5,
  "hookQuote": "Nobody thought this was possible until today.",
  "hookScore": 94,
  "hookMechanism": "Curiosity Gap / Contrarian Statement",
  "editorialStrategy": "Opens with provocative claim, cuts directly to 185 WPM gameplay climax, concludes on creator reaction.",
  "evidenceSignals": {
    "chatSurge": "+380% velocity surge (42 msgs/sec)",
    "topEmotes": ["KEKW", "POG", "OMEGALUL"],
    "audioPeak": "-7.4 LUFS (High emotional excitement)",
    "deadAirCut": "4.8 seconds of silence eliminated"
  }
}
```

---

## 5. Creator Style Learning & Feedback Memory

AutoAI Edit incorporates creator feedback to tune future candidate selections (`EDIT-012`):
1. **Manual Trim Adjustments:** If a creator consistently extends intro buffers by 3 seconds, `CreatorProfile.signals.introBufferOffsetSec` increments.
2. **Rejected Clips:** If clips flagged primarily by audio peaks are rejected, the weighting for $w_{\text{audio}}$ is dynamically decreased for that creator's profile.
3. **Pacing Bias:** The `pacingPreference` ('fast' vs 'balanced') adjusts the silence cut threshold between $0.3\text{s}$ (hyper-fast TikTok pacing) and $0.8\text{s}$ (documentary/podcast pacing).
