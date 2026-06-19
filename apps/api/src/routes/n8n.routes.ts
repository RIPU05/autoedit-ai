import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, asyncHandler, HttpError } from '../middleware/auth.js';
import { listWorkflows, verifyWebhookSignature } from '../services/n8n.service.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

export const n8nRouter = Router();

// ─── Authenticated management endpoints ───────────────────────────────────────
const authed = Router();
authed.use(requireAuth);

// Connect / update an n8n instance for the current user
authed.post(
  '/connect',
  asyncHandler(async (req, res) => {
    const { baseUrl, apiKey } = z
      .object({ baseUrl: z.string().url(), apiKey: z.string() })
      .parse(req.body);

    // validate by attempting to list workflows
    await listWorkflows({ baseUrl, apiKey }).catch(() => {
      throw new HttpError(400, 'could not reach n8n with those credentials');
    });

    const conn = await prisma.n8nConnection.upsert({
      where: { userId: req.user!.sub },
      create: {
        userId: req.user!.sub,
        baseUrl,
        apiKeyEnc: encrypt(apiKey),
        webhookSecret: randomBytes(24).toString('hex'),
      },
      update: { baseUrl, apiKeyEnc: encrypt(apiKey) },
    });
    res.json({ connected: true, connectionId: conn.id });
  }),
);

authed.get(
  '/workflows',
  asyncHandler(async (req, res) => {
    const conn = await prisma.n8nConnection.findUnique({ where: { userId: req.user!.sub } });
    if (!conn) throw new HttpError(404, 'no n8n connection');
    const workflows = await listWorkflows({ baseUrl: conn.baseUrl, apiKey: decrypt(conn.apiKeyEnc) });
    res.json({ workflows });
  }),
);

authed.post(
  '/default-workflow',
  asyncHandler(async (req, res) => {
    const { workflowId } = z.object({ workflowId: z.string() }).parse(req.body);
    await prisma.n8nConnection.update({
      where: { userId: req.user!.sub },
      data: { defaultWorkflowId: workflowId },
    });
    res.json({ ok: true });
  }),
);

n8nRouter.use(authed);

// ─── Inbound webhook from n8n (status callbacks) ──────────────────────────────
// Mount raw body so we can verify the HMAC signature.
export const webhookRouter = Router();

webhookRouter.post(
  '/n8n',
  asyncHandler(async (req, res) => {
    const signature = req.header('X-AutoEdit-Signature');
    const rawBody = (req as any).rawBody as string; // populated by express.json verify hook
    if (!verifyWebhookSignature(rawBody, signature, env.N8N_WEBHOOK_SECRET)) {
      throw new HttpError(401, 'invalid signature');
    }
    const { workflowRunId, status, result } = z
      .object({
        workflowRunId: z.string(),
        status: z.enum(['RUNNING', 'SUCCESS', 'ERROR']),
        result: z.any().optional(),
      })
      .parse(req.body);

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status, result },
    });
    res.json({ ok: true });
  }),
);
