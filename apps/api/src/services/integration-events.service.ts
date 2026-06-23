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

export type N8nEventPayload = {
  eventType: IntegrationEventType;
  projectId?: string;
  userId: string;
  assetId?: string;
  renderId?: string;
  renderFormat?: 'short' | 'reel' | 'landscape';
  outputS3Key?: string;
  renderUrl?: string;
  renderUrlExpiresAt?: string;
  expiresInSeconds?: number;
  projectTitle?: string;
  createdAt?: string;
  timestamp: string;
  metadata: Record<string, unknown>;
};

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

async function postWithRetry(url: string, body: string, headers: Record<string, string>) {
  let lastError: { message: string; statusCode?: number } | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      const text = await res.text();
      if (res.ok) {
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : { ok: true };
        } catch {
          parsed = { ok: true, body: text.slice(0, 500) };
        }
        return { statusCode: res.status, response: parsed };
      }
      lastError = { message: `n8n webhook ${res.status}: ${text.slice(0, 500)}`, statusCode: res.status };
    } catch (err) {
      lastError = { message: err instanceof Error ? err.message : String(err) };
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  const error = new Error(lastError?.message ?? 'n8n webhook failed') as Error & { statusCode?: number };
  error.statusCode = lastError?.statusCode;
  throw error;
}

export async function dispatchIntegrationEvent(
  userId: string,
  eventType: IntegrationEventType,
  payload: Partial<Omit<N8nEventPayload, 'eventType' | 'userId' | 'timestamp' | 'metadata'>> & {
    metadata?: Record<string, unknown>;
  },
) {
  const eventPayload = {
    eventType,
    userId,
    projectId: payload.projectId,
    assetId: payload.assetId,
    renderId: payload.renderId,
    renderFormat: payload.renderFormat,
    outputS3Key: payload.outputS3Key,
    renderUrl: payload.renderUrl,
    renderUrlExpiresAt: payload.renderUrlExpiresAt,
    expiresInSeconds: payload.expiresInSeconds,
    projectTitle: payload.projectTitle,
    createdAt: payload.createdAt,
    timestamp: new Date().toISOString(),
    metadata: payload.metadata ?? {},
  } satisfies N8nEventPayload;
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

    const delivered = await postWithRetry(credentials.webhookUrl, body, headers);
    await prisma.integrationEventLog.create({
      data: {
        userId,
        provider: 'N8N',
        eventType,
        status: 'SUCCESS',
        projectId: eventPayload.projectId,
        renderId: eventPayload.renderId,
        responseStatusCode: delivered.statusCode,
        payload: toJson(eventPayload),
        response: toJson(delivered.response),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const responseStatusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : undefined;
    await prisma.integrationEventLog
      .create({
        data: {
          userId,
          provider: 'N8N',
          eventType,
          status: 'ERROR',
          projectId: eventPayload.projectId,
          renderId: eventPayload.renderId,
          responseStatusCode,
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
