import { Worker } from 'bullmq';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { bullConnection as connection } from '../../lib/redis.js';
import { prisma } from '../../lib/prisma.js';
import { presignDownload, putObject } from '../../lib/s3.js';
import { renderEdit, buildKeepSegments, type EditPlan } from '../../ffmpeg/pipeline.js';
import { enqueueN8n, moveToDeadLetter } from '../queues.js';
import { env } from '../../config/env.js';
import { timeStage, captureError, withTimeout } from '../../lib/observability.js';
import { learnFromProject } from '../../services/creator-memory.service.js';
import { RENDER_QUEUE, type RenderJobData } from '../queues.js';
import { dispatchIntegrationEvent } from '../../services/integration-events.service.js';

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export const renderWorker = new Worker<RenderJobData>(
  RENDER_QUEUE,
  async (job) => {
    const { projectId, renderId, format } = job.data;
    const workDir = path.join(env.RENDER_WORK_DIR, projectId, renderId);
    await fs.mkdir(workDir, { recursive: true });

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { analysis: true, timeline: true, sourceAsset: true },
    });
    if (!project?.analysis || !project.timeline || !project.sourceAsset) {
      throw new Error('project not ready for render');
    }

    await prisma.render.update({
      where: { id: renderId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // 1. pull source
    const localVideo = path.join(workDir, 'source.mp4');
    await download(await presignDownload(project.sourceAsset.s3Key), localVideo);

    // 2. build edit plan from the user-approved timeline (source of truth),
    //    falling back to auto-derivation from analysis only when empty.
    const analysis = project.analysis;
    const effects = project.timeline.effects as any;
    const operations = (project.timeline.operations as any[]) ?? [];

    // operations the user kept, in their chosen order
    const editedKeep = operations
      .filter((op) => op.keep !== false && typeof op.start === 'number' && typeof op.end === 'number')
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((op) => ({
        start: op.start as number,
        end: op.end as number,
        zoom: effects.zooms ? (op.zoom ?? 1.08) : 1,
      }));

    const isShort = format === 'reel' || format === 'short';
    const keep =
      editedKeep.length > 0
        ? editedKeep
        : buildKeepSegments(
            project.sourceAsset.durationSec ?? 0,
            analysis.silences as { start: number; end: number }[],
            isShort
              ? { highlightsOnly: (analysis.highlights as any[]).slice(0, 3).map((h) => ({ start: h.start, end: h.end })) }
              : {},
          );

    const plan: EditPlan = {
      source: localVideo,
      keep,
      captions: effects.subtitles ? (analysis.captions as any[]) : [],
      transition: effects.transitions === 'fade' ? 'fade' : 'none',
      musicPath: undefined, // TODO: download chosen music asset if effects.music
      musicVolume: 0.15,
      format,
    };

    // 3. render with progress reporting, under a hard timeout (Phase 6)
    const outPath = await timeStage('render', projectId, () =>
      withTimeout(
        renderEdit(plan, workDir, async (pct) => {
          await prisma.render.update({ where: { id: renderId }, data: { progress: pct } }).catch(() => {});
          await job.updateProgress(pct);
        }),
        env.RENDER_TIMEOUT_MS,
        'render',
      ),
    );

    // 4. upload result to S3
    const outKey = `renders/${projectId}/${renderId}-${format}.mp4`;
    await putObject(outKey, createReadStream(outPath), 'video/mp4');
    const outputUrl = await presignDownload(outKey);

    await prisma.render.update({
      where: { id: renderId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        outputS3Key: outKey,
        outputUrl,
        finishedAt: new Date(),
      },
    });
    await prisma.project.update({ where: { id: projectId }, data: { status: 'RENDERED' } });
    await prisma.activityLog.create({
      data: {
        userId: project.userId,
        projectId,
        kind: 'render',
        message: `Rendered ${format} for "${project.title}".`,
      },
    });
    void dispatchIntegrationEvent(project.userId, 'render.completed', {
      projectId,
      renderId,
      renderFormat: format,
      renderUrl: outputUrl,
      projectTitle: project.title,
      metadata: { outputS3Key: outKey },
    });

    // creator memory: a completed render is a strong signal of shipped taste
    void learnFromProject(projectId);

    // 5. fire n8n workflow (publish) if the user connected one
    const conn = await prisma.n8nConnection.findUnique({ where: { userId: project.userId } });
    if (conn?.defaultWorkflowId) {
      const run = await prisma.workflowRun.create({
        data: {
          connectionId: conn.id,
          projectId,
          workflowId: conn.defaultWorkflowId,
          status: 'TRIGGERED',
          payload: { renderId, outputUrl, format },
        },
      });
      await enqueueN8n({
        connectionId: conn.id,
        workflowRunId: run.id,
        webhookPath: conn.defaultWorkflowId,
        payload: {
          projectId,
          title: project.title,
          format,
          videoUrl: outputUrl,
          socialCopy: analysis.socialCopy,
          titles: analysis.suggestedTitles,
        },
      });
    }

    // cleanup scratch files
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { outKey };
  },
  { connection, concurrency: env.RENDER_CONCURRENCY }, // scale horizontally, not per-process
);

renderWorker.on('failed', async (job, err) => {
  if (!job) return;
  const category = /timed out/i.test(err.message) ? 'RENDER_TIMEOUT' : 'FFMPEG';
  await captureError(category, err, { projectId: job.data.projectId, jobId: job.id });
  await prisma.render
    .update({ where: { id: job.data.renderId }, data: { status: 'FAILED', error: err.message } })
    .catch(() => {});
  const project = await prisma.project.findUnique({
    where: { id: job.data.projectId },
    select: { userId: true, title: true },
  });
  if (project) {
    void dispatchIntegrationEvent(project.userId, 'render.failed', {
      projectId: job.data.projectId,
      renderId: job.data.renderId,
      renderFormat: job.data.format,
      projectTitle: project.title,
      metadata: { error: err.message },
    });
  }
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await moveToDeadLetter(RENDER_QUEUE, job.data, err.message).catch(() => {});
  }
});
