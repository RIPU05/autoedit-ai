import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { errorHandler } from './middleware/auth.js';
import { authRouter } from './routes/auth.routes.js';
import { uploadRouter } from './routes/upload.routes.js';
import { projectRouter, dashboardRouter } from './routes/projects.routes.js';
import { n8nRouter, webhookRouter } from './routes/n8n.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { creatorRouter, analyticsRouter, feedbackRouter } from './routes/account.routes.js';
import { startMemorySampler } from './lib/observability.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(cookieParser());

// capture raw body for webhook signature verification, parse JSON for everything else
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString('utf8');
    },
  }),
);

app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 30 }), authRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/projects', projectRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/n8n', n8nRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/creator', creatorRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/health', healthRouter);

app.use(errorHandler);

startMemorySampler();

app.listen(env.API_PORT, () => {
  console.log(`AutoEdit API listening on :${env.API_PORT}`);
});
