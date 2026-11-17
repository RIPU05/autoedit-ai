# AutoAI Edit — Modular AI Provider Boundary & Transcription Architecture (Step 3B.3)

## 1. Overview & Architecture Evolution

AutoAI Edit relies on AI analysis to generate video timelines, highlight cues, caption alignments, hook suggestions, and platform-specific social copy. In Step 3B.3, the system introduces a hardened, modular AI provider boundary to guarantee reliability, safety, and strict validation across development, local testing, and production environments.

### Core Architectural Goals
1. **Reuse and Enhance Existing Abstraction:** Improve the provider abstraction in `apps/api/src/ai/providers.ts` rather than introducing duplicate classes.
2. **Strict Output Boundary Validation:** Validate all AI outputs with Zod before updating database project records or executing downstream FFmpeg renders.
3. **Structured Error Taxonomy:** Distinguish transient network issues, rate limits, and configuration errors from genuine programming faults.
4. **Deterministic Fallback Policy:** Ensure fallback triggers reliably for recoverable AI failures without silencing bugs or corrupting user timelines.
5. **Clean Transcription Provider Interface:** Abstract the faster-whisper sidecar in `apps/api/src/services/transcribe.service.ts` to allow alternative Whisper backends or remote CPU/GPU transcription services.
6. **Zero Secret Leakage:** Sanitize all diagnostic output and warning logs so API keys or user transcript data are never leaked.
7. **No Fabricated Speech:** Strictly prevent hallucinated captions when audio transcripts are missing or unavailable.

---

## 2. Hardened AI Provider Boundary: `AiProvider`

Defined in `apps/api/src/ai/providers.ts`:

```typescript
export interface AiProvider {
  name: AiProviderName;
  analyzeTranscript(input: AiProviderInput): Promise<PipelineResult>;
  generateTimeline(input: AiProviderInput): Promise<PipelineResult['operations']>;
  generateTitles(input: AiProviderInput): Promise<PipelineResult['suggestedTitles']>;
  generateCaptions(input: AiProviderInput): Promise<PipelineResult['captions']>;
  generateSocialCopy(input: AiProviderInput): Promise<PipelineResult['socialCopy']>;
}
```

### Provider Registry and Selection
AutoAI Edit supports dynamic provider registration and deterministic resolution via:
- `registerAiProvider(name, provider)`: Registers a custom or mock provider for unit testing or microservice sidecars.
- `resolveAiProvider(name?)`: Resolves the active provider by priority:
  1. Explicit caller target (e.g. `runAiProvider(input, { provider: 'claude' })` or `input.provider`).
  2. Registered provider instance from registry.
  3. Environment configuration (`process.env.AI_PROVIDER` or `env.AI_PROVIDER`).
  4. Unknown or unconfigured names fall back cleanly to `FallbackProvider`.
- `resetAiProviders()`: Restores the registry to clean initial state.

---

## 3. Provider Implementations

| Provider | Class Name | Execution Model | Fallback Handling |
| :--- | :--- | :--- | :--- |
| **Claude** | `ClaudeProvider` | Anthropic Claude Messages API (`claude-sonnet-4-6`) with forced tool call (`submit_video_analysis`). | Fails over to fallback on missing credentials, 401 auth errors, 429 rate limits, connection drops, timeouts, or schema mismatches. |
| **Ollama** | `OllamaProvider` | Local Ollama HTTP endpoint (`/api/generate`) with `AbortSignal.timeout(60000)`. | Fails over to fallback if local Ollama daemon is offline (`ECONNREFUSED`), times out, or produces unparseable JSON. |
| **Fallback** | `FallbackProvider` | Pure deterministic calculation based on detected audio silences and word boundaries. | Never fails; always produces valid timelines within `[0, durationSec]`. |

---

## 4. Zod Validation at Provider Output Boundaries

Before any AI output is accepted by the analysis worker or stored in the database, `validatePipelineResult()` executes a strict Zod schema validation:

```typescript
export function createPipelineResultValidator(durationSec: number, hasTranscript: boolean);
```

### Invariants Enforced by Validation:
1. **Time Range Integrity:**
   - Every operation start and end must be finite, non-negative numbers.
   - `0 <= start < end <= durationSec + tolerance`.
   - Inverted ranges (`start >= end`) or negative offsets are rejected with `INVALID_OPERATION`.
2. **Finite Numbers:**
   - `NaN` and `Infinity` are rejected.
3. **Timeline Completeness:**
   - Timeline operations list must contain at least one operation.
4. **Degraded Audio Constraint:**
   - When `hasTranscript === false` (silence-only or no-audio media), `captions` **must** be empty (`[]`). Any invented captions cause instant schema rejection to avoid hallucinated speech.
5. **Platform Copy & Editorial Fields:**
   - Required editorial fields (`summary`, `strategy`, `suggestedTitles`, `hook`, `thumbnail`, `effects`, `model`) must be present and correctly typed.

---

## 5. Error Taxonomy & Classified Fallback Policy

AutoAI Edit classifies all errors into explicit categories via `classifyAiError()`:

```typescript
export type AiErrorCategory =
  | 'MISSING_CREDENTIALS'  // Empty or unset API key
  | 'AUTHENTICATION'       // HTTP 401 / invalid x-api-key (cached to prevent hammering)
  | 'RATE_LIMIT'           // HTTP 429 / quota exceeded
  | 'CONNECTION'           // Network failure, DNS error, ECONNREFUSED
  | 'TIMEOUT'              // Abort timeout or gateway timeout (HTTP 504)
  | 'MALFORMED_RESPONSE'   // Unparseable JSON or schema validation failure
  | 'INVALID_OPERATION'    // Operations with invalid time ranges or NaN
  | 'PROGRAMMING_ERROR';   // TypeError, ReferenceError, logic defects
```

### Safety and Secret Protection Policies:
- **Programming Error Protection:** `TypeError` and `ReferenceError` set `isFallbackEligible: false`. They are **never** silently masked and are rethrown immediately so development regressions are detected promptly.
- **Log Sanitization:** All logs and error reasons are filtered through `sanitizeLogSecret()`. Anthropic API keys (`sk-ant-***`), Bearer tokens, and sensitive headers are redacted before emission.
- **Auth Failure Caching:** When Anthropic returns HTTP 401, the invalid key is cached in `markApiKeyInvalid()`. Future pipeline calls immediately route to deterministic fallback rather than making failing requests.

---

## 6. Transcription Provider Boundary

AutoAI Edit abstracts audio transcription via `TranscriptionProvider` in `apps/api/src/services/transcribe.service.ts`:

```typescript
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audioPath: string, language?: string, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  checkHealth(opts?: { baseUrl?: string; timeoutMs?: number }): Promise<boolean>;
}
```

### Implementations:
- `FasterWhisperTranscriptionProvider`: Default implementation connecting to the local `services/whisper` sidecar container over HTTP.
- Lifecycle Management:
  - `getTranscriptionProvider()`: Returns the active provider.
  - `setTranscriptionProvider(provider)`: Replaces the active provider (used for testing or alternative transcription backends).
  - `resetTranscriptionProvider()`: Restores `FasterWhisperTranscriptionProvider`.

### Preserved Metadata:
- Word-level timestamps (`start`, `end`, `word`, `confidence`).
- Segment-level timestamps (`start`, `end`, `text`, `speaker`, `confidence`).
- Detected language (`en`, `hi`, `hinglish`, etc.).
- Average confidence score (`avgConfidence`).

---

## 7. Degraded Audio & Silence-Based Resilience

When media has no audio track or the transcription provider is unavailable:
1. `probe()` detects lack of audio stream (`hasAudioStream()`).
2. The analysis worker skips audio extraction and assigns an empty transcript (`segments: []`, `words: []`).
3. `buildFallbackPipelineResult()` calculates active spans by subtracting detected silences (`detectSilences()`).
4. `captions` is explicitly set to `[]`.
5. The Zod validator enforces `captions.length === 0` when `hasTranscript === false`.
6. Automatic renders proceed seamlessly using visual/silence cutpoints.

---

## 8. Future Worker & Microservice Compatibility

The modular provider boundaries established in Step 3B.3 prepare AutoAI Edit for horizontal scaling:
- **Dedicated CPU/GPU Workers:** Future transcription workers running on GPU nodes can implement `TranscriptionProvider` and communicate via message queues or gRPC.
- **Local Model Sidecars:** Large language models running on separate GPU instances (e.g. vLLM or Ollama servers) can register as custom `AiProvider` instances via `registerAiProvider()`.
- **Zero Business Logic Rewrites:** Downstream workers (`analysis.worker.ts`, `render.worker.ts`) and API routes remain completely insulated from LLM backend changes.

---

## 9. Known Limitations & Next Steps

1. **Local Ollama Availability:** In development without a local Ollama daemon, setting `AI_PROVIDER=ollama` automatically degrades to `FallbackProvider` as intended.
2. **Next Milestone (Step 3C):** URL Ingestion and external media download pipelines will feed directly into this hardened transcription and AI pipeline.
