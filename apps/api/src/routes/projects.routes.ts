import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, asyncHandler, HttpError } from '../middleware/auth.js';
import { enqueueRender } from '../queue/queues.js';
import { regenerateSocialCopy, editTimelineWithPrompt, explainClip } from '../services/claude.service.js';
import { createVersion, getHeadVersion, diffVersions, restoreVersion } from '../services/version.service.js';
import { presignDownload } from '../lib/s3.js';
import { buildPromptInjection, learnFromPromptEdit } from '../services/creator-memory.service.js';

export const projectRouter = Router();
projectRouter.use(requireAuth);

// helper: load a project owned by the caller or 404
async function ownedProject(userId: string, id: string) {
  const p = await prisma.project.findFirst({ where: { id, userId } });
  if (!p) throw new HttpError(404, 'project not found');
  return p;
}

// List projects (dashboard "recent projects")
projectRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projects = await prisma.project.findMany({
      where: { userId: req.user!.sub },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { renders: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    res.json({ projects });
  }),
);

// Full project detail (analysis + timeline + renders)
projectRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { analysis: true, timeline: true, renders: true, sourceAsset: true },
    });
    res.json({ project });
  }),
);

// Update the editable timeline (operations/effects/outputs) and approve it
projectRouter.patch(
  '/:id/timeline',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const body = z
      .object({
        operations: z.any().optional(),
        effects: z.any().optional(),
        outputs: z.any().optional(),
        approved: z.boolean().optional(),
      })
      .parse(req.body);
    const timeline = await prisma.editTimeline.update({
      where: { projectId: req.params.id },
      data: body,
    });
    res.json({ timeline });
  }),
);

// Kick off a render for a given output format
projectRouter.post(
  '/:id/render',
  asyncHandler(async (req, res) => {
    const project = await ownedProject(req.user!.sub, req.params.id);
    const { format } = z
      .object({ format: z.enum(['reel', 'short', 'landscape']) })
      .parse(req.body);

    const timeline = await prisma.editTimeline.findUnique({ where: { projectId: project.id } });
    if (!timeline?.approved) throw new HttpError(400, 'approve the timeline before rendering');

    const render = await prisma.render.create({
      data: { projectId: project.id, format, status: 'QUEUED' },
    });
    const job = await enqueueRender({ projectId: project.id, renderId: render.id, format });
    await prisma.job.create({
      data: { bullId: job.id, projectId: project.id, type: 'RENDER', status: 'QUEUED' },
    });
    await prisma.project.update({ where: { id: project.id }, data: { status: 'RENDERING' } });
    res.json({ renderId: render.id, jobId: job.id });
  }),
);

// Poll a render's status (frontend polls or use SSE/websocket in prod)
projectRouter.get(
  '/:id/renders/:renderId',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const render = await prisma.render.findUnique({ where: { id: req.params.renderId } });
    res.json({ render });
  }),
);

// Prompt-based editing: user describes the edit, Claude rewrites the timeline
projectRouter.post(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const { instruction } = z.object({ instruction: z.string().min(2).max(2000) }).parse(req.body);

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { analysis: true, timeline: true, sourceAsset: true },
    });
    if (!project?.analysis || !project.timeline) throw new HttpError(400, 'analyze the video first');

    const result = await editTimelineWithPrompt({
      instruction,
      durationSec: project.sourceAsset?.durationSec ?? 0,
      summary: project.analysis.summary,
      highlights: project.analysis.highlights,
      silences: project.analysis.silences,
      captions: project.analysis.captions,
      currentOps: project.timeline.operations as any[],
      currentEffects: project.timeline.effects as any,
      creatorProfile: await buildPromptInjection(req.user!.sub),
    });

    // creator memory: learn from this instruction (fire-and-forget)
    void learnFromPromptEdit(req.user!.sub, instruction);

    // update the working timeline (current head) — render uses this
    const timeline = await prisma.editTimeline.update({
      where: { projectId: project.id },
      data: {
        operations: result.operations as unknown as Prisma.InputJsonValue,
        effects: result.effects as unknown as Prisma.InputJsonValue,
        approved: false,
      },
    });

    // append an immutable version (never overwrites prior versions)
    const version = await createVersion({
      projectId: project.id,
      name: result.versionName,
      timeline: { operations: result.operations, effects: result.effects },
      userPrompt: instruction,
      aiExplanation: result.reasoning,
      changes: result.changes,
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.sub,
        projectId: project.id,
        kind: 'analysis',
        message: `New version "${result.versionName}" from prompt: "${instruction.slice(0, 80)}"`,
      },
    });

    res.json({ timeline, version, changes: result.changes, reasoning: result.reasoning });
  }),
);

// ─── One-click repurposing ────────────────────────────────────────────────────
// Map each target platform to a render format + tailored caption/copy source.
const PLATFORM_CONFIG: Record<
  string,
  { format: 'reel' | 'short' | 'landscape'; copyKey: 'instagram' | 'tiktok' | 'youtube' | 'linkedin' }
> = {
  youtube: { format: 'landscape', copyKey: 'youtube' },
  shorts: { format: 'short', copyKey: 'youtube' },
  tiktok: { format: 'reel', copyKey: 'tiktok' },
  reels: { format: 'reel', copyKey: 'instagram' },
  linkedin: { format: 'landscape', copyKey: 'linkedin' },
  x: { format: 'landscape', copyKey: 'tiktok' },
};

projectRouter.post(
  '/:id/repurpose',
  asyncHandler(async (req, res) => {
    const project = await ownedProject(req.user!.sub, req.params.id);
    const { platforms } = z
      .object({ platforms: z.array(z.enum(['youtube', 'shorts', 'tiktok', 'reels', 'linkedin', 'x'])).min(1) })
      .parse(req.body);

    const timeline = await prisma.editTimeline.findUnique({ where: { projectId: project.id } });
    if (!timeline) throw new HttpError(400, 'analyze the video first');
    // one-click implies approval of the current cut
    if (!timeline.approved) {
      await prisma.editTimeline.update({ where: { projectId: project.id }, data: { approved: true } });
    }

    const analysis = await prisma.analysis.findUnique({ where: { projectId: project.id } });
    const social = (analysis?.socialCopy as any) ?? {};

    const created: { platform: string; renderId: string; format: string; caption: string }[] = [];
    for (const platform of platforms) {
      const cfg = PLATFORM_CONFIG[platform];
      const render = await prisma.render.create({
        data: { projectId: project.id, format: cfg.format, status: 'QUEUED' },
      });
      const job = await enqueueRender({ projectId: project.id, renderId: render.id, format: cfg.format });
      await prisma.job.create({ data: { bullId: job.id, projectId: project.id, type: 'RENDER', status: 'QUEUED' } });
      created.push({ platform, renderId: render.id, format: cfg.format, caption: social[cfg.copyKey] ?? '' });
    }

    await prisma.project.update({ where: { id: project.id }, data: { status: 'RENDERING' } });
    await prisma.activityLog.create({
      data: {
        userId: req.user!.sub,
        projectId: project.id,
        kind: 'render',
        message: `Repurposing "${project.title}" for ${platforms.join(', ')} (${created.length} renders).`,
      },
    });

    res.json({ renders: created });
  }),
);

// Presigned URL for the source video (used by the preview player)
projectRouter.get(
  '/:id/source-url',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { sourceAsset: true },
    });
    if (!project?.sourceAsset) throw new HttpError(404, 'no source video');
    res.json({ url: await presignDownload(project.sourceAsset.s3Key) });
  }),
);

// Explainable AI: why is a given clip kept/removed?
projectRouter.post(
  '/:id/explain',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const { start, end, kept } = z
      .object({ start: z.number(), end: z.number(), kept: z.boolean() })
      .parse(req.body);
    const analysis = await prisma.analysis.findUnique({ where: { projectId: req.params.id } });
    if (!analysis) throw new HttpError(400, 'no analysis yet');

    // pass only captions overlapping the segment to keep the prompt tight
    const captions = ((analysis.captions as any[]) ?? []).filter(
      (c) => c.end >= start - 2 && c.start <= end + 2,
    );
    const result = await explainClip({
      start,
      end,
      kept,
      summary: analysis.summary,
      highlights: analysis.highlights,
      silences: analysis.silences,
      captions,
    });
    res.json(result);
  }),
);

// ─── Version history ──────────────────────────────────────────────────────────

// List all versions (newest first) + which one is the current head
projectRouter.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const versions = await prisma.editVersion.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        userPrompt: true,
        aiExplanation: true,
        changes: true,
        parentVersionId: true,
        createdAt: true,
      },
    });
    const head = await getHeadVersion(req.params.id);
    res.json({ versions, headId: head?.id ?? null });
  }),
);

// Compare two versions — registered BEFORE :versionId so "compare" isn't swallowed
projectRouter.get(
  '/:id/versions/compare',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const { a, b } = z.object({ a: z.string(), b: z.string() }).parse(req.query);
    res.json({ diff: await diffVersions(req.params.id, a, b) });
  }),
);

// Get a single version (full snapshot)
projectRouter.get(
  '/:id/versions/:versionId',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const version = await prisma.editVersion.findFirst({
      where: { id: req.params.versionId, projectId: req.params.id },
    });
    if (!version) throw new HttpError(404, 'version not found');
    res.json({ version });
  }),
);

// Restore an older version (append-only — never overwrites history)
projectRouter.post(
  '/:id/versions/:versionId/restore',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const version = await restoreVersion(req.params.id, req.params.versionId);
    res.json({ version });
  }),
);

// Rename a version (the one mutable field — does not change the snapshot)
projectRouter.patch(
  '/:id/versions/:versionId',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const version = await prisma.editVersion.update({
      where: { id: req.params.versionId },
      data: { name },
    });
    res.json({ version });
  }),
);

// Regenerate social copy (cheap Claude call)
projectRouter.post(
  '/:id/social/regenerate',
  asyncHandler(async (req, res) => {
    await ownedProject(req.user!.sub, req.params.id);
    const { tone } = z.object({ tone: z.string().default('energetic') }).parse(req.body);
    const analysis = await prisma.analysis.findUnique({ where: { projectId: req.params.id } });
    if (!analysis) throw new HttpError(400, 'no analysis yet');
    const socialCopy = await regenerateSocialCopy(analysis.summary ?? '', tone);
    await prisma.analysis.update({ where: { projectId: req.params.id }, data: { socialCopy } });
    res.json({ socialCopy });
  }),
);

// ─── Dashboard aggregates ─────────────────────────────────────────────────────
export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const [projects, renders, runs, logs] = await Promise.all([
      prisma.project.count({ where: { userId } }),
      prisma.render.findMany({
        where: { project: { userId } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { project: { select: { title: true } } },
      }),
      prisma.workflowRun.findMany({
        where: { connection: { userId } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.activityLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    res.json({ stats: { projects }, recentRenders: renders, workflowRuns: runs, activity: logs });
  }),
);
