import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { db, prismaMock, resetDb } from '../test-state.js';

const { mockAnthropicCreate, MockAuthenticationError } = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn();
  class MockAuthenticationError extends Error {
    status = 401;
    name = 'AuthenticationError';
    constructor(status = 401, _error = {}, message = 'invalid x-api-key') {
      super(message);
    }
  }
  return { mockAnthropicCreate, MockAuthenticationError };
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: mockAnthropicCreate,
      };
      static AuthenticationError = MockAuthenticationError;
    },
  };
});

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: prismaMock,
}));

import { runAiProvider } from '../../src/ai/providers.js';
import {
  editTimelineWithPrompt,
  explainClip,
  regenerateSocialCopy,
  resetInvalidApiKeyCache,
  isApiKeyMarkedInvalid,
} from '../../src/services/claude.service.js';
import { createVersion, getHeadVersion } from '../../src/services/version.service.js';
import { type EditPlan } from '../../src/ffmpeg/pipeline.js';

describe('AI Fallback Pipeline & Version History Integration (Step 2C)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
    resetInvalidApiKeyCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('8. Claude HTTP 401 fails over to fallback pipeline without crashing', async () => {
    mockAnthropicCreate.mockRejectedValueOnce(
      new MockAuthenticationError(401, {}, '401 invalid x-api-key'),
    );

    process.env.AI_PROVIDER = 'claude';
    process.env.ANTHROPIC_API_KEY = 'invalid-test-key-401';

    const output = await runAiProvider({
      meta: { durationSec: 45, width: 1920, height: 1080, fps: 30 },
      transcript: [{ start: 0, end: 10, text: 'Sample speech transcript' }],
      silences: [{ start: 10, end: 15 }],
      claudeApiKey: 'invalid-test-key-401',
    });

    // Should gracefully fail over to fallback
    expect(output.fallback).toBe(true);
    expect(output.provider).toBe('fallback');
    expect(output.reason).toContain('Claude unavailable');
    expect(output.result.operations.length).toBeGreaterThan(0);
    expect(output.result.model).toBe('fallback');
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);

    // Verify the invalid key was marked to prevent repeated failed requests
    expect(isApiKeyMarkedInvalid('invalid-test-key-401')).toBe(true);
  });

  it('8b. Claude HTTP 401 on prompt edit falls over to deterministic editing', async () => {
    mockAnthropicCreate.mockRejectedValueOnce(
      new MockAuthenticationError(401, {}, '401 invalid x-api-key'),
    );

    process.env.AI_PROVIDER = 'claude';

    const result = await editTimelineWithPrompt({
      instruction: 'remove all silences',
      durationSec: 40,
      summary: 'Test summary',
      highlights: [],
      silences: [{ start: 5, end: 8 }],
      captions: [{ start: 0, end: 5, text: 'Hello' }],
      currentOps: [{ index: 0, start: 0, end: 40, keep: true, zoom: 1 }],
      currentEffects: { subtitles: true, zooms: false, transitions: 'none', music: false },
      claudeApiKey: 'bad-key-401',
    });

    expect(result.versionName).toBe('Silence cut');
    expect(result.changes[0].action).toBe('trimmed');
    expect(result.operations.length).toBe(2);
    expect(isApiKeyMarkedInvalid('bad-key-401')).toBe(true);
  });

  it('9 & 12. Never calls paid Anthropic API when AI_PROVIDER=fallback', async () => {
    process.env.AI_PROVIDER = 'fallback';

    // 1. runAiProvider
    const analysis = await runAiProvider({
      meta: { durationSec: 30, width: 1920, height: 1080, fps: 30 },
      transcript: [{ start: 0, end: 10, text: 'Speaking here' }],
      silences: [{ start: 10, end: 12 }],
    });
    expect(analysis.fallback).toBe(true);
    expect(analysis.provider).toBe('fallback');

    // 2. editTimelineWithPrompt
    const edit = await editTimelineWithPrompt({
      instruction: 'trim first 3 seconds',
      durationSec: 30,
      highlights: [],
      silences: [],
      captions: [],
      currentOps: [{ index: 0, start: 0, end: 30, keep: true }],
      currentEffects: { subtitles: false, zooms: false, transitions: 'none', music: false },
    });
    expect(edit.versionName).toBe('Trimmed start (-3s)');

    // 3. explainClip
    const explanation = await explainClip({
      start: 0,
      end: 3,
      kept: false,
      silences: [],
      highlights: [],
      captions: [],
    });
    expect(explanation.explanation).toBeDefined();

    // 4. regenerateSocialCopy
    const copy = await regenerateSocialCopy('Test summary', 'viral');
    expect(copy.tiktok).toBeDefined();

    // Verify Anthropic was never called
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(0);
  });

  it('13. Preserves non-destructive edit version history across multiple edits', async () => {
    const testProjectId = 'proj_version_history_test';

    // 1. Initial Root Version
    const root = await createVersion({
      projectId: testProjectId,
      name: 'Original AI cut',
      timeline: {
        operations: [{ index: 0, start: 0, end: 60, keep: true, zoom: 1 }],
        effects: { subtitles: true, zooms: false, transitions: 'none', music: false },
      },
      aiExplanation: 'Root cut from analysis',
      parentVersionId: null,
    });
    expect(root.id).toBeDefined();
    expect(root.parentVersionId).toBeNull();

    // 2. First Edit Version
    const edit1 = await createVersion({
      projectId: testProjectId,
      name: 'Silence cut',
      timeline: {
        operations: [
          { index: 0, start: 0, end: 20, keep: true, zoom: 1 },
          { index: 1, start: 25, end: 60, keep: true, zoom: 1 },
        ],
        effects: { subtitles: true, zooms: false, transitions: 'none', music: false },
      },
      userPrompt: 'remove silences',
      aiExplanation: 'Removed silence at 20-25s',
      changes: [{ action: 'trimmed', target: 'silences', reasons: ['Removed 5s pause'] }],
    });
    expect(edit1.parentVersionId).toBe(root.id);

    // 3. Second Edit Version
    const edit2 = await createVersion({
      projectId: testProjectId,
      name: 'Vertical cut (9:16)',
      timeline: {
        operations: edit1.timelineJson ? (edit1.timelineJson as any).operations : [],
        effects: { subtitles: true, zooms: true, transitions: 'fade', music: false },
      },
      userPrompt: 'make it vertical',
      aiExplanation: 'Adjusted aspect ratio to 9:16',
      changes: [{ action: 'effect', target: 'aspect ratio', reasons: ['Switched to vertical'] }],
    });
    expect(edit2.parentVersionId).toBe(edit1.id);

    // 4. Verify Head Version
    const head = await getHeadVersion(testProjectId);
    expect(head?.id).toBe(edit2.id);

    // 5. Verify all versions still exist in DB (non-destructive)
    const allVersions = db.versions.filter((v) => v.projectId === testProjectId);
    expect(allVersions).toHaveLength(3);
    expect(allVersions[0].name).toBe('Original AI cut');
    expect(allVersions[1].name).toBe('Silence cut');
    expect(allVersions[2].name).toBe('Vertical cut (9:16)');
    expect(allVersions[1].parentVersionId).toBe(allVersions[0].id);
    expect(allVersions[2].parentVersionId).toBe(allVersions[1].id);
  });

  it('14. Ensures timeline schema is fully compatible with renderer pipeline', async () => {
    // Generate deterministic edit in fallback mode
    process.env.AI_PROVIDER = 'fallback';

    const result = await editTimelineWithPrompt({
      instruction: 'enable crossfade transitions',
      durationSec: 50,
      highlights: [],
      silences: [],
      captions: [{ start: 0, end: 10, text: 'Subtitle text' }],
      currentOps: [
        { index: 0, start: 0, end: 20, keep: true, zoom: 1.12 },
        { index: 1, start: 20, end: 50, keep: true, zoom: 1.12 },
      ],
      currentEffects: { subtitles: true, zooms: true, transitions: 'none', music: false },
    });

    expect(result.effects.zooms).toBe(true);

    // Verify that operations can be transformed into renderer KeepSegment list
    const keep = result.operations
      .filter((op) => op.keep !== false)
      .map((op) => ({
        start: op.start,
        end: op.end,
        zoom: result.effects.zooms ? op.zoom ?? 1.08 : 1,
      }));

    expect(keep).toHaveLength(2);
    expect(keep[0].start).toBe(0);
    expect(keep[0].end).toBe(20);
    expect(keep[0].zoom).toBeGreaterThanOrEqual(1.08);

    // Verify EditPlan structure matches renderer
    const plan: EditPlan = {
      source: 'dummy-source.mp4',
      keep,
      captions: [{ start: 0, end: 10, text: 'Subtitle text' }],
      transition: result.effects.transitions === 'fade' ? 'fade' : 'none',
      format: 'reel',
    };

    expect(plan.keep.length).toBe(2);
    expect(plan.format).toBe('reel');
    expect(plan.transition).toBe('fade');
  });
});
