# Hybrid Free-Tier Staging Checklist

This checklist prepares a hybrid free-tier staging deployment for AutoEdit AI.

Claude remains skipped:

```env
AI_PROVIDER=fallback
```

## Architecture

| Component | Free-tier target | Status |
| --- | --- | --- |
| Frontend | Vercel Free | Documented |
| API | Render Free Web Service or Railway free/trial | `render.yaml` and docs added |
| Worker | Local PC | Required for full pipeline |
| Database | Neon Free PostgreSQL | Documented |
| Redis | Upstash Free Redis | Documented |
| Whisper | Local Docker sidecar | Required for audio transcription |
| Rendering | Local PC FFmpeg | Required for final outputs |
| Storage | Existing AWS S3 bucket | Reuse existing validated bucket |
| Monitoring | Sentry Free later | Planning only |

## Important Worker Gate

The full upload/transcribe/render pipeline requires `npm run worker` to run continuously on the local PC.

The local PC must stay awake and connected to the internet. If the worker is offline, uploads can still enqueue jobs in Upstash Redis, but processing will wait until the worker reconnects.

## Checklist

1. Create Neon database.
2. Create Upstash Redis.
3. Create Render/Railway API service from repo config.
4. Create Vercel frontend project.
5. Configure cloud API environment variables.
6. Configure Vercel `NEXT_PUBLIC_API_BASE_URL`.
7. Configure local `apps/api/.env` for Neon, Upstash, S3, and local Whisper.
8. Run Prisma migration.
9. Start local Whisper.
10. Start local worker.
11. Verify API health endpoints.
12. Upload test video.
13. Verify local worker processes job.
14. Verify fallback render.
15. Verify S3 outputs.

## Required Cloud API Environment Variables

```env
NODE_ENV=production
API_PORT=4000
TRUST_PROXY=1
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
INTEGRATION_ENCRYPTION_SECRET=
WEB_ORIGIN=
API_BASE_URL=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=
AI_PROVIDER=fallback
RENDER_WORK_DIR=/tmp/autoedit
```

## Required Local Worker Environment Variables

```env
NODE_ENV=development
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
INTEGRATION_ENCRYPTION_SECRET=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=
AI_PROVIDER=fallback
WHISPER_URL=http://localhost:9000
RENDER_WORK_DIR=C:\autoedit-work
RENDER_CONCURRENCY=1
ANALYSIS_CONCURRENCY=1
```

## Required Web Environment Variables

```env
NEXT_PUBLIC_API_BASE_URL=
```

The app currently uses `NEXT_PUBLIC_API_BASE_URL`, not `NEXT_PUBLIC_API_URL`.

## Health Verification

After API deployment:

```text
GET /health/db
GET /health/redis
GET /health/s3
GET /health/queue
```

For fallback-only deployment, `/health/claude` is not required.

The aggregate `/health/` endpoint should pass when DB, Redis, S3, queue, and selected AI provider are healthy.

## Local Worker Commands

From repo root:

```powershell
docker compose up -d whisper
```

Then:

```powershell
cd apps/api
npm run worker
```

## Smoke Test

Use a 10-30 second MP4.

Expected:

1. Register/login on Vercel frontend.
2. Start multipart upload through cloud API.
3. Browser uploads source video to S3.
4. Cloud API completes upload.
5. Cloud API enqueues analysis job in Upstash Redis.
6. Local worker downloads source from S3.
7. Local Whisper transcribes if audio exists.
8. Fallback timeline is created.
9. Render jobs are queued.
10. Local FFmpeg renders outputs.
11. Outputs upload to S3.
12. Frontend shows project `RENDERED`.

## Stop Conditions

Stop and fix before continuing if:

- Render/Railway API cannot boot.
- Neon migration fails.
- Upstash Redis is unreachable.
- S3 `/health/s3` fails.
- Local Whisper `/health` fails.
- Local worker cannot connect to Upstash Redis.
- Upload completes but no analysis job is processed.
