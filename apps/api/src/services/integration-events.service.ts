import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { decryptJson } from './integration-crypto.service.js';

type N8nCredentials = {
  webhookUrl: string;
  signingSecret?: string;
};

export type IntegrationEventType =
  | 'project.created'
  | 'upload.completed'
  | 'transcript.completed'
  | 'render.completed'
  | 'render.failed';

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

async function postWithRetry(url: string, body: string, headers: Record<string, string>) {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      const text = await res.text();
      if (res.ok) {
        try {
          return text ? JSON.parse(text) : { ok: true };
        } catch {
          return { ok: true, body: text.slice(0, 500) };
        }
      }
      lastError = new Error(`n8n webhook ${res.status}: ${text.slice(0, 500)}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw lastError ?? new Error('n8n webhook failed');
}

export async function dispatchIntegrationEvent(userId: string, eventType: IntegrationEventType, payload: Record<string, unknown>) {
  const eventPayload = {
    eventType,
    userId,
    payload,
    sentAt: new Date().toISOString(),
  };
  const body = JSON.stringify(eventPayload);

  try {
    const account = await prisma.integrationAccount.findUnique({
      where: { userId_provider: { userId, provider: 'N8N' } },
    });
    if (!account || account.status !== 'CONNECTED') return;

    const credentials = decryptJson<N8nCredentials>(account.encryptedCredentials);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credentials.signingSecret) {
      headers['X-AutoEdit-Signature'] = crypto.createHmac('sha256', credentials.signingSecret).update(body).digest('hex');
    }

    const response = await postWithRetry(credentials.webhookUrl, body, headers);
    await prisma.integrationEventLog.create({
      data: {
        userId,
        provider: 'N8N',
        eventType,
        status: 'SUCCESS',
        payload: toJson(eventPayload),
        response: toJson(response),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.integrationEventLog
      .create({
        data: {
          userId,
          provider: 'N8N',
          eventType,
          status: 'ERROR',
          payload: toJson(eventPayload),
          error: message,
        },
      })
      .catch(() => {});
    console.warn(JSON.stringify({ level: 'warn', msg: 'integration.n8n.dispatch_failed', userId, eventType, error: message }));
  }
}

export async function getConnectedClaudeApiKey(userId: string) {
  const account = await prisma.integrationAccount.findUnique({
    where: { userId_provider: { userId, provider: 'CLAUDE' } },
  });
  if (!account || account.status !== 'CONNECTED') return undefined;
  const credentials = decryptJson<{ apiKey: string }>(account.encryptedCredentials);
  return credentials.apiKey;
}
