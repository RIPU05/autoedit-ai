import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ZodError } from 'zod';
import {
  ApplyPrivateProjectEditRequestSchema,
  CreatePrivateRenderRequestSchema,
  CreateProjectFromSourceRequestSchema,
  ResolveMediaSourceRequestSchema,
  SubmitMediaJobRequestSchema,
} from '@autoedit/contracts';
import { asyncHandler } from '../middleware/auth.js';
import { MEDIA_JOB_LIMITER, MEDIA_RESOLVE_LIMITER } from '../middleware/rateLimit.js';
import { MediaSourceError } from '../media/errors.js';
import { UniversalMediaApiService } from '../media/api/universal-media.service.js';

export interface CreateMediaRouterOptions {
  service?: UniversalMediaApiService;
  resolveLimiter?: RequestHandler;
  jobLimiter?: RequestHandler;
}

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{4,128}$/;

function assertSafePathId(value: string, label: string): string {
  if (!value || !SAFE_ID_REGEX.test(value)) {
    throw new MediaSourceError({
      code: 'MALFORMED_URL',
      message: `Invalid ${label} parameter.`,
      statusCode: 400,
    });
  }
  return value;
}

/**
 * Creates the authenticated Universal Media API router (`/api/media`).
 *
 * All routes assume `requireAuth` has already populated `req.user.sub`.
 * Never trusts client-provided ownerUserId, canonicalSourceId, rightsStatus, storageKey, or workerId.
 */
export function createMediaRouter(options: CreateMediaRouterOptions = {}): Router {
  const router = Router();
  let defaultService: UniversalMediaApiService | null = options.service ?? null;

  const getService = (): UniversalMediaApiService => {
    if (!defaultService) {
      defaultService = new UniversalMediaApiService();
    }
    return defaultService;
  };

  const resolveLimiter = options.resolveLimiter ?? MEDIA_RESOLVE_LIMITER;
  const jobLimiter = options.jobLimiter ?? MEDIA_JOB_LIMITER;

  // POST /api/media/sources/resolve — Resolve universal media input & truthful capability status
  router.post(
    '/sources/resolve',
    resolveLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const parsed = ResolveMediaSourceRequestSchema.parse(req.body);
      const resolved = await getService().resolveUniversalSource(userId, parsed.input);
      return res.status(200).json(resolved.response);
    }),
  );

  // POST /api/media/jobs — Submit idempotent universal media processing job (shared work deduplication)
  router.post(
    '/jobs',
    jobLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const parsed = SubmitMediaJobRequestSchema.parse(req.body);
      const result = await getService().submitMediaJob(userId, parsed);
      return res.status(result.httpStatus).json(result.job);
    }),
  );

  // GET /api/media/jobs/:jobId — Poll authenticated user's own job status (404 to non-owners)
  router.get(
    '/jobs/:jobId',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const jobId = assertSafePathId(req.params.jobId, 'jobId');
      const status = await getService().getUserJobStatus(userId, jobId);
      return res.status(200).json(status);
    }),
  );

  // POST /api/media/jobs/:jobId/cancel — Cancel ONLY this user's job (keeps shared work alive if others remain)
  router.post(
    '/jobs/:jobId/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const jobId = assertSafePathId(req.params.jobId, 'jobId');
      const result = await getService().cancelUserJob(userId, jobId);
      return res.status(200).json(result);
    }),
  );

  // GET /api/media/jobs/:jobId/highlights — Authorized highlights with short-lived signed URLs (re-checks rights live)
  router.get(
    '/jobs/:jobId/highlights',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const jobId = assertSafePathId(req.params.jobId, 'jobId');
      const result = await getService().getUserJobHighlights(userId, jobId);
      return res.status(200).json(result);
    }),
  );

  // POST /api/media/projects/from-source — Create private Project + EditTimeline + root EditVersion from a job
  router.post(
    '/projects/from-source',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const parsed = CreateProjectFromSourceRequestSchema.parse(req.body);
      const created = await getService().createPrivateProjectFromJob(userId, parsed);
      return res.status(201).json(created);
    }),
  );

  // GET /api/media/projects/:projectId/highlights — Authorized highlights for an owned private Project
  router.get(
    '/projects/:projectId/highlights',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const projectId = assertSafePathId(req.params.projectId, 'projectId');
      const result = await getService().getPrivateProjectHighlights(userId, projectId);
      return res.status(200).json(result);
    }),
  );

  // POST /api/media/projects/:projectId/edits — Save immutable EditVersion + optionally enqueue durable background private render
  router.post(
    '/projects/:projectId/edits',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const projectId = assertSafePathId(req.params.projectId, 'projectId');
      const parsed = ApplyPrivateProjectEditRequestSchema.parse(req.body);
      const result = await getService().applyPrivateProjectEdit(userId, projectId, parsed);
      return res.status(result.httpStatus).json(result.response);
    }),
  );

  // POST /api/media/projects/:projectId/renders — Enqueue durable background private render for an existing owned EditVersion
  router.post(
    '/projects/:projectId/renders',
    jobLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const projectId = assertSafePathId(req.params.projectId, 'projectId');
      const parsed = CreatePrivateRenderRequestSchema.parse(req.body);
      const result = await getService().enqueuePrivateRenderForVersion(userId, projectId, parsed);
      return res.status(result.httpStatus).json(result.renderJob);
    }),
  );

  // GET /api/media/projects/:projectId/renders — List owned project's durable private render jobs (for refresh recovery)
  router.get(
    '/projects/:projectId/renders',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const projectId = assertSafePathId(req.params.projectId, 'projectId');
      const result = await getService().listPrivateProjectRenders(userId, projectId);
      return res.status(200).json(result);
    }),
  );

  // GET /api/media/projects/:projectId/renders/:renderJobId — Poll private render status & mint verified short-lived download URL when READY
  router.get(
    '/projects/:projectId/renders/:renderJobId',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const projectId = assertSafePathId(req.params.projectId, 'projectId');
      const renderJobId = assertSafePathId(req.params.renderJobId, 'renderJobId');
      const result = await getService().getPrivateRenderStatus(userId, projectId, renderJobId);
      return res.status(200).json(result);
    }),
  );

  // POST /api/media/projects/:projectId/renders/:renderJobId/cancel — Cancel an owned QUEUED/RUNNING private render job
  router.post(
    '/projects/:projectId/renders/:renderJobId/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const projectId = assertSafePathId(req.params.projectId, 'projectId');
      const renderJobId = assertSafePathId(req.params.renderJobId, 'renderJobId');
      const result = await getService().cancelPrivateRender(userId, projectId, renderJobId);
      return res.status(200).json(result);
    }),
  );

  // Scoped error handler for /api/media — sanitizes Zod and MediaSourceError responses cleanly
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const isZod =
      err instanceof ZodError ||
      (err instanceof Error && err.name === 'ZodError' && Array.isArray((err as { issues?: unknown }).issues));
    if (isZod) {
      const issues = (err as ZodError).issues ?? [];
      return res.status(400).json({
        error: 'Invalid request payload.',
        code: 'VALIDATION_ERROR',
        issues: issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    if (err instanceof MediaSourceError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
      });
    }
    return next(err);
  });

  return router;
}

export const mediaRouter = createMediaRouter();
