import { Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bullConnection as connection } from '../../lib/redis.js';
import { prisma } from '../../lib/prisma.js';
import { presignDownload } from '../../lib/s3.js';
import { probe, detectSilences, extractAudio } from '../../ffmpeg/probe.js';
import { type TranscriptCue } from '../../services/claude.service.js';
import { transcribeRich } from '../../services/transcribe.service.js';
import { createVersion } from '../../services/version.service.js';
import { buildPromptInjection } from '../../services/creator-memory.service.js';
import { timeStage, captureError, isInvalidJsonError } from '../../lib/observability.js';
import { moveToDeadLetter } from '../queues.js';
import { env } from '../../config/env.js';
import { ANALYSIS_QUEUE, type AnalysisJobData, enqueueRender } from '../queues.js';
import { runAiProvider } from '../../ai/providers.js';
import { dispatchIntegrationEvent, getConnectedClaudeApiKey } from '../../services/integration-events.service.js';

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

async function enqueueAutomaticRenders(projectId: string, aiProvider: string) {
  const formats = [
    { platform: 'shorts', format: 'short' as const },
    { platform: 'reels', format: 'reel' as const },
    { platform: 'youtube', format: 'landscape' as const },
  ];

  for (const { platform, format } of formats) {
    const render = await prisma.render.create({ data: { projectId, format, status: 'QUEUED' } });
    const renderJob = await enqueueRender({ projectId, renderId: render.id, format });
    await prisma.job.create({
      data: {
        bullId: renderJob.id,
        projectId,
        type: 'RENDER',
        status: 'QUEUED',
        payload: { platform, aiProvider },
      },
    });
  }
}

export const analysisWorker = new Worker<AnalysisJobData>(
  ANALYSIS_QUEUE,
  async (job) => {
    const { projectId, s3Key } = job.data;
    const workDir = path.join(env.RENDER_WORK_DIR, projectId);
    await fs.mkdir(workDir, { recursive: true });
    const localVideo = path.join(workDir, 'source.mp4');

    await prisma.project.update({ where: { id: projectId }, data: { status: 'ANALYZING' } });

    // 1. pull source from S3
    const sourceUrl = await presignDownload(s3Key);
    await timeStage('download', projectId, () => download(sourceUrl, localVideo));

    // 2. probe + silence detection (FFmpeg)
    const meta = await timeStage('probe', projectId, () => probe(localVideo));
    const silences = await timeStage('silence', projectId, () => detectSilences(localVideo));

    // 3. transcribe audio (rich: words + confidence + language)
    const audioPath = path.join(workDir, 'audio.wav');
    await extractAudio(localVideo, audioPath);
    const tr = await timeStage('transcription', projectId, () => transcribeRich(audioPath));
    await job.updateProgress(40);

    // persist transcript
    await prisma.transcript.upsert({
      where: { projectId },
      create: {
        projectId,
        language: tr.language,
        durationSec: tr.durationSec,
        segments: tr.segments as object,
        words: tr.words as object,
        avgConfidence: tr.avgConfidence,
        model: tr.model,
      },
      update: {
        language: tr.language,
        durationSec: tr.durationSec,
        segments: tr.segments as object,
        words: tr.words as object,
        avgConfidence: tr.avgConfidence,
        model: tr.model,
      },
    });
    const transcript: TranscriptCue[] = tr.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker }));

    // creator memory → prompt injection
    const proj0 = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true, title: true } });
    const creatorProfile = proj0 ? await buildPromptInjection(proj0.userId) : undefined;
    if (proj0) {
      void dispatchIntegrationEvent(proj0.userId, 'transcript.completed', {
        projectId,
        title: proj0.title,
        language: tr.language,
        durationSec: tr.durationSec,
        segments: tr.segments.length,
      });
    }
    const claudeApiKey = proj0 ? await getConnectedClaudeApiKey(proj0.userId).catch(() => undefined) : undefined;

    // 4. AI provider pipeline (timed); selected provider falls back only for known unavailable states.
    const ai = await timeStage('analysis', projectId, () =>
      runAiProvider({ meta, transcript, silences, goal: job.data.userPrompt, creatorProfile, claudeApiKey }),
    );
    if (ai.fallback) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'analysis.fallback', projectId, reason: ai.reason }));
      await captureError(env.AI_PROVIDER === 'ollama' ? 'OLLAMA' : 'CLAUDE', new Error(ai.reason ?? 'AI unavailable'), {
        projectId,
        jobId: job.id,
      });
      if (env.AI_PROVIDER === 'ollama') console.warn('Ollama failed, using fallback timeline');
    }
    const result = ai.result;
    await job.updateProgress(85);

    // normalize editor operations (clamp, order)
    const operations = result.operations
      .map((o, i) => ({
        index: typeof o.index === 'number' ? o.index : i,
        start: Math.max(0, Math.min(o.start, meta.durationSec)),
        end: Math.max(0, Math.min(o.end, meta.durationSec)),
        label: o.label,
        keep: o.keep ?? true,
        zoom: o.zoom ?? 1.08,
      }))
      .filter((o) => o.end > o.start)
      .sort((a, b) => a.index - b.index)
      .map((o, i) => ({ ...o, index: i }));

    // 5. persist analysis (agent outputs)
    const analysisData = {
      summary: result.summary,
      highlights: result.highlights as Prisma.InputJsonValue,
      silences: silences as unknown as Prisma.InputJsonValue,
      speakers: result.speakers as Prisma.InputJsonValue,
      captions: result.captions as Prisma.InputJsonValue,
      suggestedTitles: result.suggestedTitles as Prisma.InputJsonValue,
      socialCopy: result.socialCopy as Prisma.InputJsonValue,
      hook: result.hook as unknown as Prisma.InputJsonValue,
      thumbnail: result.thumbnail as unknown as Prisma.InputJsonValue,
      agentLog: result.agentLog as unknown as Prisma.InputJsonValue,
      strategy: result.strategy,
      model: result.model,
    };
    await prisma.analysis.upsert({
      where: { projectId },
      create: { projectId, ...analysisData },
      update: analysisData,
    });

    // 6. seed editable timeline directly from the Editor agent
    await prisma.editTimeline.upsert({
      where: { projectId },
      create: {
        projectId,
        operations: operations as Prisma.InputJsonValue,
        effects: result.effects as Prisma.InputJsonValue,
        outputs: [
          { platform: 'shorts', format: 'short', aspect: '9:16', maxDurationSec: 60 },
          { platform: 'reels', format: 'reel', aspect: '9:16', maxDurationSec: 60 },
          { platform: 'youtube', format: 'landscape', aspect: '16:9', maxDurationSec: 600 },
        ] as Prisma.InputJsonValue,
        approved: ai.provider !== 'claude',
      },
      update: {},
    });

    // 7. seed the root version
    const existingRoot = await prisma.editVersion.findFirst({ where: { projectId } });
    if (!existingRoot) {
      await createVersion({
        projectId,
        name: 'Original AI cut',
        timeline: { operations, effects: result.effects },
        aiExplanation: result.strategy || result.summary,
        changes: result.agentLog.map((a) => ({
          action: 'kept' as const,
          target: `${a.agent} agent`,
          reasons: [a.summary],
        })),
        parentVersionId: null,
      });
    }

    await prisma.project.update({ where: { id: projectId }, data: { status: 'ANALYZED' } });

    if (ai.provider !== 'claude') {
      await enqueueAutomaticRenders(projectId, ai.provider);
      await prisma.project.update({ where: { id: projectId }, data: { status: 'RENDERING' } });
    }

    // 8. activity feed: one line per agent (transparency)
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (project) {
      await prisma.activityLog.createMany({
        data: result.agentLog.map((a) => ({
          userId: project.userId,
          projectId,
          kind: 'agent',
          message: `${a.agent} agent (${a.ms}ms): ${a.summary}`,
        })),
      });
    }

    return { highlights: result.highlights.length, agents: result.agentLog.length, provider: ai.provider, fallback: ai.fallback };
  },
  { connection, concurrency: env.ANALYSIS_CONCURRENCY, lockDuration: env.ANALYSIS_LOCK_DURATION_MS },
);

analysisWorker.on('failed', async (job, err) => {
  if (!job) return;
  const category = isInvalidJsonError(err) ? 'INVALID_JSON' : 'CLAUDE';
  await captureError(category, err, { projectId: job.data.projectId, jobId: job.id });
  await prisma.project.update({ where: { id: job.data.projectId }, data: { status: 'FAILED' } }).catch(() => {});
  // out of retries → park in the dead-letter queue for inspection/replay
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await moveToDeadLetter(ANALYSIS_QUEUE, job.data, err.message).catch(() => {});
  }
});
