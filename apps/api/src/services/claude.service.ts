import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * We ask Claude for structured JSON by defining a "tool" and forcing its use.
 * Tool-use is the most reliable way to get well-typed output from the model —
 * far better than parsing free text. The model fills the tool's input schema,
 * which we read directly as our analysis object.
 */

export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

// Transcript cue produced by the audio step (e.g. faster-whisper / a transcription service).
export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface SilenceSegment {
  start: number;
  end: number;
}

export interface ClaudeAnalysis {
  summary: string;
  highlights: { start: number; end: number; label: string; score: number }[];
  speakers: { id: string; label: string; segments: { start: number; end: number }[] }[];
  captions: { start: number; end: number; text: string }[];
  suggestedTitles: string[];
  socialCopy: { instagram: string; tiktok: string; youtube: string; linkedin: string };
  storyboard: { scene: number; description: string; shotType: string }[];
  editingStrategy: string;
}

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: 'submit_video_analysis',
  description:
    'Submit the structured analysis and editing strategy for the uploaded video. ' +
    'All timestamps are in seconds and must fall within the video duration.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One-paragraph summary of the video content.' },
      editingStrategy: {
        type: 'string',
        description:
          'How to edit this into engaging short-form content: pacing, what to cut, where to add zooms/transitions.',
      },
      highlights: {
        type: 'array',
        description: 'The most engaging moments worth clipping, ranked by score (0-1).',
        items: {
          type: 'object',
          properties: {
            start: { type: 'number' },
            end: { type: 'number' },
            label: { type: 'string' },
            score: { type: 'number' },
          },
          required: ['start', 'end', 'label', 'score'],
        },
      },
      speakers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            segments: {
              type: 'array',
              items: {
                type: 'object',
                properties: { start: { type: 'number' }, end: { type: 'number' } },
                required: ['start', 'end'],
              },
            },
          },
          required: ['id', 'label', 'segments'],
        },
      },
      captions: {
        type: 'array',
        description: 'Caption cues for burned-in subtitles, max ~7 words each.',
        items: {
          type: 'object',
          properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } },
          required: ['start', 'end', 'text'],
        },
      },
      suggestedTitles: { type: 'array', items: { type: 'string' } },
      socialCopy: {
        type: 'object',
        properties: {
          instagram: { type: 'string' },
          tiktok: { type: 'string' },
          youtube: { type: 'string' },
          linkedin: { type: 'string' },
        },
        required: ['instagram', 'tiktok', 'youtube', 'linkedin'],
      },
      storyboard: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scene: { type: 'number' },
            description: { type: 'string' },
            shotType: { type: 'string' },
          },
          required: ['scene', 'description', 'shotType'],
        },
      },
    },
    required: [
      'summary',
      'editingStrategy',
      'highlights',
      'speakers',
      'captions',
      'suggestedTitles',
      'socialCopy',
      'storyboard',
    ],
  },
};

const SYSTEM_PROMPT = `You are the editorial brain of an automated video editor.
You receive a transcript (with timing and speaker labels) and technical metadata for
a video. You decide how to turn it into engaging, accurate short-form content.

Rules:
- Never invent dialogue. Captions must come from the transcript.
- All timestamps are in seconds and must be within [0, duration].
- Highlights should be self-contained clips (8-60s) that make sense on their own.
- Social copy must be platform-appropriate in tone and length.
- Always respond by calling the submit_video_analysis tool. Do not write prose.`;

export async function analyzeVideo(input: {
  meta: VideoMeta;
  transcript: TranscriptCue[];
  silences: SilenceSegment[];
  userPrompt?: string;
}): Promise<{ analysis: ClaudeAnalysis; raw: unknown; model: string }> {
  const userContent = [
    `VIDEO METADATA: ${JSON.stringify(input.meta)}`,
    `DETECTED SILENCES (s): ${JSON.stringify(input.silences)}`,
    `TRANSCRIPT (${input.transcript.length} cues):`,
    JSON.stringify(input.transcript),
    input.userPrompt ? `USER INTENT: ${input.userPrompt}` : '',
    'Produce the full analysis and editing strategy now.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const message = await client.messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [ANALYSIS_TOOL],
    tool_choice: { type: 'tool', name: 'submit_video_analysis' },
    messages: [{ role: 'user', content: userContent }],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) throw new Error('Claude did not return structured analysis.');

  return {
    analysis: toolUse.input as ClaudeAnalysis,
    raw: message,
    model: env.CLAUDE_MODEL,
  };
}

/** Cheap, fast regeneration of just the social copy (e.g. user clicks "rewrite"). */
export async function regenerateSocialCopy(summary: string, tone: string) {
  const message = await client.messages.create({
    model: env.CLAUDE_FAST_MODEL,
    max_tokens: 1024,
    system: 'You write punchy social media copy. Respond ONLY with JSON, no markdown fences.',
    messages: [
      {
        role: 'user',
        content: `Video summary: ${summary}\nTone: ${tone}\nReturn JSON: {"instagram":"","tiktok":"","youtube":"","linkedin":""}`,
      },
    ],
  });
  const text = message.content.find((b) => b.type === 'text');
  const raw = text && text.type === 'text' ? text.text : '{}';
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-based editing — the user describes the edit in natural language and
// Claude rewrites the timeline (which clips to keep, their order/trim/zoom, and
// the effects). This is what makes AutoEdit an *AI* editor.
// ─────────────────────────────────────────────────────────────────────────────

export interface TimelineOp {
  index: number;
  start: number;
  end: number;
  label?: string;
  keep?: boolean;
  zoom?: number;
}
export interface TimelineEffects {
  subtitles: boolean;
  zooms: boolean;
  transitions: 'fade' | 'none';
  music: boolean;
}
export interface EditChange {
  action: 'kept' | 'removed' | 'trimmed' | 'reordered' | 'added' | 'effect';
  target: string; // human-readable, e.g. "03:12–04:01" or "background music"
  reasons: string[]; // the WHY — short bullet reasons that build user trust
}
export interface EditResult {
  operations: TimelineOp[];
  effects: TimelineEffects;
  changes: EditChange[]; // per-decision explanation
  reasoning: string; // overall editorial rationale
  versionName: string; // short label, e.g. "Tighter viral cut"
}

const EDIT_TOOL: Anthropic.Tool = {
  name: 'apply_edit',
  description:
    'Return the updated edit plan after applying the user instruction. ' +
    'operations is the full, reordered list of clips (index = output order). ' +
    'Keep timestamps within the video duration. Use the analysis to make smart cuts.',
  input_schema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'position in the output, starting at 0' },
            start: { type: 'number' },
            end: { type: 'number' },
            label: { type: 'string' },
            keep: { type: 'boolean' },
            zoom: { type: 'number', description: '1 = none, ~1.08 = subtle zoom' },
          },
          required: ['index', 'start', 'end', 'keep'],
        },
      },
      effects: {
        type: 'object',
        properties: {
          subtitles: { type: 'boolean' },
          zooms: { type: 'boolean' },
          transitions: { type: 'string', enum: ['fade', 'none'] },
          music: { type: 'boolean' },
        },
        required: ['subtitles', 'zooms', 'transitions', 'music'],
      },
      changes: {
        type: 'array',
        description:
          'One entry per meaningful editing decision. Each must explain WHY in plain language — this is shown to the user to build trust.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['kept', 'removed', 'trimmed', 'reordered', 'added', 'effect'] },
            target: { type: 'string', description: 'what it refers to, e.g. "03:12–04:01" or "background music"' },
            reasons: { type: 'array', items: { type: 'string' }, description: 'short bullet reasons' },
          },
          required: ['action', 'target', 'reasons'],
        },
      },
      reasoning: { type: 'string', description: 'overall editorial rationale for this version (2-4 sentences)' },
      versionName: {
        type: 'string',
        description: 'a short, distinctive name for this version, e.g. "Tighter viral cut" or "Educational deep-dive"',
      },
    },
    required: ['operations', 'effects', 'changes', 'reasoning', 'versionName'],
  },
};

export async function editTimelineWithPrompt(input: {
  instruction: string;
  durationSec: number;
  summary?: string | null;
  highlights: unknown;
  silences: unknown;
  captions: unknown;
  currentOps: TimelineOp[];
  currentEffects: TimelineEffects;
  creatorProfile?: string;
}): Promise<EditResult> {
  const userContent = [
    input.creatorProfile ?? '',
    `VIDEO DURATION (s): ${input.durationSec}`,
    input.summary ? `SUMMARY: ${input.summary}` : '',
    `DETECTED HIGHLIGHTS: ${JSON.stringify(input.highlights)}`,
    `DETECTED SILENCES: ${JSON.stringify(input.silences)}`,
    `CAPTION CUES (for reference): ${JSON.stringify(input.captions)}`,
    `CURRENT EDIT PLAN — operations: ${JSON.stringify(input.currentOps)}`,
    `CURRENT EFFECTS: ${JSON.stringify(input.currentEffects)}`,
    `USER INSTRUCTION: "${input.instruction}"`,
    'Apply the instruction and return the full updated plan via apply_edit.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const message = await client.messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 6000,
    system:
      'You are the AI Director of a video editor. You receive the current edit plan, ' +
      'the analysis of the source video, and a natural-language instruction (often a ' +
      'GOAL like "go viral on TikTok" or "make it educational"). Translate the goal into ' +
      'concrete editing decisions: choose which clips to keep, reorder them, trim in/out ' +
      'points, set per-clip zoom, and toggle effects. For EVERY meaningful decision, record ' +
      'a change entry that explains WHY in plain language (e.g. removed because it repeats an ' +
      'earlier point / low energy / long pause). Never invent timestamps outside [0, duration]. ' +
      'Prefer cutting on silence boundaries when tightening pacing. Give the version a short, ' +
      'distinctive name. Always respond by calling apply_edit.',
    tools: [EDIT_TOOL],
    tool_choice: { type: 'tool', name: 'apply_edit' },
    messages: [{ role: 'user', content: userContent }],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) throw new Error('Claude did not return an edit.');
  const result = toolUse.input as EditResult;

  // backfill metadata so downstream code is never handed undefined
  result.changes = Array.isArray(result.changes) ? result.changes : [];
  result.reasoning = result.reasoning ?? '';
  result.versionName = result.versionName?.trim() || 'Untitled edit';

  // clamp + normalize so a hallucinated bound can never break the renderer
  const dur = input.durationSec || Number.MAX_SAFE_INTEGER;
  result.operations = result.operations
    .map((o, i) => ({
      index: typeof o.index === 'number' ? o.index : i,
      start: Math.max(0, Math.min(o.start, dur)),
      end: Math.max(0, Math.min(o.end, dur)),
      label: o.label,
      keep: o.keep ?? true,
      zoom: o.zoom ?? 1,
    }))
    .filter((o) => o.end > o.start)
    .sort((a, b) => a.index - b.index)
    .map((o, i) => ({ ...o, index: i }));

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Explainable AI — answer "why was this clip kept/removed?" for any segment.
// ─────────────────────────────────────────────────────────────────────────────

export async function explainClip(input: {
  start: number;
  end: number;
  kept: boolean;
  summary?: string | null;
  highlights: unknown;
  silences: unknown;
  captions: unknown;
}): Promise<{ explanation: string; reasons: string[] }> {
  const message = await client.messages.create({
    model: env.CLAUDE_FAST_MODEL,
    max_tokens: 700,
    system:
      'You explain a video editor\'s decisions to build user trust. Given the analysis ' +
      'and a specific time range, explain in plain language why that segment is ' +
      (input.kept ? 'KEPT in' : 'REMOVED from') +
      ' the edit. Be concrete and reference the evidence (energy, repetition, silence, ' +
      'relevance). Respond ONLY with JSON: {"explanation":"...","reasons":["...","..."]}.',
    messages: [
      {
        role: 'user',
        content: [
          `SEGMENT: ${input.start}s–${input.end}s (currently ${input.kept ? 'kept' : 'removed'})`,
          input.summary ? `SUMMARY: ${input.summary}` : '',
          `HIGHLIGHTS: ${JSON.stringify(input.highlights)}`,
          `SILENCES: ${JSON.stringify(input.silences)}`,
          `CAPTIONS NEAR SEGMENT: ${JSON.stringify(input.captions)}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });
  const text = message.content.find((b) => b.type === 'text');
  const raw = text && text.type === 'text' ? text.text : '{}';
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return { explanation: parsed.explanation ?? '', reasons: parsed.reasons ?? [] };
  } catch {
    return { explanation: raw.slice(0, 400), reasons: [] };
  }
}
