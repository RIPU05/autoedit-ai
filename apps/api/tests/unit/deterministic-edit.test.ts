import { describe, expect, it } from 'vitest';
import {
  applyDeterministicPromptEdit,
  validateTimeline,
  UnsupportedPromptError,
  explainClipDeterministic,
  generateDeterministicSocialCopy,
  type PromptEditInput,
} from '../../src/services/deterministic-edit.service.js';

describe('Deterministic Prompt Editing (Step 2C)', () => {
  const baseInput: PromptEditInput = {
    instruction: '',
    durationSec: 60,
    summary: 'A test podcast about AI video editing.',
    highlights: [{ start: 5, end: 25, label: 'Intro highlight', score: 0.9 }],
    silences: [
      { start: 10, end: 12 },
      { start: 30, end: 34 },
    ],
    captions: [
      { start: 0, end: 5, text: 'Welcome to AutoAI Edit.' },
      { start: 12, end: 20, text: 'This is a demo of reliable transcription.' },
    ],
    currentOps: [
      { index: 0, start: 0, end: 30, label: 'Part 1', keep: true, zoom: 1 },
      { index: 1, start: 30, end: 60, label: 'Part 2', keep: true, zoom: 1 },
    ],
    currentEffects: {
      subtitles: true,
      zooms: false,
      transitions: 'none',
      music: false,
    },
  };

  it('10a. "remove silence" cuts detected silence spans from the timeline', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'remove all silences to tighten pacing',
    });

    expect(result.versionName).toBe('Silence cut');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].action).toBe('trimmed');
    expect(result.changes[0].target).toBe('silences');
    expect(result.operations.length).toBeGreaterThan(baseInput.currentOps.length);

    // Verify silences [10, 12] and [30, 34] were cut out
    for (const op of result.operations) {
      // No operation should span through [10, 12]
      expect(op.start >= 12 || op.end <= 10).toBe(true);
      // No operation should span through [30, 34]
      expect(op.start >= 34 || op.end <= 30).toBe(true);
    }
  });

  it('10b. "remove silence" fails safely if no silences were detected', () => {
    expect(() =>
      applyDeterministicPromptEdit({
        ...baseInput,
        silences: [],
        instruction: 'cut the pauses and silence',
      }),
    ).toThrow(UnsupportedPromptError);
  });

  it('10c. "trim start" cuts the beginning by specified seconds', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'trim first 4 seconds',
    });

    expect(result.versionName).toBe('Trimmed start (-4s)');
    expect(result.changes[0].action).toBe('trimmed');
    expect(result.changes[0].target).toBe('intro');
    expect(result.operations[0].start).toBe(4);
  });

  it('10d. "trim end" cuts the ending by specified seconds', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'cut the last 5 seconds',
    });

    expect(result.versionName).toBe('Trimmed end (-5s)');
    expect(result.changes[0].action).toBe('trimmed');
    expect(result.changes[0].target).toBe('outro');
    const lastOp = result.operations[result.operations.length - 1];
    expect(lastOp.end).toBe(55); // 60 - 5
  });

  it('10e. "make it vertical" switches aspect ratio to 9:16', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'convert to 9:16 vertical short',
    });

    expect(result.versionName).toBe('Vertical cut (9:16)');
    expect(result.changes[0].action).toBe('effect');
    expect(result.changes[0].target).toBe('aspect ratio');
    expect((result.effects as any).metadata?.aspect).toBe('9:16');
  });

  it('10f. "switch to landscape" switches aspect ratio to 16:9', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'change format to 16:9 widescreen landscape',
    });

    expect(result.versionName).toBe('Landscape cut (16:9)');
    expect(result.changes[0].action).toBe('effect');
    expect(result.changes[0].target).toBe('aspect ratio');
    expect((result.effects as any).metadata?.aspect).toBe('16:9');
  });

  it('10g. "enable subtitles" succeeds when caption cues are present', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      currentEffects: { ...baseInput.currentEffects, subtitles: false },
      instruction: 'enable burned-in subtitles',
    });

    expect(result.versionName).toBe('Subtitles enabled');
    expect(result.effects.subtitles).toBe(true);
    expect(result.changes[0].action).toBe('effect');
    expect(result.changes[0].target).toBe('subtitles');
  });

  it('10h. "enable subtitles" fails with clear error when captions are empty (transcript unavailable)', () => {
    expect(() =>
      applyDeterministicPromptEdit({
        ...baseInput,
        captions: [], // Transcript was unavailable
        instruction: 'turn on subtitles please',
      }),
    ).toThrow(/no speech transcript or caption cues/i);
  });

  it('10i. "disable subtitles" turns off subtitles', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'turn off subtitles',
    });

    expect(result.versionName).toBe('Subtitles disabled');
    expect(result.effects.subtitles).toBe(false);
  });

  it('10j. "add zoom" enables dynamic Ken Burns zoom motion', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'add dynamic zoom effect',
    });

    expect(result.versionName).toBe('Dynamic zoom enabled');
    expect(result.effects.zooms).toBe(true);
    for (const op of result.operations) {
      expect(op.zoom).toBe(1.12);
    }
  });

  it('10k. "set zoom to 1.2" applies explicit zoom factor', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'set zoom factor to 1.25',
    });

    expect(result.versionName).toBe('Zoom 1.25x');
    expect(result.effects.zooms).toBe(true);
    for (const op of result.operations) {
      expect(op.zoom).toBe(1.25);
    }
  });

  it('10l. "disable zoom" removes zoom motion across all clips', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      currentEffects: { ...baseInput.currentEffects, zooms: true },
      instruction: 'disable zoom and remove motion',
    });

    expect(result.versionName).toBe('Zoom disabled');
    expect(result.effects.zooms).toBe(false);
    for (const op of result.operations) {
      expect(op.zoom).toBe(1);
    }
  });

  it('10m. "enable crossfade" enables fade transitions', () => {
    const result = applyDeterministicPromptEdit({
      ...baseInput,
      instruction: 'enable crossfade transitions',
    });

    expect(result.versionName).toBe('Crossfade transitions');
    expect(result.effects.transitions).toBe('fade');
  });

  it('11. returns structured UnsupportedPromptError for unrecognized instructions', () => {
    try {
      applyDeterministicPromptEdit({
        ...baseInput,
        instruction: 'insert 3D fire dragons flying across the screen with CGI lasers',
      });
      expect.unreachable('Should have thrown UnsupportedPromptError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedPromptError);
      const e = err as UnsupportedPromptError;
      expect(e.code).toBe('UNSUPPORTED_PROMPT');
      expect(e.supportedCommands.length).toBeGreaterThan(3);
      expect(e.message).toContain('Unsupported instruction');
    }
  });

  it('14. validateTimeline clamps bounds and guarantees valid duration', () => {
    const rawOps = [
      { index: 2, start: -5, end: 15, label: 'Span 1', keep: true, zoom: 0.5 }, // negative start -> 0, zoom < 1 -> 1
      { index: 0, start: 20, end: 120, label: 'Span 2', keep: true, zoom: 3 }, // end > 60 -> 60, zoom > 2 -> 1
      { index: 1, start: 40, end: 40.05, label: 'Too short', keep: true }, // duration < 0.1s -> filtered out
    ];

    const validated = validateTimeline(rawOps, 60);

    expect(validated).toHaveLength(2);
    // Span 2 was index 0
    expect(validated[0].start).toBe(20);
    expect(validated[0].end).toBe(60);
    expect(validated[0].index).toBe(0);
    // Span 1 was index 2
    expect(validated[1].start).toBe(0);
    expect(validated[1].end).toBe(15);
    expect(validated[1].zoom).toBe(1);
    expect(validated[1].index).toBe(1);
  });

  it('provides deterministic clip explanation based on silence overlap', () => {
    // Overlaps silence [10, 12] and was removed
    const removedPause = explainClipDeterministic({
      start: 9.5,
      end: 12.5,
      kept: false,
      silences: [{ start: 10, end: 12 }],
      highlights: [],
      captions: [],
    });
    expect(removedPause.explanation).toContain('detected audio silence');

    // Kept segment outside silence
    const keptActive = explainClipDeterministic({
      start: 15,
      end: 25,
      kept: true,
      silences: [{ start: 10, end: 12 }],
      highlights: [],
      captions: [],
    });
    expect(keptActive.explanation).toContain('active audio and visual content');
  });

  it('generates deterministic social copy without external API calls', () => {
    const copy = generateDeterministicSocialCopy('AI-powered video editing demo for creators.');
    expect(copy.instagram).toContain('#autoedit');
    expect(copy.tiktok).toContain('#fyp');
    expect(copy.youtube).toContain('AI-powered video editing');
    expect(copy.linkedin).toContain('Key takeaways');
  });
});
