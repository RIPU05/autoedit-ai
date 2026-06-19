import { runDirector } from './director.agent.js';
import {
  runEditor,
  runCaptioner,
  runHook,
  runSocial,
  runThumbnail,
  type EditorOutput,
  type CaptionOutput,
  type HookOutput,
  type SocialOutput,
  type ThumbnailOutput,
} from './specialists.agent.js';
import type { VideoMeta, TranscriptCue, SilenceSegment } from '../services/claude.service.js';
import { env } from '../config/env.js';

export interface AgentLogEntry {
  agent: string;
  ms: number;
  summary: string;
}

export interface PipelineResult {
  summary: string;
  strategy: string;
  reasoning: string;
  highlights: { start: number; end: number; label: string; score: number }[];
  speakers: { id: string; label: string; segments: { start: number; end: number }[] }[];
  captions: CaptionOutput['captions'];
  suggestedTitles: SocialOutput['suggestedTitles'];
  socialCopy: SocialOutput['socialCopy'];
  hook: HookOutput;
  thumbnail: ThumbnailOutput;
  operations: EditorOutput['operations'];
  effects: EditorOutput['effects'];
  agentLog: AgentLogEntry[];
  model: string;
}

/** Derive speaker turns from transcript cues that carry a speaker label. */
function deriveSpeakers(transcript: TranscriptCue[]): PipelineResult['speakers'] {
  const byId = new Map<string, { start: number; end: number }[]>();
  for (const cue of transcript) {
    const id = cue.speaker ?? 'spk_1';
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push({ start: cue.start, end: cue.end });
  }
  return [...byId.entries()].map(([id, segments], i) => ({ id, label: `Speaker ${i + 1}`, segments }));
}

/**
 * Director-led pipeline. The Director sets direction and chooses segments; the
 * specialist agents then run in parallel against that shared plan. Returns a
 * combined result plus a per-agent log for the activity feed / transparency.
 */
export async function runEditorialPipeline(input: {
  meta: VideoMeta;
  transcript: TranscriptCue[];
  silences: SilenceSegment[];
  goal?: string;
  creatorProfile?: string;
}): Promise<PipelineResult> {
  const log: AgentLogEntry[] = [];

  // 1. Director first — everyone else depends on its segments
  const director = await runDirector(input);
  log.push({ agent: 'Director', ms: director.ms, summary: director.output.strategy });
  const segments = director.output.segments;

  // 2. specialists in parallel
  const [editor, captioner, hook, social, thumbnail] = await Promise.all([
    runEditor({ strategy: director.output.strategy, segments, durationSec: input.meta.durationSec }),
    runCaptioner({ transcript: input.transcript, segments }),
    runHook({ transcript: input.transcript, segments }),
    runSocial({ summary: director.output.summary, strategy: director.output.strategy }),
    runThumbnail({ summary: director.output.summary, segments }),
  ]);

  log.push({ agent: 'Editor', ms: editor.ms, summary: `${editor.output.operations.length} clips arranged` });
  log.push({ agent: 'Caption', ms: captioner.ms, summary: `${captioner.output.captions.length} caption cues` });
  log.push({ agent: 'Hook', ms: hook.ms, summary: hook.output.hook.text.slice(0, 60) });
  log.push({ agent: 'Social', ms: social.ms, summary: `${social.output.suggestedTitles.length} titles + 4 platforms` });
  log.push({ agent: 'Thumbnail', ms: thumbnail.ms, summary: thumbnail.output.overlayText });

  return {
    summary: director.output.summary,
    strategy: director.output.strategy,
    reasoning: director.output.reasoning,
    highlights: segments,
    speakers: deriveSpeakers(input.transcript),
    captions: captioner.output.captions,
    suggestedTitles: social.output.suggestedTitles,
    socialCopy: social.output.socialCopy,
    hook: hook.output,
    thumbnail: thumbnail.output,
    operations: editor.output.operations,
    effects: editor.output.effects,
    agentLog: log,
    model: env.CLAUDE_MODEL,
  };
}
