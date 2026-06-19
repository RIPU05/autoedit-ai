import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireAdmin, asyncHandler } from '../middleware/auth.js';
import { getOrCreateProfile, summary, learnFromProject } from '../services/creator-memory.service.js';
import { computeAnalytics } from '../services/analytics.service.js';

// ─── Creator memory (Phase 3) ─────────────────────────────────────────────────
export const creatorRouter = Router();
creatorRouter.use(requireAuth);

creatorRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    await getOrCreateProfile(req.user!.sub);
    res.json(await summary(req.user!.sub));
  }),
);

const prefSchema = z.object({
  pacingPreference: z.enum(['slow', 'balanced', 'fast']).optional(),
  captionPreference: z.enum(['on', 'off', 'minimal']).optional(),
  musicPreference: z.enum(['none', 'subtle', 'prominent']).optional(),
  hookPreference: z.enum(['strong', 'gentle']).optional(),
  platformPreference: z.enum(['shorts', 'youtube', 'tiktok', 'reels', 'linkedin']).optional(),
  editingStyle: z.enum(['viral', 'educational', 'documentary', 'podcast', 'sales']).optional(),
});

creatorRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const patch = prefSchema.parse(req.body);
    await getOrCreateProfile(req.user!.sub);
    const profile = await prisma.creatorProfile.update({ where: { userId: req.user!.sub }, data: patch });
    res.json({ profile });
  }),
);

// ─── Analytics (Phase 4) ──────────────────────────────────────────────────────
export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await computeAnalytics(req.user!.sub));
  }),
);

// platform-wide analytics (admin)
analyticsRouter.get(
  '/global',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await computeAnalytics(null));
  }),
);

// ─── Feedback (Phase 5) ───────────────────────────────────────────────────────
export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

feedbackRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        projectId: z.string().optional(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(4000).optional(),
        category: z.string().optional(),
        answers: z
          .object({
            savedTime: z.string().optional(),
            confusing: z.string().optional(),
            wouldPay: z.string().optional(),
            magical: z.string().optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const feedback = await prisma.feedback.create({
      data: { userId: req.user!.sub, ...body, answers: body.answers as object },
    });

    // completing a project + giving feedback is a strong learning signal
    if (body.projectId) void learnFromProject(body.projectId);

    res.json({ feedback });
  }),
);

// admin review dashboard data
feedbackRouter.get(
  '/admin',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [items, count, avg] = await Promise.all([
      prisma.feedback.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.feedback.count(),
      prisma.feedback.aggregate({ _avg: { rating: true } }),
    ]);
    res.json({ items, count, avgRating: avg._avg.rating ?? 0 });
  }),
);
