import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  runAiProvider,
  resolveAiProvider,
  registerAiProvider,
  resetAiProviders,
  ClaudeProvider,
  OllamaProvider,
  FallbackProvider,
  createPipelineResultValidator,
  classifyAiError,
  AiProviderError,
  sanitizeLogSecret,
  markApiKeyInvalid,
  resetInvalidApiKeyCache,
  isApiKeyMarkedInvalid,
} from '../../src/ai/providers.js';
import {
  getTranscriptionProvider,
  setTranscriptionProvider,
  resetTranscriptionProvider,
  FasterWhisperTranscriptionProvider,
  type TranscriptionProvider,
  transcribeRich,
  transcriberHealthy,
} from '../../src/services/transcribe.service.js';
import type { VideoMeta, TranscriptCue } from '../../src/services/claude.service.js';

describe('AI Provider Boundaries, Validation & Error Taxonomy (Step 3B.3)', () => {
  const meta: VideoMeta = { durationSec: 30, width: 1920, height: 1080, fps: 30 };
  const sampleTranscript: TranscriptCue[] = [
    { start: 0, end: 5, text: 'Welcome to the tutorial on automated video editing.', speaker: 'spk_0' },
    { start: 5, end: 12, text: 'Today we will see how fast it works.', speaker: 'spk_0' },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    resetAiProviders();
    resetInvalidApiKeyCache();
    resetTranscriptionProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAiProviders();
    resetInvalidApiKeyCache();
    resetTranscriptionProvider();
  });

  // 1. Provider selection
  it('1. correctly selects registered providers and allows custom provider registration', () => {
    expect(resolveAiProvider('claude')).toBeInstanceOf(ClaudeProvider);
    expect(resolveAiProvider('ollama')).toBeInstanceOf(OllamaProvider);
    expect(resolveAiProvider('fallback')).toBeInstanceOf(FallbackProvider);

    // Custom provider registration
    const customProvider = {
      name: 'custom-mock' as any,
      analyzeTranscript: vi.fn(),
    };
    registerAiProvider('custom-mock', customProvider as any);
    expect(resolveAiProvider('custom-mock')).toBe(customProvider);

    // Unknown provider falls back to FallbackProvider
    expect(resolveAiProvider('unknown-nonexistent')).toBeInstanceOf(FallbackProvider);
  });

  // 2. Claude invocation through boundary
  it('2. invokes Claude provider through boundary and validates structured output', async () => {
    const mockClaude = new ClaudeProvider();
    const validClaudeResult = {
      summary: 'A concise video guide.',
      strategy: 'High energy pacing',
      reasoning: 'Editorial cut',
      highlights: [{ start: 0, end: 10, label: 'Intro', score: 0.9 }],
      silences: [],
      speakers: [{ id: 'spk_0', label: 'Speaker 1', segments: [{ start: 0, end: 12 }] }],
      captions: [{ start: 0, end: 5, text: 'Welcome to the tutorial' }],
      suggestedTitles: ['Fast Video Editing'],
      socialCopy: { instagram: 'IG copy', tiktok: 'TT copy', youtube: 'YT copy', linkedin: 'LI copy' },
      hook: { hook: { text: 'Watch this edit', start: 0, end: 3 }, alternatives: ['Alt hook'] },
      thumbnail: { bestFrameSec: 2, overlayText: 'Fast AI', concept: 'High visual clarity' },
      agentLog: [{ agent: 'director', summary: 'Planned cuts', ms: 120 }],
      operations: [{ index: 0, start: 0, end: 12, label: 'Part 1', keep: true, zoom: 1.05 }],
      effects: { subtitles: true, zooms: true, transitions: 'fade' as const, music: false },
      model: 'claude-test',
    };

    vi.spyOn(mockClaude, 'analyzeTranscript').mockResolvedValue(validClaudeResult);
    registerAiProvider('claude', mockClaude);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: 'sk-ant-test-valid-key',
      provider: 'claude',
    });

    expect(output.provider).toBe('claude');
    expect(output.fallback).toBe(false);
    expect(output.result.summary).toBe('A concise video guide.');
    expect(output.result.operations).toHaveLength(1);
    expect(output.result.operations[0].start).toBe(0);
    expect(output.result.operations[0].end).toBe(12);
  });

  // 3. Ollama invocation through boundary
  it('3. invokes Ollama provider through boundary when reachable and validated', async () => {
    const mockOllama = new OllamaProvider('http://127.0.0.1:11434', 'llama3');
    const validOllamaResult = {
      summary: 'Local Ollama summary',
      strategy: 'Balanced pacing',
      reasoning: 'Local model cut',
      highlights: [{ start: 0, end: 8, label: 'Local Highlight', score: 0.8 }],
      silences: [],
      speakers: [],
      captions: [{ start: 0, end: 5, text: 'Welcome to the tutorial' }],
      suggestedTitles: ['Ollama Title'],
      socialCopy: { instagram: 'Local IG', tiktok: 'Local TT', youtube: 'Local YT', linkedin: 'Local LI' },
      hook: { hook: { text: 'Local Hook', start: 0, end: 2 }, alternatives: [] },
      thumbnail: { bestFrameSec: 1, overlayText: 'Local Thumb', concept: 'Good face' },
      agentLog: [{ agent: 'local-director', summary: 'Local plan', ms: 50 }],
      operations: [{ index: 0, start: 0, end: 10, label: 'Local Keep', keep: true, zoom: 1 }],
      effects: { subtitles: false, zooms: false, transitions: 'none' as const, music: false },
      model: 'ollama:llama3',
    };

    vi.spyOn(mockOllama, 'analyzeTranscript').mockResolvedValue(validOllamaResult);
    registerAiProvider('ollama', mockOllama);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      provider: 'ollama',
    });

    expect(output.provider).toBe('ollama');
    expect(output.fallback).toBe(false);
    expect(output.result.summary).toBe('Local Ollama summary');
  });

  // 4. Deterministic fallback behavior
  it('4. provides deterministic fallback behavior within video duration', async () => {
    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [{ start: 12, end: 15 }],
      goal: 'Shorts highlight',
      provider: 'fallback',
    });

    expect(output.provider).toBe('fallback');
    expect(output.fallback).toBe(true);
    expect(output.reason).toContain('AI_PROVIDER=fallback');
    expect(output.result.summary).toContain('Welcome to the tutorial');
    expect(output.result.operations.length).toBeGreaterThan(0);

    for (const op of output.result.operations) {
      expect(op.start).toBeGreaterThanOrEqual(0);
      expect(op.end).toBeLessThanOrEqual(meta.durationSec);
      expect(op.start).toBeLessThan(op.end);
      expect(Number.isFinite(op.start)).toBe(true);
      expect(Number.isFinite(op.end)).toBe(true);
    }
  });

  // 5. Missing and invalid credentials
  it('5. triggers clean fallback for missing and invalid credentials without exposing secrets', async () => {
    // Missing credentials
    const missingKeyOutput = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: '',
      provider: 'claude',
    });

    expect(missingKeyOutput.fallback).toBe(true);
    expect(missingKeyOutput.reason).toContain('MISSING_CREDENTIALS');

    // Cached invalid credentials (401 simulation)
    markApiKeyInvalid('sk-ant-cached-invalid-key');
    expect(isApiKeyMarkedInvalid('sk-ant-cached-invalid-key')).toBe(true);

    const cachedInvalidOutput = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: 'sk-ant-cached-invalid-key',
      provider: 'claude',
    });

    expect(cachedInvalidOutput.fallback).toBe(true);
    expect(cachedInvalidOutput.reason).toContain('AUTHENTICATION');
  });

  // 6. Timeout and rate-limit handling
  it('6. classifies rate-limit and timeout errors properly and falls back gracefully', async () => {
    // Simulate rate-limit error (429)
    const rateLimitError = new Error('429 Too Many Requests: rate limit exceeded');
    (rateLimitError as any).status = 429;
    expect(classifyAiError(rateLimitError).category).toBe('RATE_LIMIT');

    // Simulate timeout error
    const timeoutError = new Error('The operation timed out after 30000ms');
    expect(classifyAiError(timeoutError).category).toBe('TIMEOUT');

    // Test fallback triggered by mock provider throwing rate limit
    const mockClaude = new ClaudeProvider();
    vi.spyOn(mockClaude, 'analyzeTranscript').mockRejectedValue(rateLimitError);
    registerAiProvider('claude', mockClaude);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: 'sk-ant-test-key-1234567890abcdef',
      provider: 'claude',
    });

    expect(output.fallback).toBe(true);
    expect(output.reason).toContain('RATE_LIMIT');
    // Ensure API key is sanitized in reason
    expect(output.reason).not.toContain('sk-ant-test-key-1234567890abcdef');
    expect(output.result).toBeDefined();
  });

  // 7. Malformed AI responses
  it('7. catches malformed AI responses via Zod validation and safely falls back', async () => {
    const mockClaude = new ClaudeProvider();
    // Returning an object missing required fields (e.g. missing operations and highlights)
    const malformedResult = {
      summary: 'Broken output without operations',
      captions: [],
    } as any;

    vi.spyOn(mockClaude, 'analyzeTranscript').mockResolvedValue(malformedResult);
    registerAiProvider('claude', mockClaude);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: 'sk-ant-test-key',
      provider: 'claude',
    });

    expect(output.fallback).toBe(true);
    expect(output.reason).toContain('MALFORMED_RESPONSE');
    expect(output.result.operations.length).toBeGreaterThan(0);
  });

  // 8. Invalid timeline operations
  it('8. rejects invalid timeline operations (negative, inverted, or exceeding duration)', () => {
    const validator = createPipelineResultValidator(30, true);

    const baseValid = {
      summary: 'Valid summary',
      strategy: 'Strategy',
      reasoning: 'Reason',
      highlights: [{ start: 0, end: 5, label: 'H1', score: 0.9 }],
      silences: [],
      speakers: [],
      captions: [{ start: 0, end: 5, text: 'Hello' }],
      suggestedTitles: ['Title'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      hook: { hook: { text: 'hook', start: 0, end: 2 }, alternatives: [] },
      thumbnail: { bestFrameSec: 1, overlayText: 'thumb', concept: 'reason' },
      agentLog: [],
      effects: { subtitles: true, zooms: true, transitions: 'fade' as const, music: false },
      model: 'test',
    };

    // Negative start time
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: -2, end: 10, keep: true }],
      }),
    ).toThrow();

    // Inverted start/end (start >= end)
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: 15, end: 10, keep: true }],
      }),
    ).toThrow();

    // End exceeding duration (35 > 30)
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: 0, end: 35, keep: true }],
      }),
    ).toThrow();

    // Non-finite NaN timestamp
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: NaN, end: 10, keep: true }],
      }),
    ).toThrow();
  });

  // 9. Preservation of valid output
  it('9. preserves valid timeline operations, highlights, and metadata without corruption', () => {
    const validator = createPipelineResultValidator(60, true);
    const validData = {
      summary: 'Complete valid pipeline output',
      strategy: 'Fast paced with clear cut points',
      reasoning: 'Detailed cut',
      highlights: [
        { start: 0, end: 15, label: 'Key takeaway', score: 0.92 },
        { start: 20, end: 45, label: 'Demonstration', score: 0.88 },
      ],
      silences: [],
      speakers: [{ id: 'spk_1', label: 'Presenter', segments: [{ start: 0, end: 45 }] }],
      captions: [
        { start: 0, end: 5, text: 'Welcome everyone.' },
        { start: 20, end: 25, text: 'Here is the demonstration.' },
      ],
      suggestedTitles: ['Tutorial Walkthrough', 'Step by Step Demo'],
      socialCopy: { instagram: 'Check this out!', tiktok: 'Quick tip', youtube: 'Full guide', linkedin: 'Pro insights' },
      hook: { hook: { text: 'Want to save hours?', start: 0, end: 3 }, alternatives: ['Pro tips'] },
      thumbnail: { bestFrameSec: 22, overlayText: 'Save Hours', concept: 'High action' },
      agentLog: [
        { agent: 'hook', summary: 'Selected intro hook', ms: 40 },
        { agent: 'director', summary: 'Constructed 2 segments', ms: 110 },
      ],
      operations: [
        { index: 0, start: 0, end: 15, label: 'Hook + Takeaway', keep: true, zoom: 1.08 },
        { index: 1, start: 20, end: 45, label: 'Demo', keep: true, zoom: 1.0 },
      ],
      effects: { subtitles: true, zooms: true, transitions: 'fade' as const, music: true },
      model: 'claude-3-7-sonnet',
    };

    const parsed = validator.parse(validData);
    expect(parsed.summary).toBe(validData.summary);
    expect(parsed.operations).toHaveLength(2);
    expect(parsed.operations[0].start).toBe(0);
    expect(parsed.operations[0].end).toBe(15);
    expect(parsed.operations[1].start).toBe(20);
    expect(parsed.operations[1].end).toBe(45);
    expect(parsed.hook.hook.text).toBe('Want to save hours?');
    expect(parsed.thumbnail.bestFrameSec).toBe(22);
  });

  // 10. Whisper unavailable / degraded mode
  it('10. handles Whisper sidecar unavailable with transcription provider interface', async () => {
    class FailingWhisperProvider implements TranscriptionProvider {
      readonly name = 'failing-whisper';
      async transcribe(): Promise<never> {
        throw new Error('Whisper container unreachable (ECONNREFUSED)');
      }
      async checkHealth(): Promise<boolean> {
        return false;
      }
    }

    setTranscriptionProvider(new FailingWhisperProvider());
    expect(getTranscriptionProvider().name).toBe('failing-whisper');
    expect(await transcriberHealthy()).toBe(false);

    await expect(transcribeRich('dummy.wav', undefined, { retries: 1 })).rejects.toThrow(
      /Whisper container unreachable/,
    );
  });

  // 11. No fabricated transcript or captions when transcript is empty
  it('11. enforces no fabricated captions when transcript is empty in degraded mode', async () => {
    // When hasTranscript is false, validator strictly rejects any captions
    const validatorNoTranscript = createPipelineResultValidator(30, false);

    const resultWithFabricatedCaptions = {
      summary: 'Silent or un-transcribed video',
      strategy: 'Strategy',
      reasoning: 'Reasoning',
      highlights: [{ start: 0, end: 10, label: 'Segment 1', score: 0.7 }],
      silences: [],
      speakers: [],
      captions: [{ start: 0, end: 5, text: 'Invented phantom dialogue' }],
      suggestedTitles: ['Silent Video'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      hook: { hook: { text: 'Hook', start: 0, end: 2 }, alternatives: [] },
      thumbnail: { bestFrameSec: 1, overlayText: 'H', concept: 'R' },
      agentLog: [],
      operations: [{ index: 0, start: 0, end: 30, keep: true }],
      effects: { subtitles: false, zooms: false, transitions: 'none' as const, music: false },
      model: 'test',
    };

    expect(() => validatorNoTranscript.parse(resultWithFabricatedCaptions)).toThrow(
      /invented transcript or captions are not permitted/,
    );

    // Fallback provider running on empty transcript must return 0 captions
    const fallbackEmptyOutput = await runAiProvider({
      meta,
      transcript: [],
      silences: [],
      provider: 'fallback',
    });

    expect(fallbackEmptyOutput.result.captions).toHaveLength(0);
  });

  // 12. No accidental paid API calls in tests
  it('12. ensures test execution never accidentally calls paid Claude API without credentials', async () => {
    // With AI_PROVIDER=fallback or missing credentials, Claude client is never called
    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      provider: 'fallback',
    });

    expect(output.provider).toBe('fallback');
    expect(output.fallback).toBe(true);

    // Secret sanitization guarantees
    const rawSecret = 'sk-ant-api03-abcdef1234567890abcdef1234567890';
    const sanitized = sanitizeLogSecret(`Failed request with authorization ${rawSecret} in header`);
    expect(sanitized).not.toContain(rawSecret);
    expect(sanitized).toContain('sk-ant-***');
  });
});
