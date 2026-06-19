import { callAgent } from './base.js';
import { env } from '../config/env.js';
import type { TranscriptCue } from '../services/claude.service.js';

type Seg = { start: number; end: number; label: string; score: number };

// ── Editor agent: turns segments + strategy into concrete timeline ops ─────────
export interface EditorOutput {
  operations: { index: number; start: number; end: number; label: string; keep: boolean; zoom: number }[];
  effects: { subtitles: boolean; zooms: boolean; transitions: 'fade' | 'none'; music: boolean };
}
export async function runEditor(input: { strategy: string; segments: Seg[]; durationSec: number }) {
  return callAgent<EditorOutput>({
    name: 'Editor',
    system:
      'You are the EDITOR agent. Convert the strategy + chosen segments into a concrete ' +
      'timeline: ordered operations (index = output order, keep=true) with per-clip zoom, ' +
      'plus effect toggles. Keep timestamps within the duration. Always call submit_timeline.',
    tool: {
      name: 'submit_timeline',
      description: 'Submit the concrete editing timeline.',
      input_schema: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number' },
                start: { type: 'number' },
                end: { type: 'number' },
                label: { type: 'string' },
                keep: { type: 'boolean' },
                zoom: { type: 'number' },
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
        },
        required: ['operations', 'effects'],
      },
    },
    user: [
      `DURATION: ${input.durationSec}`,
      `STRATEGY: ${input.strategy}`,
      `SEGMENTS: ${JSON.stringify(input.segments)}`,
    ].join('\n\n'),
  });
}

// ── Caption agent: SRT-style cues from the transcript within kept segments ─────
export interface CaptionOutput {
  captions: { start: number; end: number; text: string }[];
}
export async function runCaptioner(input: { transcript: TranscriptCue[]; segments: Seg[] }) {
  return callAgent<CaptionOutput>({
    name: 'Caption',
    system:
      'You are the CAPTION agent. Produce burn-in caption cues (max ~7 words each) drawn ' +
      'verbatim from the transcript, only within the kept segments. Never invent words. ' +
      'Always call submit_captions.',
    model: env.CLAUDE_FAST_MODEL,
    tool: {
      name: 'submit_captions',
      description: 'Submit caption cues.',
      input_schema: {
        type: 'object',
        properties: {
          captions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } },
              required: ['start', 'end', 'text'],
            },
          },
        },
        required: ['captions'],
      },
    },
    user: [`SEGMENTS: ${JSON.stringify(input.segments)}`, `TRANSCRIPT: ${JSON.stringify(input.transcript)}`].join('\n\n'),
  });
}

// ── Hook agent: the strongest opening + alternatives ──────────────────────────
export interface HookOutput {
  hook: { start: number; end: number; text: string };
  alternatives: string[];
}
export async function runHook(input: { transcript: TranscriptCue[]; segments: Seg[] }) {
  return callAgent<HookOutput>({
    name: 'Hook',
    system:
      'You are the HOOK agent. Pick the single most scroll-stopping moment to open with ' +
      '(its time range + the spoken line), and write 3 alternative text hooks. Always call submit_hook.',
    model: env.CLAUDE_FAST_MODEL,
    tool: {
      name: 'submit_hook',
      description: 'Submit the opening hook.',
      input_schema: {
        type: 'object',
        properties: {
          hook: {
            type: 'object',
            properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } },
            required: ['start', 'end', 'text'],
          },
          alternatives: { type: 'array', items: { type: 'string' } },
        },
        required: ['hook', 'alternatives'],
      },
    },
    user: [`SEGMENTS: ${JSON.stringify(input.segments)}`, `TRANSCRIPT: ${JSON.stringify(input.transcript)}`].join('\n\n'),
  });
}

// ── Social agent: titles + platform copy ──────────────────────────────────────
export interface SocialOutput {
  suggestedTitles: string[];
  socialCopy: { instagram: string; tiktok: string; youtube: string; linkedin: string };
}
export async function runSocial(input: { summary: string; strategy: string }) {
  return callAgent<SocialOutput>({
    name: 'Social',
    system:
      'You are the SOCIAL agent. Write 5 title options and platform-appropriate copy ' +
      '(instagram, tiktok, youtube, linkedin). Match each platform\'s tone and length. ' +
      'Always call submit_social.',
    model: env.CLAUDE_FAST_MODEL,
    tool: {
      name: 'submit_social',
      description: 'Submit titles and social copy.',
      input_schema: {
        type: 'object',
        properties: {
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
        },
        required: ['suggestedTitles', 'socialCopy'],
      },
    },
    user: `SUMMARY: ${input.summary}\n\nSTRATEGY: ${input.strategy}`,
  });
}

// ── Thumbnail agent: concept + overlay text + best frame ───────────────────────
export interface ThumbnailOutput {
  concept: string;
  overlayText: string;
  bestFrameSec: number;
}
export async function runThumbnail(input: { summary: string; segments: Seg[] }) {
  return callAgent<ThumbnailOutput>({
    name: 'Thumbnail',
    system:
      'You are the THUMBNAIL agent. Propose a thumbnail: a visual concept, punchy overlay ' +
      'text (<=5 words), and the best source timestamp to grab the frame from. Always call submit_thumbnail.',
    model: env.CLAUDE_FAST_MODEL,
    tool: {
      name: 'submit_thumbnail',
      description: 'Submit the thumbnail concept.',
      input_schema: {
        type: 'object',
        properties: {
          concept: { type: 'string' },
          overlayText: { type: 'string' },
          bestFrameSec: { type: 'number' },
        },
        required: ['concept', 'overlayText', 'bestFrameSec'],
      },
    },
    user: `SUMMARY: ${input.summary}\n\nSEGMENTS: ${JSON.stringify(input.segments)}`,
  });
}
