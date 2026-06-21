import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';

export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Run one focused agent: a single Claude call that MUST answer by filling a
 * tool's schema, so the output is always well-typed. Each specialist agent in
 * this folder is a thin wrapper around this.
 */
export async function callAgent<T>(opts: {
  name: string;
  system: string;
  tool: Anthropic.Tool;
  user: string;
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}): Promise<{ output: T; ms: number }> {
  const t0 = Date.now();
  const client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : anthropic;
  const message = await client.messages.create({
    model: opts.model ?? env.CLAUDE_MODEL,
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.system,
    tools: [opts.tool],
    tool_choice: { type: 'tool', name: opts.tool.name },
    messages: [{ role: 'user', content: opts.user }],
  });
  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) throw new Error(`${opts.name} returned no structured output`);
  return { output: toolUse.input as T, ms: Date.now() - t0 };
}
