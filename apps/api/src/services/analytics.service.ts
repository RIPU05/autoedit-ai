import { prisma } from '../lib/prisma.js';

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/** Per-user analytics (Phase 4). Pass scopeUserId=null for platform-wide (admin). */
export async function computeAnalytics(scopeUserId: string | null) {
  const projectWhere = scopeUserId ? { userId: scopeUserId } : {};
  const renderWhere = scopeUserId ? { project: { userId: scopeUserId } } : {};

  const [projectsCreated, uploads, renders, stageTimings, edits, projects] = await Promise.all([
    prisma.project.count({ where: projectWhere }),
    prisma.asset.count({ where: { kind: 'SOURCE_VIDEO' } }),
    prisma.render.findMany({ where: renderWhere, select: { status: true, createdAt: true } }),
    prisma.stageTiming.findMany({
      select: { stage: true, ms: true, ok: true },
      take: 5000,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.activityLog.count({ where: { kind: 'analysis', ...(scopeUserId ? { userId: scopeUserId } : {}) } }),
    prisma.project.findMany({ where: projectWhere, include: { sourceAsset: true } }),
  ]);

  const successful = renders.filter((r: any) => r.status === 'COMPLETED').length;
  const failed = renders.filter((r: any) => r.status === 'FAILED').length;
  const analysisMs = stageTimings.filter((s: any) => s.stage === 'analysis' && s.ok).map((s: any) => s.ms);
  const renderMs = stageTimings.filter((s: any) => s.stage === 'render' && s.ok).map((s: any) => s.ms);
  const durations = projects.map((p: any) => p.sourceAsset?.durationSec ?? 0).filter(Boolean);

  // Weekly Active Creators: distinct users with a project in the last 7 days
  const since = new Date(Date.now() - 7 * 864e5);
  const wac = await prisma.project.findMany({
    where: { createdAt: { gte: since }, ...(scopeUserId ? { userId: scopeUserId } : {}) },
    distinct: ['userId'],
    select: { userId: true },
  });

  return {
    tracked: {
      uploadCount: uploads,
      projectsCreated,
      successfulRenders: successful,
      failedRenders: failed,
      avgAnalysisTimeMs: avg(analysisMs),
      avgRenderTimeMs: avg(renderMs),
      avgProjectDurationSec: Math.round(avg(durations)),
      promptEditsPerProject: projectsCreated ? +(edits / projectsCreated).toFixed(2) : 0,
    },
    key: {
      // Time To First Successful Edit ≈ analysis stage time (upload → first usable timeline)
      timeToFirstEditMs: avg(analysisMs),
      timeToRenderMs: avg(renderMs),
      renderSuccessRate: successful + failed ? +((successful / (successful + failed)) * 100).toFixed(1) : 0,
      weeklyActiveCreators: wac.length,
    },
  };
}
