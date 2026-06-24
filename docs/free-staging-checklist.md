# Free-Tier Staging Checklist

This checklist prepares a free-tier staging deployment for AutoEdit AI.

Claude remains skipped:

```env
AI_PROVIDER=fallback
```

## Architecture

| Component | Free-tier target | Status |
| --- | --- | --- |
| Frontend | Vercel Free | Documented |
| API | Render Free Web Service | `render.yaml` added |
| Worker | Separate long-running process required | Human dashboard decision required |
| Database | Neon Free PostgreSQL | Documented |
| Redis | Upstash Free Redis | Documented |
| Whisper | Hugging Face Spaces Docker CPU | Documented |
| Storage | Existing AWS S3 bucket | Reuse existing validated bucket |
| Monitoring | Sentry Free | Planning only |

## Important Worker Gate

The full upload/transcribe/render pipeline requires `npm run start:worker` to run continuously.

The requested free stack includes Render Free Web Service for the API, but does not provide a confirmed free background worker target. Before claiming full staging success, a human must verify one of these options:

1. A free Render-compatible worker process is available for this account.
2. A second free web service can safely run a worker wrapper without changing app code.
3. Another free long-running host is approved.

If no free worker host is available, staging can validate frontend, API, DB, Redis, S3, and Whisper health, but cannot complete the full render pipeline.

## Checklist

1. Create Neon database.
2. Create Upstash Redis.
3. Create Render API service from `render.yaml`.
4. Decide and create a free worker host.
5. Create Hugging Face Docker Space for Whisper.
6. Create Vercel frontend project.
7. Configure environment variables.
8. Run Prisma migration.
9. Verify health endpoints.
10. Upload test video.
11. Verify fallback render.
12. Verify S3 outputs.

## Required Environment Variables

API and worker:

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
WHISPER_URL=
RENDER_WORK_DIR=/tmp/autoedit
RENDER_CONCURRENCY=1
ANALYSIS_CONCURRENCY=1
```

Web:

```env
NEXT_PUBLIC_API_BASE_URL=
```

Optional:

```env
BACKGROUND_MUSIC_PATH=
S3_PRESIGN_TTL=3600
N8N_BASE_URL=
N8N_API_KEY=
N8N_WEBHOOK_SECRET=
```

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

## Smoke Test

Use a 10-30 second MP4.

Expected:

1. Register/login.
2. Start multipart upload.
3. Complete upload.
4. Worker downloads source from S3.
5. Whisper transcribes if audio exists.
6. Fallback timeline is created.
7. Render jobs are queued.
8. Render completes.
9. Outputs upload to S3.

## Stop Conditions

Stop and fix before continuing if:

- Render API cannot boot.
- Neon migration fails.
- Upstash Redis is unreachable.
- Whisper Space `/health` fails.
- S3 `/health/s3` fails.
- Worker cannot be hosted on a free service.
- Upload completes but no analysis job is processed.
