import type { TimelineOp, TimelineEffects, EditResult, EditChange } from './claude.service.js';

export class UnsupportedPromptError extends Error {
  code = 'UNSUPPORTED_PROMPT';
  supportedCommands = [
    'remove silence / cut pauses',
    'trim start / trim end (e.g. "trim first 3 seconds", "trim end by 2s")',
    'change aspect ratio (e.g. "make it vertical", "convert to 16:9", "switch to landscape")',
    'toggle captions / subtitles (requires available transcript)',
    'toggle zoom / crop (e.g. "add zoom", "disable zoom", "zoom level 1.15")',
    'toggle transitions (e.g. "enable crossfade", "hard cuts")',
  ];

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPromptError';
  }
}

export interface PromptEditInput {
  instruction: string;
  durationSec: number;
  summary?: string | null;
  highlights: unknown;
  silences: unknown;
  captions: unknown;
  currentOps: TimelineOp[];
  currentEffects: TimelineEffects;
  creatorProfile?: string;
  claudeApiKey?: string;
}

export interface ExplainClipInput {
  start: number;
  end: number;
  kept: boolean;
  summary?: string | null;
  highlights: unknown;
  silences: unknown;
  captions: unknown;
}

/**
 * Validates timeline operations to guarantee they never cause renderer failure.
 * Clamps timestamps to [0, durationSec], ensures end > start >= 0.1s,
 * removes empty spans, and normalizes indexing.
 */
export function validateTimeline(ops: TimelineOp[], durationSec: number): TimelineOp[] {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('Timeline must contain at least one operation');
  }
  const dur = Math.max(0.1, durationSec);
  const validated = ops
    .map((o, i) => ({
      index: typeof o.index === 'number' ? o.index : i,
      start: Math.max(0, Math.min(Number(o.start) || 0, dur)),
      end: Math.max(0, Math.min(Number(o.end) || 0, dur)),
      label: typeof o.label === 'string' ? o.label.slice(0, 100) : `Segment ${i + 1}`,
      keep: o.keep !== false,
      zoom: typeof o.zoom === 'number' && o.zoom >= 1 && o.zoom <= 2 ? o.zoom : 1,
    }))
    .filter((o) => o.end - o.start >= 0.1)
    .sort((a, b) => a.index - b.index)
    .map((o, i) => ({ ...o, index: i }));

  if (validated.length === 0) {
    throw new Error('All timeline operations were filtered out or have zero duration');
  }
  return validated;
}

function subtractSilencesFromSpan(
  start: number,
  end: number,
  silences: { start: number; end: number }[],
): { start: number; end: number }[] {
  let spans = [{ start, end }];
  for (const s of silences) {
    spans = spans.flatMap((span) => {
      if (s.end <= span.start || s.start >= span.end) return [span];
      return [
        { start: span.start, end: Math.max(span.start, s.start) },
        { start: Math.min(span.end, s.end), end: span.end },
      ].filter((chunk) => chunk.end - chunk.start > 0.2);
    });
  }
  return spans;
}

function getEffectsMetadata(effects: TimelineEffects): Record<string, unknown> {
  const anyEffects = effects as any;
  return anyEffects.metadata && typeof anyEffects.metadata === 'object' ? { ...anyEffects.metadata } : {};
}

/**
 * Deterministic prompt editor for supported video operations.
 * Runs when AI_PROVIDER=fallback or Claude is unavailable.
 */
export function applyDeterministicPromptEdit(input: PromptEditInput): EditResult {
  const instruction = input.instruction.trim();
  const lower = instruction.toLowerCase();
  const dur = Math.max(0.1, input.durationSec);

  // Fall back to a default operation covering the duration if currentOps is empty
  const baseOps: TimelineOp[] =
    Array.isArray(input.currentOps) && input.currentOps.length > 0
      ? input.currentOps
      : [{ index: 0, start: 0, end: dur, keep: true, zoom: 1, label: 'Full clip' }];

  const baseEffects: TimelineEffects = input.currentEffects ?? {
    subtitles: false,
    zooms: false,
    transitions: 'none',
    music: false,
  };

  // 1. SILENCE REMOVAL
  if (
    /(?:remove|cut|trim|delete)\s*(?:all\s*)?(?:the\s*)?(?:silence|silences|pause|pauses|dead\s*air)|no\s*silence/i.test(
      lower,
    )
  ) {
    const silences = Array.isArray(input.silences) ? (input.silences as { start: number; end: number }[]) : [];
    if (silences.length === 0) {
      throw new UnsupportedPromptError('No silences were detected in this video to remove.');
    }

    const newOps: TimelineOp[] = [];
    for (const op of baseOps) {
      if (op.keep === false) continue;
      const chunks = subtractSilencesFromSpan(op.start, op.end, silences);
      for (const chunk of chunks) {
        newOps.push({
          index: newOps.length,
          start: chunk.start,
          end: chunk.end,
          label: op.label ?? `Segment ${newOps.length + 1}`,
          keep: true,
          zoom: op.zoom ?? 1,
        });
      }
    }

    if (newOps.length === 0) {
      throw new UnsupportedPromptError('Removing all silences would remove all footage from the timeline.');
    }

    const validatedOps = validateTimeline(newOps, dur);
    const changes: EditChange[] = [
      {
        action: 'trimmed',
        target: 'silences',
        reasons: [`Removed ${silences.length} detected silence intervals to eliminate dead air`],
      },
    ];

    return {
      operations: validatedOps,
      effects: baseEffects,
      changes,
      reasoning: 'Removed detected silence intervals to tighten pacing and keep only active content.',
      versionName: 'Silence cut',
    };
  }

  // 2. TRIM START / BEGINNING
  const trimStartMatch =
    /(?:trim|cut|remove)\s*(?:the\s*)?(?:first|start|beginning|intro)\s*(?:by\s*)?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?/i.exec(
      lower,
    ) || /(?:trim|cut)\s*(?:the\s*)?(?:first|start|beginning|intro)/i.exec(lower);

  if (trimStartMatch) {
    const rawSeconds = trimStartMatch[1] ? parseFloat(trimStartMatch[1]) : 2;
    const trimSec = Math.max(0.1, rawSeconds);

    if (trimSec >= dur) {
      throw new UnsupportedPromptError(`Cannot trim ${trimSec}s from a video with duration ${dur.toFixed(1)}s.`);
    }

    const newOps: TimelineOp[] = [];
    for (const op of baseOps) {
      if (op.end <= trimSec) continue; // fully before cut
      if (op.start < trimSec && op.end > trimSec) {
        newOps.push({ ...op, start: trimSec });
      } else if (op.start >= trimSec) {
        newOps.push({ ...op });
      }
    }

    if (newOps.length === 0) {
      throw new UnsupportedPromptError('Trimming the start would eliminate all operations.');
    }

    const validatedOps = validateTimeline(newOps, dur);
    const changes: EditChange[] = [
      {
        action: 'trimmed',
        target: 'intro',
        reasons: [`Trimmed the first ${trimSec}s from the start of the video`],
      },
    ];

    return {
      operations: validatedOps,
      effects: baseEffects,
      changes,
      reasoning: `Trimmed ${trimSec}s from the beginning of the timeline per user instruction.`,
      versionName: `Trimmed start (-${trimSec}s)`,
    };
  }

  // 3. TRIM END / OUTRO
  const trimEndMatch =
    /(?:trim|cut|remove)\s*(?:the\s*)?(?:last|end|outro)\s*(?:by\s*)?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?/i.exec(
      lower,
    ) || /(?:trim|cut)\s*(?:the\s*)?(?:last|end|outro)/i.exec(lower);

  if (trimEndMatch) {
    const rawSeconds = trimEndMatch[1] ? parseFloat(trimEndMatch[1]) : 2;
    const trimSec = Math.max(0.1, rawSeconds);

    if (trimSec >= dur) {
      throw new UnsupportedPromptError(`Cannot trim ${trimSec}s from a video with duration ${dur.toFixed(1)}s.`);
    }

    const cutoff = Math.max(0.1, dur - trimSec);
    const newOps: TimelineOp[] = [];
    for (const op of baseOps) {
      if (op.start >= cutoff) continue; // fully after cut
      if (op.start < cutoff && op.end > cutoff) {
        newOps.push({ ...op, end: cutoff });
      } else if (op.end <= cutoff) {
        newOps.push({ ...op });
      }
    }

    if (newOps.length === 0) {
      throw new UnsupportedPromptError('Trimming the end would eliminate all operations.');
    }

    const validatedOps = validateTimeline(newOps, dur);
    const changes: EditChange[] = [
      {
        action: 'trimmed',
        target: 'outro',
        reasons: [`Trimmed the last ${trimSec}s from the end of the video`],
      },
    ];

    return {
      operations: validatedOps,
      effects: baseEffects,
      changes,
      reasoning: `Trimmed ${trimSec}s from the end of the timeline per user instruction.`,
      versionName: `Trimmed end (-${trimSec}s)`,
    };
  }

  // 4. ASPECT RATIO: VERTICAL (9:16)
  if (
    /(?:make|convert|change|set|switch|format).*?(?:to\s*)?(?:vertical|9:16|portrait|reel|short|tiktok)|(?:vertical|9:16)\s*(?:format|cut|mode)?/i.test(
      lower,
    )
  ) {
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      metadata: { ...getEffectsMetadata(baseEffects), aspect: '9:16' },
    } as TimelineEffects;

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'aspect ratio',
        reasons: ['Switched target output format to 9:16 vertical (Shorts / Reels)'],
      },
    ];

    return {
      operations: validateTimeline(baseOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Adjusted aspect ratio to 9:16 vertical format suitable for Shorts, Reels, and TikTok.',
      versionName: 'Vertical cut (9:16)',
    };
  }

  // 5. ASPECT RATIO: HORIZONTAL (16:9)
  if (
    /(?:make|convert|change|set|switch|format).*?(?:to\s*)?(?:horizontal|16:9|landscape|widescreen|youtube)|(?:horizontal|16:9|landscape)\s*(?:format|cut|mode)?/i.test(
      lower,
    )
  ) {
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      metadata: { ...getEffectsMetadata(baseEffects), aspect: '16:9' },
    } as TimelineEffects;

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'aspect ratio',
        reasons: ['Switched target output format to 16:9 landscape'],
      },
    ];

    return {
      operations: validateTimeline(baseOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Adjusted aspect ratio to 16:9 landscape format for widescreen viewing.',
      versionName: 'Landscape cut (16:9)',
    };
  }

  // 6. CAPTIONS / SUBTITLES
  if (
    /(?:enable|add|show|turn\s*on|include|burn\s*in).*?(?:subtitles|captions)|with\s*(?:subtitles|captions)/i.test(
      lower,
    )
  ) {
    const captionsList = Array.isArray(input.captions) ? input.captions : [];
    if (captionsList.length === 0) {
      throw new UnsupportedPromptError(
        'Cannot enable subtitles: no speech transcript or caption cues are available for this video.',
      );
    }

    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      subtitles: true,
    };

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'subtitles',
        reasons: ['Enabled burned-in subtitles from available caption cues'],
      },
    ];

    return {
      operations: validateTimeline(baseOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Enabled burned-in subtitles using the available caption cues.',
      versionName: 'Subtitles enabled',
    };
  }

  if (
    /(?:disable|remove|hide|turn\s*off|exclude).*?(?:subtitles|captions)|no\s*(?:subtitles|captions)|without\s*(?:subtitles|captions)/i.test(
      lower,
    )
  ) {
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      subtitles: false,
    };

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'subtitles',
        reasons: ['Disabled burned-in subtitles'],
      },
    ];

    return {
      operations: validateTimeline(baseOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Disabled subtitles; video will render without burned-in captions.',
      versionName: 'Subtitles disabled',
    };
  }

  // 7. CROP / ZOOM
  const zoomFactorMatch = /(?:set\s*)?(?:clip\s*)?zoom(?:\s*(?:factor|level|to|\=))*\s*(\d+(?:\.\d+)?)/i.exec(lower);
  if (zoomFactorMatch) {
    const factor = Math.max(1, Math.min(parseFloat(zoomFactorMatch[1]), 1.3));
    const newOps = baseOps.map((op) => ({ ...op, zoom: factor }));
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      zooms: factor > 1,
    };

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'zoom',
        reasons: [`Set clip zoom factor to ${factor}`],
      },
    ];

    return {
      operations: validateTimeline(newOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: `Applied custom zoom factor of ${factor} across timeline clips.`,
      versionName: `Zoom ${factor}x`,
    };
  }

  if (/(?:enable|add|apply|turn\s*on)\s*(?:zooms?|ken\s*burns?)|zoom\s*in|dynamic\s*zoom/i.test(lower)) {
    const newOps = baseOps.map((op) => ({ ...op, zoom: 1.12 }));
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      zooms: true,
    };

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'zoom',
        reasons: ['Enabled dynamic zoom (Ken Burns) motion on kept clips'],
      },
    ];

    return {
      operations: validateTimeline(newOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Enabled dynamic zoom motion to increase visual engagement.',
      versionName: 'Dynamic zoom enabled',
    };
  }

  if (/(?:disable|remove|turn\s*off)\s*(?:zooms?|ken\s*burns?)|no\s*zoom/i.test(lower)) {
    const newOps = baseOps.map((op) => ({ ...op, zoom: 1 }));
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      zooms: false,
    };

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'zoom',
        reasons: ['Disabled zoom motion across clips'],
      },
    ];

    return {
      operations: validateTimeline(newOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Disabled zoom motion; clips will render at 1x fixed scale.',
      versionName: 'Zoom disabled',
    };
  }

  // 8. TRANSITIONS / CROSSFADE
  if (/(?:enable|add|turn\s*on|smooth)\s*(?:fade|crossfade|transitions?)/i.test(lower)) {
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      transitions: 'fade',
    };

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'transitions',
        reasons: ['Enabled 0.25s crossfade transitions between clips'],
      },
    ];

    return {
      operations: validateTimeline(baseOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Enabled crossfade transitions between clips.',
      versionName: 'Crossfade transitions',
    };
  }

  if (/(?:disable|remove|turn\s*off|no)\s*(?:fade|crossfade|transitions?)|hard\s*cuts?/i.test(lower)) {
    const updatedEffects: TimelineEffects = {
      ...baseEffects,
      transitions: 'none',
    };

    const changes: EditChange[] = [
      {
        action: 'effect',
        target: 'transitions',
        reasons: ['Set transitions to hard cuts'],
      },
    ];

    return {
      operations: validateTimeline(baseOps, dur),
      effects: updatedEffects,
      changes,
      reasoning: 'Set transitions to clean hard cuts.',
      versionName: 'Hard cuts',
    };
  }

  // UNSUPPORTED PROMPT
  throw new UnsupportedPromptError(
    `Unsupported instruction: "${instruction}". In fallback mode, supported instructions include: remove silences, trim start/end, change aspect ratio (9:16 or 16:9), toggle captions (requires transcript), and toggle zoom/transitions.`,
  );
}

/**
 * Deterministic clip explanation when Claude is unavailable.
 * Inspects silence intervals and captions to provide truthful rationale.
 */
export function explainClipDeterministic(input: ExplainClipInput): { explanation: string; reasons: string[] } {
  const silences = Array.isArray(input.silences) ? (input.silences as { start: number; end: number }[]) : [];
  const overlapsSilence = silences.some(
    (s) => Math.max(s.start, input.start) < Math.min(s.end, input.end),
  );

  if (!input.kept) {
    if (overlapsSilence) {
      return {
        explanation: `This segment (${input.start.toFixed(1)}s–${input.end.toFixed(1)}s) was excluded because it overlaps with detected audio silence.`,
        reasons: ['Overlaps with audio pause/silence', 'Cut to maintain tight pacing'],
      };
    }
    return {
      explanation: `This segment (${input.start.toFixed(1)}s–${input.end.toFixed(1)}s) was trimmed to keep the timeline focused on core content.`,
      reasons: ['Excluded to meet target runtime', 'Non-primary segment'],
    };
  }

  if (overlapsSilence) {
    return {
      explanation: `This segment (${input.start.toFixed(1)}s–${input.end.toFixed(1)}s) is kept in the timeline as a transition bridge.`,
      reasons: ['Maintains clip continuity', 'Retained by timeline edit plan'],
    };
  }

  return {
    explanation: `This segment (${input.start.toFixed(1)}s–${input.end.toFixed(1)}s) was kept because it contains active audio and visual content.`,
    reasons: ['Active content segment', 'Falls outside detected pauses'],
  };
}

/**
 * Deterministic social copy generator when Claude is unavailable.
 */
export function generateDeterministicSocialCopy(
  summary?: string | null,
  tone?: string,
): { instagram: string; tiktok: string; youtube: string; linkedin: string } {
  const base = (summary && summary.trim()) || 'AutoAI Edit video highlight';
  const prefix = tone ? `[${tone}] ` : '';

  return {
    instagram: `${prefix}${base.slice(0, 140)} #autoedit #video #creators`,
    tiktok: `${prefix}${base.slice(0, 90)} #fyp #viral #editing`,
    youtube: `${prefix}${base.slice(0, 200)}`,
    linkedin: `${prefix}${base.slice(0, 300)}\n\nKey takeaways from our latest video edit.`,
  };
}
