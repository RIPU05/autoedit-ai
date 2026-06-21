import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { requireAuth, asyncHandler, HttpError } from '../middleware/auth.js';
import { encryptJson, decryptJson, maskSecret } from '../services/integration-crypto.service.js';
import { dispatchIntegrationEvent } from '../services/integration-events.service.js';

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

async function testClaudeKey(apiKey: string) {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) throw new HttpError(400, `Claude test failed: ${res.status}`);
}

function validateWebhookUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'invalid webhook URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'invalid webhook URL');
  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname.endsWith('.localhost');
  if (env.NODE_ENV !== 'development' && url.protocol !== 'https:') {
    throw new HttpError(400, 'webhook URL must use HTTPS outside development');
  }
  if (env.NODE_ENV !== 'development' && isLocal) throw new HttpError(400, 'localhost webhook URL is development-only');
  return url.toString();
}

function statusResponse(account: { status: string; metadata: unknown; lastTestedAt: Date | null } | null) {
  return {
    status: account?.status ?? 'DISCONNECTED',
    metadata: account?.metadata ?? {},
    lastTestedAt: account?.lastTestedAt ?? null,
  };
}

integrationsRouter.get(
  '/claude/status',
  asyncHandler(async (req, res) => {
    const account = await prisma.integrationAccount.findUnique({
      where: { userId_provider: { userId: req.user!.sub, provider: 'CLAUDE' } },
      select: { status: true, metadata: true, lastTestedAt: true },
    });
    res.json(statusResponse(account));
  }),
);

integrationsRouter.post(
  '/claude/connect',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ apiKey: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'api key is required');
    const { apiKey } = parsed.data;
    await testClaudeKey(apiKey);
    const account = await prisma.integrationAccount.upsert({
      where: { userId_provider: { userId: req.user!.sub, provider: 'CLAUDE' } },
      create: {
        userId: req.user!.sub,
        provider: 'CLAUDE',
        status: 'CONNECTED',
        encryptedCredentials: encryptJson({ apiKey }),
        metadata: { key: maskSecret(apiKey) },
        lastTestedAt: new Date(),
      },
      update: {
        status: 'CONNECTED',
        encryptedCredentials: encryptJson({ apiKey }),
        metadata: { key: maskSecret(apiKey) },
        lastTestedAt: new Date(),
      },
      select: { status: true, metadata: true, lastTestedAt: true },
    });
    res.json(statusResponse(account));
  }),
);

integrationsRouter.post(
  '/claude/test',
  asyncHandler(async (req, res) => {
    const account = await prisma.integrationAccount.findUnique({
      where: { userId_provider: { userId: req.user!.sub, provider: 'CLAUDE' } },
    });
    if (!account || account.status === 'DISCONNECTED') throw new HttpError(400, 'Claude is not connected');
    const credentials = decryptJson<{ apiKey: string }>(account.encryptedCredentials);
    await testClaudeKey(credentials.apiKey);
    const updated = await prisma.integrationAccount.update({
      where: { id: account.id },
      data: { status: 'CONNECTED', lastTestedAt: new Date(), metadata: { key: maskSecret(credentials.apiKey) } },
      select: { status: true, metadata: true, lastTestedAt: true },
    });
    res.json(statusResponse(updated));
  }),
);

integrationsRouter.delete(
  '/claude/disconnect',
  asyncHandler(async (req, res) => {
    await prisma.integrationAccount.upsert({
      where: { userId_provider: { userId: req.user!.sub, provider: 'CLAUDE' } },
      create: {
        userId: req.user!.sub,
        provider: 'CLAUDE',
        status: 'DISCONNECTED',
        encryptedCredentials: encryptJson({}),
        metadata: {},
      },
      update: { status: 'DISCONNECTED', encryptedCredentials: encryptJson({}), metadata: {} },
    });
    res.json({ status: 'DISCONNECTED' });
  }),
);

integrationsRouter.get(
  '/n8n/status',
  asyncHandler(async (req, res) => {
    const account = await prisma.integrationAccount.findUnique({
      where: { userId_provider: { userId: req.user!.sub, provider: 'N8N' } },
      select: { status: true, metadata: true, lastTestedAt: true },
    });
    res.json(statusResponse(account));
  }),
);

integrationsRouter.post(
  '/n8n/connect',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        webhookUrl: z.string().min(1),
        signingSecret: z.string().optional(),
        workflowName: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'webhook URL is required');
    const body = parsed.data;
    const webhookUrl = validateWebhookUrl(body.webhookUrl);
    const account = await prisma.integrationAccount.upsert({
      where: { userId_provider: { userId: req.user!.sub, provider: 'N8N' } },
      create: {
        userId: req.user!.sub,
        provider: 'N8N',
        status: 'CONNECTED',
        encryptedCredentials: encryptJson({ webhookUrl, signingSecret: body.signingSecret }),
        metadata: { webhookUrl, workflowName: body.workflowName ?? null, hasSigningSecret: Boolean(body.signingSecret) },
        lastTestedAt: null,
      },
      update: {
        status: 'CONNECTED',
        encryptedCredentials: encryptJson({ webhookUrl, signingSecret: body.signingSecret }),
        metadata: { webhookUrl, workflowName: body.workflowName ?? null, hasSigningSecret: Boolean(body.signingSecret) },
      },
      select: { status: true, metadata: true, lastTestedAt: true },
    });
    res.json(statusResponse(account));
  }),
);

integrationsRouter.post(
  '/n8n/test',
  asyncHandler(async (req, res) => {
    const existing = await prisma.integrationAccount.findUnique({
      where: { userId_provider: { userId: req.user!.sub, provider: 'N8N' } },
      select: { status: true },
    });
    if (!existing || existing.status === 'DISCONNECTED') throw new HttpError(400, 'n8n is not connected');
    await dispatchIntegrationEvent(req.user!.sub, 'project.created', { test: true, source: 'integration-test' });
    const account = await prisma.integrationAccount.update({
      where: { userId_provider: { userId: req.user!.sub, provider: 'N8N' } },
      data: { lastTestedAt: new Date() },
      select: { status: true, metadata: true, lastTestedAt: true },
    });
    res.json(statusResponse(account));
  }),
);

integrationsRouter.delete(
  '/n8n/disconnect',
  asyncHandler(async (req, res) => {
    await prisma.integrationAccount.upsert({
      where: { userId_provider: { userId: req.user!.sub, provider: 'N8N' } },
      create: {
        userId: req.user!.sub,
        provider: 'N8N',
        status: 'DISCONNECTED',
        encryptedCredentials: encryptJson({}),
        metadata: {},
      },
      update: { status: 'DISCONNECTED', encryptedCredentials: encryptJson({}), metadata: {} },
    });
    res.json({ status: 'DISCONNECTED' });
  }),
);
