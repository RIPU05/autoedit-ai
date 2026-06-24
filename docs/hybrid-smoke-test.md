# Hybrid Free Deployment Smoke Test

This smoke test verifies:

Vercel frontend -> cloud API -> S3 upload -> Upstash queue -> local worker -> local Whisper -> local FFmpeg -> S3 output.

## Prerequisites

Cloud:

- Vercel frontend deployed.
- Render/Railway API deployed.
- Neon database migrated.
- Upstash Redis configured.
- Existing S3 bucket configured.

Local PC:

- `apps/api/.env` points to the same Neon, Upstash, and S3 resources.
- Docker Desktop is running.
- Whisper sidecar is running locally.
- Worker is running locally.

## Start Local Services

From repo root:

```powershell
docker compose up -d whisper
```

Verify Whisper:

```powershell
Invoke-RestMethod http://localhost:9000/health
```

Start worker:

```powershell
cd apps/api
npm run worker
```

## Health Checks

Cloud API:

```text
GET https://YOUR_API_HOST/health/db
GET https://YOUR_API_HOST/health/redis
GET https://YOUR_API_HOST/health/s3
GET https://YOUR_API_HOST/health/queue
```

Local worker:

- terminal shows workers started
- no Redis authentication/TLS errors
- no Prisma connection errors

## Test Flow

1. Open Vercel frontend.
2. Register/login.
3. Upload short video.
4. API stores upload in S3.
5. API enqueues job in Upstash Redis.
6. Local worker receives job.
7. Worker calls local Whisper.
8. Worker renders locally.
9. Worker uploads final outputs to S3.
10. Frontend/API shows `RENDERED`.

## Failure Classification

API upload failure:

- check S3 credentials and CORS
- check Render env vars
- check browser console

No worker activity:

- check local `REDIS_URL`
- check Upstash TLS URL starts with `rediss://`
- check worker terminal is still running
- check API and worker use the same Redis database

Whisper failure:

- check `docker compose ps whisper`
- check `WHISPER_URL=http://localhost:9000`
- check `/health`

Render failure:

- check local FFmpeg availability
- check `RENDER_WORK_DIR`
- check disk space

Project never reaches `RENDERED`:

- check worker logs
- check Neon DB connectivity from local worker
- check render queue jobs in Redis
