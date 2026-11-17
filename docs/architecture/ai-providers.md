# AutoAI Edit — Modular AI Provider Boundary & Transcription Architecture (Step 3B.3 & 3B.3.1)

## 1. Overview & Architecture Evolution

AutoAI Edit relies on AI analysis to generate video timelines, highlight cues, caption alignments, hook suggestions, and platform-specific social copy. In Step 3B.3 and 3B.3.1, the system introduces a hardened, modular, fail-closed AI provider boundary to guarantee reliability, safety, and strict validation across development, local testing, and production environments.

### Core Architectural Goals
1. **Reuse and Enhance Existing Abstraction:** Improve the provider abstraction in `apps/api/src/ai/providers.ts` rather than introducing duplicate classes.
2. **Fail-Closed Provider Selection:** Reject unknown or misspelled AI provider configurations immediately without network requests, background jobs, or silent fallback.
3. **Comprehensive Output Boundary Validation:** Validate all timestamp-bearing fields (operations, highlights, captions, speaker segments, hooks, thumbnails) with Zod using an explicit floating-point tolerance (`FP_TOLERANCE_SEC = 0.05`).
4. **Validation of All Outputs (Including Fallback):** Validate successful primary provider outputs, explicit deterministic fallback outputs, and emergency fallback outputs through the exact same schema. Fail closed if fallback itself produces invalid output.
5. **Precise Error Taxonomy:** Distinguish transient network issues, rate limits, and configuration errors from genuine programming faults (`TypeError`, `ReferenceError`). Differentiate network-related `TypeError` (e.g. `fetch failed`) from programming bugs.
6. **Clean Transcription Provider Interface:** Abstract the faster-whisper sidecar in `apps/api/src/services/transcribe.service.ts` to allow alternative Whisper backends or remote CPU/GPU transcription services.
7. **Zero Secret Leakage:** Sanitize all diagnostic output and warning logs so API keys or user transcript data are never leaked.
8. **No Fabricated Speech:** Strictly prevent hallucinated captions when audio transcripts are missing or unavailable.

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

### Provider Registry and Selection Mechanics
AutoAI Edit supports dynamic provider registration and deterministic resolution via:
- `registerAiProvider(name, provider)`: Registers a custom or mock provider for unit testing or microservice sidecars.
- `resolveAiProvider(name?)`: Resolves the active provider by priority:
  1. Registered provider instance from registry (case-insensitive).
  2. Built-in provider matching `'claude'`, `'ollama'`, or `'fallback'`.
  3. **Fail-Closed Policy:** Any unknown or misspelled provider name throws `AiProviderError` (`category: 'INVALID_CONFIGURATION'`, `isFallbackEligible: false`). It is **never** silently converted to fallback.
- `resetAiProviders()`: Restores the registry to clean initial state.

---

## 3. Provider Implementations

| Provider | Class Name | Execution Model | Fallback Handling |
| :--- | :--- | :--- | :--- |
| **Claude** | `ClaudeProvider` | Anthropic Claude Messages API (`claude-sonnet-4-6`) with forced tool call (`submit_video_analysis`). | Fails over to fallback on missing credentials, 401 auth errors, 429 rate limits, connection drops, timeouts, or schema mismatches. |
| **Ollama** | `OllamaProvider` | Local Ollama HTTP endpoint (`/api/generate`) with `AbortSignal.timeout(60000)`. | Fails over to fallback if local Ollama daemon is offline (`ECONNREFUSED`), times out, or produces unparseable JSON. |
| **Fallback** | `FallbackProvider` | Pure deterministic calculation based on detected audio silences and word boundaries. | Validated through output validator. Fails closed if output cannot be validated. |

---

## 4. Zod Validation at Provider Output Boundaries

Validation is performed directly at the exit boundary of `runAiProvider()`, **before** normalization or database persistence. If a provider returns corrupted operations, the boundary rejects them immediately rather than silently clamping malformed ranges into arbitrary 0-second slices.

```typescript
export const FP_TOLERANCE_SEC = 0.05; // 50ms explicit floating-point tolerance

export function createPipelineResultValidator(durationSec: number, hasTranscript: boolean);
```

### Invariants Enforced by Validation:
1. **Timestamp Bounds & Ordering Across All Fields:**
   - **Operations:** `0 <= start < end <= durationSec + FP_TOLERANCE_SEC`.
   - **Highlights:** `0 <= start < end <= durationSec + FP_TOLERANCE_SEC`.
   - **Captions:** `0 <= start < end <= durationSec + FP_TOLERANCE_SEC`.
   - **Speaker Segments:** `0 <= start < end <= durationSec + FP_TOLERANCE_SEC`.
   - **Hook Timestamps:** `0 <= start < end <= durationSec + FP_TOLERANCE_SEC`.
   - **Thumbnail Frame:** `0 <= bestFrameSec <= durationSec + FP_TOLERANCE_SEC`.
2. **Strict Rejection of Non-Finite Numbers:**
   - `NaN`, `Infinity`, and negative values are rejected immediately.
3. **Explicit Precision Tolerance:**
   - A strict 50ms tolerance (`FP_TOLERANCE_SEC = 0.05`) accounts for fractional audio frame boundaries without permitting whole-second overshoots.
4. **Degraded Audio Constraint (No Phantom Dialogue):**
   - When `hasTranscript === false` (silence-only or no-audio media), `captions` **must** be empty (`[]`). Any invented captions cause instant schema rejection.
5. **Metadata Preservation:**
   - Schemas use `.passthrough()` so supported optional attributes (e.g. `speedMultiplier`, per-clip zooms, custom metadata) are preserved.

---

## 5. Error Taxonomy & Classified Fallback Policy

AutoAI Edit classifies all errors into explicit categories via `classifyAiError()`:

```typescript
export type AiErrorCategory =
  | 'MISSING_CREDENTIALS'   // Empty or unset API key
  | 'AUTHENTICATION'        // HTTP 401 / invalid x-api-key (cached to prevent hammering)
  | 'RATE_LIMIT'            // HTTP 429 / quota exceeded
  | 'CONNECTION'            // Network failure, DNS error, ECONNREFUSED
  | 'TIMEOUT'               // Abort timeout or gateway timeout (HTTP 504)
  | 'MALFORMED_RESPONSE'    // Unparseable JSON or schema validation failure
  | 'INVALID_OPERATION'     // Operations with invalid time ranges or NaN
  | 'PROGRAMMING_ERROR'     // TypeError, ReferenceError, unexpected logic defects
  | 'INVALID_CONFIGURATION';// Unknown or misconfigured provider name
```

### Safety and Secret Protection Policies:
- **Differentiated Programming Errors:**
  - `ReferenceError` is **always** classified as `PROGRAMMING_ERROR` (`isFallbackEligible: false`).
  - `TypeError` is checked via `isNetworkError()`. If it is a Node.js network error (e.g. `fetch failed` with `cause.code: 'ECONNREFUSED'`), it is classified as `CONNECTION` or `TIMEOUT`. If it is a genuine programming defect (e.g. `Cannot read properties of undefined`), it is classified as `PROGRAMMING_ERROR` and rethrown immediately.
- **Fail-Closed Fallback Validation:**
  - Fallback results generated after external failures are validated through `validatePipelineResult()`.
  - If a fallback result fails validation, it throws with `isFallbackEligible: false`, preventing recursive fallback loops.
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
  - `setTranscriptionProvider(provider)`: Replaces the active provider.
  - `resetTranscriptionProvider()`: Restores `FasterWhisperTranscriptionProvider`.

---

## 7. Future Worker & Microservice Compatibility

The modular provider boundaries established in Step 3B.3 & 3B.3.1 prepare AutoAI Edit for horizontal scaling:
- **Dedicated CPU/GPU Workers:** Future transcription workers running on GPU nodes can implement `TranscriptionProvider` and communicate via message queues or gRPC.
- **Local Model Sidecars:** Large language models running on separate GPU instances (e.g. vLLM or Ollama servers) can register as custom `AiProvider` instances via `registerAiProvider()`.
- **Zero Business Logic Rewrites:** Downstream workers (`analysis.worker.ts`, `render.worker.ts`) and API routes remain completely insulated from LLM backend changes.
