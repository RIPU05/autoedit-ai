import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { startMultipart, presignUploadPart, completeMultipart, abortMultipart } from '../lib/s3.js';
import { requireAuth, asyncHandler } from '../middleware/auth.js';
import { probe } from '../ffmpeg/probe.js';
import { enqueueAnalysis } from '../queue/queues.js';
import { presignDownload } from '../lib/s3.js';
import { env } from '../config/env.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dispatchIntegrationEvent } from '../services/integration-events.service.js';

export const uploadRouter = Router();
uploadRouter.use(requireAuth);

// 1. Begin a multipart upload and create the project shell.
uploadRouter.post(
  '/start',
  asyncHandler(async (req, res) => {
    const { filename, contentType, title } = z
      .object({ filename: z.string(), contentType: z.string(), title: z.string().optional() })
      .parse(req.body);

    const key = `sources/${req.user!.sub}/${randomUUID()}/${filename}`;
    const { uploadId, bucket } = await startMultipart(key, contentType);

    const project = await prisma.project.create({
      data: { userId: req.user!.sub, title: title ?? filename, status: 'UPLOADING' },
    });
    void dispatchIntegrationEvent(req.user!.sub, 'project.created', {
      projectId: project.id,
      projectTitle: project.title,
    });

    res.json({ projectId: project.id, key, bucket, uploadId });
  }),
);

// 2. Get a presigned URL for one part. The browser PUTs the chunk directly to S3.
uploadRouter.post(
  '/part',
  asyncHandler(async (req, res) => {
    const { key, uploadId, partNumber } = z
      .object({ key: z.string(), uploadId: z.string(), partNumber: z.number().int().positive() })
      .parse(req.body);
    const url = await presignUploadPart(key, uploadId, partNumber);
    res.json({ url });
  }),
);

// 3. Complete: stitch parts, record the asset, probe metadata, enqueue analysis.
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

    await completeMultipart(key, uploadId, parts);

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
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true, title: true } });
    if (project) {
      void dispatchIntegrationEvent(project.userId, 'upload.completed', {
        projectId,
        projectTitle: project.title,
        assetId: asset.id,
        metadata: { s3Key: key, contentType, sizeBytes },
      });
    }

    res.json({ projectId, assetId: asset.id, analysisJobId: job.id });
  }),
);

uploadRouter.post(
  '/abort',
  asyncHandler(async (req, res) => {
    const { key, uploadId } = z.object({ key: z.string(), uploadId: z.string() }).parse(req.body);
    await abortMultipart(key, uploadId);
    res.json({ ok: true });
  }),
);
