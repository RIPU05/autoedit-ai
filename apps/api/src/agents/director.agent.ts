import { callAgent } from './base.js';
import type { VideoMeta, TranscriptCue, SilenceSegment } from '../services/claude.service.js';

export interface DirectorOutput {
  summary: string;
  strategy: string;
  reasoning: string;
  segments: { start: number; end: number; label: string; score: number }[];
}

export async function runDirector(input: {
  meta: VideoMeta;
  transcript: TranscriptCue[];
  silences: SilenceSegment[];
  goal?: string;
  creatorProfile?: string;
}) {
  return callAgent<DirectorOutput>({
    name: 'Director',
    system:
      'You are the DIRECTOR agent of a multi-agent video editor. From the transcript ' +
      'and signals you set the creative direction: a one-paragraph summary, an editing ' +
      'strategy, your reasoning, and the candidate segments worth keeping (8-60s each, ' +
      'ranked by score 0-1). Other agents depend on your segment choices. Always call submit_direction.',
    tool: {
      name: 'submit_direction',
      description: 'Submit the creative direction and chosen segments.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          strategy: { type: 'string' },
          reasoning: { type: 'string' },
          segments: {
            type: 'array',
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
        },
        required: ['summary', 'strategy', 'reasoning', 'segments'],
      },
    },
    user: [
      input.creatorProfile ?? '',
      `META: ${JSON.stringify(input.meta)}`,
      `SILENCES: ${JSON.stringify(input.silences)}`,
      input.goal ? `GOAL: ${input.goal}` : 'GOAL: produce engaging short-form content',
      `TRANSCRIPT: ${JSON.stringify(input.transcript)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
}
