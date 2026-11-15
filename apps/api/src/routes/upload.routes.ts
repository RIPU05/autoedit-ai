import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { startMultipart, presignUploadPart, completeMultipart, abortMultipart } from '../lib/s3.js';
import { requireAuth, asyncHandler, HttpError } from '../middleware/auth.js';
import { probe } from '../ffmpeg/probe.js';
import { enqueueAnalysis } from '../queue/queues.js';
import { presignDownload } from '../lib/s3.js';
import { env } from '../config/env.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dispatchIntegrationEvent } from '../services/integration-events.service.js';
import {
  registerUploadSession,
  getUploadSession,
  clearUploadSession,
} from '../services/upload-session.service.js';

export const uploadRouter = Router();
uploadRouter.use(requireAuth);

function verifyKeyOwnership(key: string, userId: string) {
  if (!key.startsWith('sources/')) {
    throw new HttpError(403, 'forbidden: s3 key must be within sources/ prefix');
  }
  const parts = key.split('/');
  // If key follows standard sources/<userId>/... convention, enforce that userId matches
  if (parts.length >= 3 && parts[1] !== userId) {
    throw new HttpError(403, 'forbidden: s3 key does not belong to user');
  }
}

// 1. Begin a multipart upload, register session, and create the project shell.
uploadRouter.post(
  '/start',
  asyncHandler(async (req, res) => {
    const { filename, contentType, title } = z
      .object({ filename: z.string().min(1), contentType: z.string().min(1), title: z.string().optional() })
      .parse(req.body);

    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadSessionId = randomUUID();
    const key = `sources/${req.user!.sub}/${uploadSessionId}/${safeFilename}`;
    const { uploadId, bucket } = await startMultipart(key, contentType);

    const project = await prisma.project.create({
      data: { userId: req.user!.sub, title: title ?? filename, status: 'UPLOADING' },
    });

    await registerUploadSession({
      projectId: project.id,
      userId: req.user!.sub,
      uploadId,
      key,
      bucket,
    });

    void dispatchIntegrationEvent(req.user!.sub, 'project.created', {
      projectId: project.id,
      projectTitle: project.title,
    });

    res.json({ projectId: project.id, key, bucket, uploadId });
  }),
);

// 2. Get a presigned URL for one part. Enforces user ownership of the S3 key prefix.
uploadRouter.post(
  '/part',
  asyncHandler(async (req, res) => {
    const { key, uploadId, partNumber, projectId } = z
      .object({
        key: z.string(),
        uploadId: z.string(),
        partNumber: z.number().int().positive(),
        projectId: z.string().optional(),
      })
      .parse(req.body);

    verifyKeyOwnership(key, req.user!.sub);

    const session = await getUploadSession(uploadId);
    if (session) {
      if (session.userId !== req.user!.sub) {
        throw new HttpError(403, 'forbidden: upload does not belong to user');
      }
      if (session.key !== key) {
        throw new HttpError(400, 's3 key does not match upload session');
      }
      if (projectId && session.projectId !== projectId) {
        throw new HttpError(400, 'upload does not belong to this project');
      }
    }

    const url = await presignUploadPart(key, uploadId, partNumber);
    res.json({ url });
  }),
);

// 3. Complete: verify project ownership, key ownership, session integrity, stitch parts, probe metadata, enqueue analysis.
uploadRouter.post(
  '/complete',
  asyncHandler(async (req, res) => {
    const { projectId, key, uploadId, parts, contentType, sizeBytes } = z
      .object({
        projectId: z.string(),
        key: z.string(),
        uploadId: z.string(),
        contentType: z.string(),
        sizeBytes: z.number(),
        parts: z.array(z.object({ ETag: z.string(), PartNumber: z.number() })),
      })
      .parse(req.body);

    // 1. Verify project exists and caller owns it
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, userId: true, title: true, status: true },
    });

    if (!project) {
      throw new HttpError(404, 'project not found');
    }

    if (project.userId !== req.user!.sub) {
      throw new HttpError(403, 'forbidden: you do not own this project');
    }

    // 2. Reject duplicate or invalid state completion
    if (project.status !== 'UPLOADING') {
      throw new HttpError(409, 'upload already completed');
    }

    // 3. Verify S3 key ownership
    verifyKeyOwnership(key, req.user!.sub);

    // 4. Verify upload session integrity
    const session = await getUploadSession(uploadId);
    if (!session) {
      throw new HttpError(400, 'upload session not found or expired');
    }
    if (session.userId !== req.user!.sub) {
      throw new HttpError(403, 'forbidden: upload does not belong to user');
    }
    if (session.projectId !== projectId) {
      throw new HttpError(400, 'upload does not belong to this project');
    }
    if (session.key !== key) {
      throw new HttpError(400, 's3 key does not match upload session');
    }

    await completeMultipart(key, uploadId, parts);
    await clearUploadSession(uploadId);

    // Metadata probing is useful but must not make a completed S3 upload fail.
    const tmp = path.join(env.RENDER_WORK_DIR, `${projectId}-probe.mp4`);
    const meta = await (async () => {
      try {
        await fs.mkdir(env.RENDER_WORK_DIR, { recursive: true });
        const dl = await fetch(await presignDownload(key), { signal: AbortSignal.timeout(30_000) });
        if (!dl.ok) throw new Error(`probe download failed: ${dl.status}`);
        await fs.writeFile(tmp, Buffer.from(await dl.arrayBuffer()));
        return await probe(tmp);
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'upload.probe_metadata_failed',
            projectId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return null;
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    })();

    const asset = await prisma.asset.create({
      data: {
        kind: 'SOURCE_VIDEO',
        s3Key: key,
        bucket: env.S3_BUCKET,
        mimeType: contentType,
        sizeBytes: BigInt(sizeBytes),
        durationSec: meta?.durationSec,
        width: meta?.width,
        height: meta?.height,
        fps: meta?.fps,
      },
    });

    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'UPLOADED', sourceAssetId: asset.id },
    });

    const job = await enqueueAnalysis({ projectId, s3Key: key, bucket: env.S3_BUCKET });
    await prisma.job.create({
      data: { bullId: job.id, projectId, type: 'ANALYZE', status: 'QUEUED' },
    });

    void dispatchIntegrationEvent(project.userId, 'upload.completed', {
      projectId,
      projectTitle: project.title,
      assetId: asset.id,
      metadata: { s3Key: key, contentType, sizeBytes },
    });

    res.json({ projectId, assetId: asset.id, analysisJobId: job.id });
  }),
);

// 4. Abort: verify key ownership, project ownership, session integrity, and abort S3 upload.
uploadRouter.post(
  '/abort',
  asyncHandler(async (req, res) => {
    const { key, uploadId, projectId } = z
      .object({ key: z.string(), uploadId: z.string(), projectId: z.string().optional() })
      .parse(req.body);

    verifyKeyOwnership(key, req.user!.sub);

    if (projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, userId: true, status: true },
      });
      if (!project) throw new HttpError(404, 'project not found');
      if (project.userId !== req.user!.sub) throw new HttpError(403, 'forbidden: you do not own this project');
      if (project.status === 'UPLOADING') {
        await prisma.project.update({ where: { id: projectId }, data: { status: 'FAILED' } }).catch(() => {});
      }
    }

    const session = await getUploadSession(uploadId);
    if (session) {
      if (session.userId !== req.user!.sub) {
        throw new HttpError(403, 'forbidden: upload does not belong to user');
      }
      if (session.key !== key) {
        throw new HttpError(400, 's3 key does not match upload session');
      }
      if (projectId && session.projectId !== projectId) {
        throw new HttpError(400, 'upload does not belong to this project');
      }
    }

    await abortMultipart(key, uploadId);
    await clearUploadSession(uploadId);

    res.json({ ok: true });
  }),
);
