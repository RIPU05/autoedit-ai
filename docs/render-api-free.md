# Render Free API Deployment

This document prepares the cloud API side of the hybrid free deployment.

The heavy worker, Whisper, and FFmpeg rendering stay on the local PC.

## What Runs On Render

Render runs only the Express API web service.

Do not run the BullMQ worker or Whisper sidecar on Render for this hybrid-free plan.

## Blueprint

`render.yaml` defines:

- service type: `web`
- root directory: `apps/api`
- plan: `free`
- build command: `npm install && npx prisma generate && npm run build`
- start command: `npx prisma migrate deploy && npm run start`
- health check: `/health/db`

## Required Environment Variables

Set these in the Render dashboard:

```env
NODE_ENV=production
API_PORT=4000
TRUST_PROXY=1
DATABASE_URL=NEON_DATABASE_URL
REDIS_URL=UPSTASH_REDIS_URL
JWT_SECRET=
INTEGRATION_ENCRYPTION_SECRET=
WEB_ORIGIN=https://YOUR_VERCEL_APP.vercel.app
API_BASE_URL=https://YOUR_RENDER_SERVICE.onrender.com
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=
AI_PROVIDER=fallback
RENDER_WORK_DIR=/tmp/autoedit
```

Optional:

```env
WHISPER_URL=http://localhost:9000
S3_PRESIGN_TTL=3600
```

`ANTHROPIC_API_KEY` is not required for `AI_PROVIDER=fallback`.

## Health Endpoints

Use:

```text
GET /health/db
GET /health/redis
GET /health/s3
GET /health/queue
```

For fallback-only deployment, `/health/claude` is expected to be unused.

## Migration Command

Render start command currently runs:

```bash
npx prisma migrate deploy && npm run start
```

If migration needs to be run manually instead:

```bash
cd apps/api
npx prisma migrate deploy
```

Use the Neon connection string only in the Render dashboard or a trusted local shell.

## Render Free Caveats

- Free web services can sleep.
- First request after sleep may be slow.
- The API can enqueue jobs only when awake.
- Once a job is in Upstash Redis, the local worker can process it independently.
- API sleep does not stop an already-running local worker, but frontend polling may pause until API wakes again.

## Manual Dashboard Step

Stop here for human action:

1. Create a Render Web Service from the GitHub repo or Blueprint.
2. Confirm root directory is `apps/api`.
3. Add all required env vars.
4. Deploy.
5. Open `/health/db`, `/health/redis`, `/health/s3`, and `/health/queue`.
