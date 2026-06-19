import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * n8n integration.
 *
 * Outbound: we call the n8n REST API to list workflows and trigger them, OR we
 * POST to a workflow's Webhook node. Most teams use the Webhook-node pattern
 * because it doesn't require the n8n Public API to be enabled.
 *
 * Inbound: n8n calls us back at POST /api/webhooks/n8n with an HMAC signature so
 * we can update WorkflowRun status. See verifyWebhookSignature().
 */

interface N8nConfig {
  baseUrl: string;
  apiKey?: string;
}

function headers(cfg: N8nConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['X-N8N-API-KEY'] = cfg.apiKey;
  return h;
}

/** List workflows via the n8n Public API (requires API key + public API enabled). */
export async function listWorkflows(cfg: N8nConfig) {
  const res = await fetch(`${cfg.baseUrl}/api/v1/workflows`, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`n8n list workflows failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: Array<{ id: string; name: string; active: boolean }> };
  return data.data;
}

/** Activate a workflow (so its webhook/trigger is live). */
export async function activateWorkflow(cfg: N8nConfig, workflowId: string) {
  const res = await fetch(`${cfg.baseUrl}/api/v1/workflows/${workflowId}/activate`, {
    method: 'POST',
    headers: headers(cfg),
  });
  if (!res.ok) throw new Error(`n8n activate failed: ${res.status}`);
  return res.json();
}

/**
 * Trigger a workflow by POSTing to its Webhook node path.
 * `webhookPath` is the path configured on the n8n Webhook node, e.g. "autoedit-publish".
 * We sign the body so the n8n workflow can verify it came from us.
 */
export async function triggerWebhook(
  cfg: N8nConfig,
  webhookPath: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify(payload);
  const signature = sign(body, env.N8N_WEBHOOK_SECRET);
  const res = await fetch(`${cfg.baseUrl}/webhook/${webhookPath}`, {
    method: 'POST',
    headers: { ...headers(cfg), 'X-AutoEdit-Signature': signature },
    body,
  });
  if (!res.ok) throw new Error(`n8n webhook trigger failed: ${res.status} ${await res.text()}`);
  // n8n may return the execution result synchronously or just an ack.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ack: text };
  }
}

/** HMAC helpers shared by outbound trigger + inbound webhook verification. */
export function sign(body: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyWebhookSignature(body: string, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const expected = sign(body, secret);
  // constant-time compare
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
