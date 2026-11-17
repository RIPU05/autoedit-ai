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
  validatePipelineResult,
  classifyAiError,
  AiProviderError,
  sanitizeLogSecret,
  markApiKeyInvalid,
  resetInvalidApiKeyCache,
  isApiKeyMarkedInvalid,
  isNetworkError,
  isTimeoutError,
  FP_TOLERANCE_SEC,
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

describe('AI Provider Boundaries, Safety & Validation (Step 3B.3.1)', () => {
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

  // 1. Unknown provider name produces configuration error (Fail-Closed)
  it('1. rejects unknown or misspelled provider names without silent fallback or network calls', async () => {
    // resolveAiProvider must throw configuration error
    expect(() => resolveAiProvider('claudee')).toThrow(AiProviderError);
    expect(() => resolveAiProvider('claudee')).toThrow(/Unknown or unsupported AI provider: "claudee"/);

    try {
      resolveAiProvider('deepseek-r1');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).category).toBe('INVALID_CONFIGURATION');
      expect((err as AiProviderError).isFallbackEligible).toBe(false);
    }

    // runAiProvider must fail closed and rethrow immediately
    await expect(
      runAiProvider({
        meta,
        transcript: sampleTranscript,
        silences: [],
        provider: 'non-existent-ai' as any,
      }),
    ).rejects.toThrow(/Unknown or unsupported AI provider/);
  });

  // 2. Explicit fallback selection
  it('2. continues to support explicit AI_PROVIDER=fallback selection', async () => {
    expect(resolveAiProvider('fallback')).toBeInstanceOf(FallbackProvider);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [{ start: 12, end: 15 }],
      provider: 'fallback',
    });

    expect(output.provider).toBe('fallback');
    expect(output.fallback).toBe(true);
    expect(output.reason).toBe('AI_PROVIDER=fallback');
    expect(output.result.operations.length).toBeGreaterThan(0);
  });

  // 3. Registered custom provider
  it('3. allows custom provider registration and invocation', async () => {
    const customProvider = {
      name: 'custom-sidecar' as any,
      analyzeTranscript: vi.fn().mockResolvedValue({
        summary: 'Custom sidecar summary',
        strategy: 'Custom strategy',
        reasoning: 'Custom cut',
        highlights: [{ start: 0, end: 10, label: 'Custom', score: 0.9 }],
        silences: [],
        speakers: [{ id: 'spk_1', label: 'Speaker 1', segments: [{ start: 0, end: 10 }] }],
        captions: [{ start: 0, end: 5, text: 'Custom caption' }],
        suggestedTitles: ['Custom Title'],
        socialCopy: { instagram: 'IG', tiktok: 'TT', youtube: 'YT', linkedin: 'LI' },
        hook: { hook: { text: 'Custom hook', start: 0, end: 3 }, alternatives: [] },
        thumbnail: { bestFrameSec: 2, overlayText: 'Custom', concept: 'Clear' },
        agentLog: [{ agent: 'custom', summary: 'Ran custom', ms: 10 }],
        operations: [{ index: 0, start: 0, end: 10, label: 'Keep 1', keep: true, zoom: 1 }],
        effects: { subtitles: true, zooms: false, transitions: 'none' as const, music: false },
        model: 'custom:v1',
      }),
      generateTimeline: vi.fn(),
      generateTitles: vi.fn(),
      generateCaptions: vi.fn(),
      generateSocialCopy: vi.fn(),
    };

    registerAiProvider('custom-sidecar', customProvider);
    expect(resolveAiProvider('custom-sidecar')).toBe(customProvider);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      provider: 'custom-sidecar',
    });

    expect(output.provider).toBe('custom-sidecar');
    expect(output.fallback).toBe(false);
    expect(output.result.summary).toBe('Custom sidecar summary');
  });

  // 4. Genuine TypeError and ReferenceError (never silently suppressed)
  it('4. classifies genuine programming errors as PROGRAMMING_ERROR and rethrows without fallback', async () => {
    // Genuine programming TypeError
    const typeError = new TypeError("Cannot read properties of undefined (reading 'split')");
    const classifiedTypeError = classifyAiError(typeError);
    expect(classifiedTypeError.category).toBe('PROGRAMMING_ERROR');
    expect(classifiedTypeError.isFallbackEligible).toBe(false);

    // Genuine ReferenceError
    const refError = new ReferenceError('uninitializedVariable is not defined');
    const classifiedRefError = classifyAiError(refError);
    expect(classifiedRefError.category).toBe('PROGRAMMING_ERROR');
    expect(classifiedRefError.isFallbackEligible).toBe(false);

    // Mock Claude provider throwing genuine TypeError
    const mockClaude = new ClaudeProvider();
    vi.spyOn(mockClaude, 'analyzeTranscript').mockRejectedValue(typeError);
    registerAiProvider('claude', mockClaude);

    // runAiProvider MUST rethrow and NOT convert to fallback
    await expect(
      runAiProvider({
        meta,
        transcript: sampleTranscript,
        silences: [],
        claudeApiKey: 'sk-ant-valid-key',
        provider: 'claude',
      }),
    ).rejects.toThrow("Cannot read properties of undefined (reading 'split')");
  });

  // 5. Network-related TypeError (differentiated and properly classified as connection failure)
  it('5. distinguishes network-related TypeError from programming TypeError and falls back gracefully', async () => {
    // Node.js native fetch failure is a TypeError with code in cause
    const fetchTypeError = new TypeError('fetch failed');
    (fetchTypeError as any).cause = { code: 'ECONNREFUSED' };

    expect(isNetworkError(fetchTypeError)).toBe(true);
    const classified = classifyAiError(fetchTypeError);
    expect(classified.category).toBe('CONNECTION');
    expect(classified.isFallbackEligible).toBe(true);

    // Mock Claude throwing fetch error
    const mockClaude = new ClaudeProvider();
    vi.spyOn(mockClaude, 'analyzeTranscript').mockRejectedValue(fetchTypeError);
    registerAiProvider('claude', mockClaude);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: 'sk-ant-valid-key',
      provider: 'claude',
    });

    expect(output.fallback).toBe(true);
    expect(output.category).toBe('CONNECTION');
    expect(output.reason).toContain('CONNECTION');
  });

  // 6. 401 authentication error
  it('6. classifies 401 error, marks key invalid, and falls back', async () => {
    const authError = new Error('401 unauthorized: invalid x-api-key');
    (authError as any).status = 401;

    const classified = classifyAiError(authError);
    expect(classified.category).toBe('AUTHENTICATION');
    expect(classified.isFallbackEligible).toBe(true);

    const mockClaude = new ClaudeProvider();
    vi.spyOn(mockClaude, 'analyzeTranscript').mockRejectedValue(authError);
    registerAiProvider('claude', mockClaude);

    const testKey = 'sk-ant-failing-test-key-12345';
    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: testKey,
      provider: 'claude',
    });

    expect(output.fallback).toBe(true);
    expect(output.category).toBe('AUTHENTICATION');
    expect(isApiKeyMarkedInvalid(testKey)).toBe(true);
  });

  // 7. 429 rate limit
  it('7. classifies 429 rate limit error and falls back with sanitized reason', async () => {
    const rateLimitError = new Error('rate_limit_error: token limit reached');
    (rateLimitError as any).status = 429;

    const classified = classifyAiError(rateLimitError);
    expect(classified.category).toBe('RATE_LIMIT');
    expect(classified.isFallbackEligible).toBe(true);

    const mockClaude = new ClaudeProvider();
    vi.spyOn(mockClaude, 'analyzeTranscript').mockRejectedValue(rateLimitError);
    registerAiProvider('claude', mockClaude);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: 'sk-ant-secret-key-987654321',
      provider: 'claude',
    });

    expect(output.fallback).toBe(true);
    expect(output.category).toBe('RATE_LIMIT');
    expect(output.reason).not.toContain('sk-ant-secret-key-987654321');
  });

  // 8. Timeout handling
  it('8. classifies timeout errors properly and falls back', async () => {
    const timeoutErr = new Error('ETIMEDOUT: Connection timed out');
    (timeoutErr as any).code = 'ETIMEDOUT';

    expect(isTimeoutError(timeoutErr)).toBe(true);
    const classified = classifyAiError(timeoutErr);
    expect(classified.category).toBe('TIMEOUT');
    expect(classified.isFallbackEligible).toBe(true);
  });

  // 9. Malformed JSON and model response
  it('9. catches malformed JSON parse error and falls back', async () => {
    const syntaxErr = new SyntaxError('Unexpected token < in JSON at position 0');
    const classified = classifyAiError(syntaxErr);
    expect(classified.category).toBe('MALFORMED_RESPONSE');
    expect(classified.isFallbackEligible).toBe(true);

    const mockClaude = new ClaudeProvider();
    vi.spyOn(mockClaude, 'analyzeTranscript').mockRejectedValue(syntaxErr);
    registerAiProvider('claude', mockClaude);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [],
      claudeApiKey: 'sk-ant-key',
      provider: 'claude',
    });

    expect(output.fallback).toBe(true);
    expect(output.category).toBe('MALFORMED_RESPONSE');
  });

  // 10. Out-of-bounds operations (negative, inverted, exceeding duration + tolerance)
  it('10. rejects out-of-bounds timeline operations (rejects beyond FP tolerance)', () => {
    const validator = createPipelineResultValidator(30, true);

    const baseValid = {
      summary: 'Summary',
      strategy: 'Strategy',
      reasoning: 'Reason',
      highlights: [{ start: 0, end: 5, label: 'H1', score: 0.9 }],
      silences: [],
      speakers: [{ id: 'spk_1', label: 'Speaker 1', segments: [{ start: 0, end: 5 }] }],
      captions: [{ start: 0, end: 5, text: 'Hello' }],
      suggestedTitles: ['Title'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      hook: { hook: { text: 'hook', start: 0, end: 2 }, alternatives: [] },
      thumbnail: { bestFrameSec: 1, overlayText: 'thumb', concept: 'reason' },
      agentLog: [],
      effects: { subtitles: true, zooms: true, transitions: 'fade' as const, music: false },
      model: 'test',
    };

    // Operation ending at 30.04 (within 50ms tolerance) passes
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: 0, end: 30.04, keep: true }],
      }),
    ).not.toThrow();

    // Operation ending at 30.1 (exceeds 50ms tolerance for 30s video) fails
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: 0, end: 30.1, keep: true }],
      }),
    ).toThrow(/operation end exceeds video duration/);

    // Negative start time
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: -0.5, end: 10, keep: true }],
      }),
    ).toThrow();

    // Inverted start/end
    expect(() =>
      validator.parse({
        ...baseValid,
        operations: [{ index: 0, start: 15, end: 10, keep: true }],
      }),
    ).toThrow(/strictly greater than start/);
  });

  // 11. Out-of-bounds highlight and caption timestamps
  it('11. rejects highlights and captions with out-of-bounds or inverted timestamps', () => {
    const validator = createPipelineResultValidator(30, true);

    const baseValid = {
      summary: 'Summary',
      strategy: 'Strategy',
      reasoning: 'Reason',
      silences: [],
      speakers: [],
      suggestedTitles: ['Title'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      hook: { hook: { text: 'hook', start: 0, end: 2 }, alternatives: [] },
      thumbnail: { bestFrameSec: 1, overlayText: 'thumb', concept: 'reason' },
      agentLog: [],
      operations: [{ index: 0, start: 0, end: 20, keep: true }],
      effects: { subtitles: true, zooms: true, transitions: 'none' as const, music: false },
      model: 'test',
    };

    // Highlight exceeding duration
    expect(() =>
      validator.parse({
        ...baseValid,
        highlights: [{ start: 0, end: 32, label: 'Too long', score: 0.8 }],
        captions: [{ start: 0, end: 5, text: 'Hi' }],
      }),
    ).toThrow(/highlight end exceeds video duration/);

    // Inverted highlight
    expect(() =>
      validator.parse({
        ...baseValid,
        highlights: [{ start: 10, end: 5, label: 'Inverted', score: 0.8 }],
        captions: [{ start: 0, end: 5, text: 'Hi' }],
      }),
    ).toThrow(/strictly greater than start/);

    // Caption exceeding duration
    expect(() =>
      validator.parse({
        ...baseValid,
        highlights: [{ start: 0, end: 5, label: 'H', score: 0.8 }],
        captions: [{ start: 0, end: 35, text: 'Out of bounds caption' }],
      }),
    ).toThrow(/caption end exceeds video duration/);
  });

  // 12. Invalid speaker and hook ranges
  it('12. rejects out-of-bounds speaker segments and hook ranges', () => {
    const validator = createPipelineResultValidator(30, true);

    const baseValid = {
      summary: 'Summary',
      strategy: 'Strategy',
      reasoning: 'Reason',
      highlights: [{ start: 0, end: 5, label: 'H', score: 0.8 }],
      silences: [],
      captions: [{ start: 0, end: 5, text: 'Hi' }],
      suggestedTitles: ['Title'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      thumbnail: { bestFrameSec: 1, overlayText: 'thumb', concept: 'reason' },
      agentLog: [],
      operations: [{ index: 0, start: 0, end: 20, keep: true }],
      effects: { subtitles: true, zooms: true, transitions: 'none' as const, music: false },
      model: 'test',
    };

    // Speaker segment exceeding duration
    expect(() =>
      validator.parse({
        ...baseValid,
        speakers: [{ id: 'spk_1', label: 'Spk', segments: [{ start: 0, end: 40 }] }],
        hook: { hook: { text: 'hook', start: 0, end: 2 }, alternatives: [] },
      }),
    ).toThrow(/speaker segment end exceeds video duration/);

    // Hook inverted
    expect(() =>
      validator.parse({
        ...baseValid,
        speakers: [{ id: 'spk_1', label: 'Spk', segments: [{ start: 0, end: 10 }] }],
        hook: { hook: { text: 'hook', start: 5, end: 2 }, alternatives: [] },
      }),
    ).toThrow(/hook end must be strictly greater than start/);
  });

  // 13. Invalid thumbnail frame position
  it('13. rejects thumbnail positions that exceed video duration or are negative', () => {
    const validator = createPipelineResultValidator(30, true);

    const baseValid = {
      summary: 'Summary',
      strategy: 'Strategy',
      reasoning: 'Reason',
      highlights: [{ start: 0, end: 5, label: 'H', score: 0.8 }],
      silences: [],
      speakers: [],
      captions: [{ start: 0, end: 5, text: 'Hi' }],
      suggestedTitles: ['Title'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      hook: { hook: { text: 'hook', start: 0, end: 2 }, alternatives: [] },
      agentLog: [],
      operations: [{ index: 0, start: 0, end: 20, keep: true }],
      effects: { subtitles: true, zooms: true, transitions: 'none' as const, music: false },
      model: 'test',
    };

    // Thumbnail position beyond video duration
    expect(() =>
      validator.parse({
        ...baseValid,
        thumbnail: { bestFrameSec: 45, overlayText: 'thumb', concept: 'reason' },
      }),
    ).toThrow(/thumbnail frame position exceeds video duration/);

    // Negative thumbnail position
    expect(() =>
      validator.parse({
        ...baseValid,
        thumbnail: { bestFrameSec: -2, overlayText: 'thumb', concept: 'reason' },
      }),
    ).toThrow();
  });

  // 14. No fabricated captions when transcript is unavailable
  it('14. strictly prohibits fabricated captions when media has no transcript', () => {
    const validatorNoTranscript = createPipelineResultValidator(30, false);

    const fabricatedResult = {
      summary: 'Silent video',
      strategy: 'Strategy',
      reasoning: 'Reason',
      highlights: [{ start: 0, end: 5, label: 'H', score: 0.8 }],
      silences: [],
      speakers: [],
      captions: [{ start: 0, end: 5, text: 'Invented phantom dialogue' }],
      suggestedTitles: ['Title'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      hook: { hook: { text: 'hook', start: 0, end: 2 }, alternatives: [] },
      thumbnail: { bestFrameSec: 1, overlayText: 'thumb', concept: 'reason' },
      agentLog: [],
      operations: [{ index: 0, start: 0, end: 20, keep: true }],
      effects: { subtitles: false, zooms: false, transitions: 'none' as const, music: false },
      model: 'test',
    };

    expect(() => validatorNoTranscript.parse(fabricatedResult)).toThrow(
      /invented transcript or captions are not permitted/,
    );
  });

  // 15. Valid results preserving metadata
  it('15. preserves valid timeline operations, highlights, and custom metadata without stripping', () => {
    const validator = createPipelineResultValidator(60, true);
    const validData = {
      summary: 'Valid summary',
      strategy: 'Strategy',
      reasoning: 'Reason',
      highlights: [{ start: 0, end: 15, label: 'H1', score: 0.9, customHighlightTag: 'tag1' }],
      silences: [],
      speakers: [{ id: 'spk_1', label: 'Presenter', segments: [{ start: 0, end: 45 }] }],
      captions: [{ start: 0, end: 5, text: 'Hello', confidence: 0.95 }],
      suggestedTitles: ['Title 1', 'Title 2'],
      socialCopy: { instagram: 'a', tiktok: 'b', youtube: 'c', linkedin: 'd' },
      hook: { hook: { text: 'hook', start: 0, end: 3 }, alternatives: ['alt1'] },
      thumbnail: { bestFrameSec: 5, overlayText: 'thumb', concept: 'clear' },
      agentLog: [{ agent: 'test', ms: 50, summary: 'done' }],
      operations: [
        { index: 0, start: 0, end: 15, label: 'Clip 1', keep: true, zoom: 1.08, speedMultiplier: 1.2 },
        { index: 1, start: 20, end: 45, label: 'Clip 2', keep: true, zoom: 1.0 },
      ],
      effects: {
        subtitles: true,
        zooms: true,
        transitions: 'fade' as const,
        music: true,
        metadata: { customEffectPreset: 'cinematic' },
      },
      model: 'claude-3-7-sonnet',
      extraTopLevelProperty: 'preserved',
    };

    const parsed = validator.parse(validData) as any;
    expect(parsed.operations[0].speedMultiplier).toBe(1.2);
    expect(parsed.effects.metadata.customEffectPreset).toBe('cinematic');
    expect(parsed.extraTopLevelProperty).toBe('preserved');
  });

  // 16. Validation of emergency fallback results
  it('16. validates emergency fallback results generated after external provider failure', async () => {
    const mockClaude = new ClaudeProvider();
    vi.spyOn(mockClaude, 'analyzeTranscript').mockRejectedValue(new Error('Connection error (503)'));
    registerAiProvider('claude', mockClaude);

    const output = await runAiProvider({
      meta,
      transcript: sampleTranscript,
      silences: [{ start: 15, end: 20 }],
      claudeApiKey: 'sk-ant-test-key',
      provider: 'claude',
    });

    expect(output.fallback).toBe(true);
    expect(output.category).toBe('CONNECTION');
    // Ensure the fallback result itself passed validation and is fully well-formed
    expect(output.result.operations.length).toBeGreaterThan(0);
    for (const op of output.result.operations) {
      expect(op.start).toBeGreaterThanOrEqual(0);
      expect(op.end).toBeLessThanOrEqual(meta.durationSec + FP_TOLERANCE_SEC);
      expect(op.end).toBeGreaterThan(op.start);
    }
  });

  // 17. Invalid fallback output failing safely without infinite loop
  it('17. fails closed if fallback output itself fails validation', () => {
    const corruptedFallbackResult = {
      summary: 'Corrupted fallback',
      strategy: 'Strategy',
      reasoning: 'Reason',
      highlights: [],
      speakers: [],
      captions: [],
      suggestedTitles: ['Title'],
      socialCopy: { instagram: '', tiktok: '', youtube: '', linkedin: '' },
      hook: { hook: { text: 'hook', start: 0, end: 2 }, alternatives: [] },
      thumbnail: { bestFrameSec: 0, overlayText: '', concept: '' },
      agentLog: [],
      operations: [{ index: 0, start: 10, end: 5, keep: true }], // Invalid inverted operation!
      effects: { subtitles: false, zooms: false, transitions: 'none' as const, music: false },
      model: 'fallback',
    };

    try {
      validatePipelineResult(corruptedFallbackResult, 30, false, 'fallback');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).isFallbackEligible).toBe(false); // Must not attempt further fallback!
      expect((err as AiProviderError).category).toBe('INVALID_OPERATION');
    }
  });
});
