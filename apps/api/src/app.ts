import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { errorHandler, requireAuth } from './middleware/auth.js';
import { AUTH_LIMITER, GENERAL_API_LIMITER, INTEGRATION_LIMITER, UPLOAD_LIMITER } from './middleware/rateLimit.js';
import { authRouter } from './routes/auth.routes.js';
import { uploadRouter } from './routes/upload.routes.js';
import { projectRouter, dashboardRouter } from './routes/projects.routes.js';
import { n8nRouter, webhookRouter } from './routes/n8n.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { creatorRouter, analyticsRouter, feedbackRouter } from './routes/account.routes.js';
import { integrationsRouter } from './routes/integrations.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(cookieParser());

  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use('/api/auth', AUTH_LIMITER, authRouter);
  app.use('/api/upload', requireAuth, UPLOAD_LIMITER, uploadRouter);
  app.use('/api/projects', requireAuth, GENERAL_API_LIMITER, projectRouter);
  app.use('/api/dashboard', requireAuth, GENERAL_API_LIMITER, dashboardRouter);
  app.use('/api/n8n', n8nRouter);
  app.use('/api/integrations', requireAuth, INTEGRATION_LIMITER, integrationsRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/creator', requireAuth, GENERAL_API_LIMITER, creatorRouter);
  app.use('/api/analytics', requireAuth, GENERAL_API_LIMITER, analyticsRouter);
  app.use('/api/feedback', requireAuth, GENERAL_API_LIMITER, feedbackRouter);
  app.use('/health', healthRouter);

  app.use(errorHandler);

  return app;
}
