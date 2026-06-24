# Hybrid Free Deployment With Local Worker

This plan deploys the lightweight online surface while keeping the heavy video pipeline on the local PC for zero monthly worker/Whisper cost.

Claude remains disabled:

```env
AI_PROVIDER=fallback
```

## Architecture

Cloud:

- Frontend: Vercel Free
- API: Render Free Web Service or Railway free/trial web service
- Database: Neon Free PostgreSQL
- Redis: Upstash Free Redis
- Storage: existing AWS S3 bucket
- DNS: Cloudflare later
- Monitoring: Sentry later

Local PC:

- BullMQ worker
- Whisper sidecar
- FFmpeg rendering
- local render scratch directory

## Architecture Audit

### Can API And Local Worker Share The Same Remote Redis Queue?

Yes. The API enqueues BullMQ jobs into Redis, and the worker consumes from the same queue names:

- `analysis`
- `render`
- `n8n-dispatch`

Both processes only need the same `REDIS_URL`.

### Does The Local Worker Need The Same Neon DB And Upstash Redis?

Yes. The local worker must use the same Neon `DATABASE_URL` and the same Upstash `REDIS_URL` as the cloud API.

The worker updates project, transcript, analysis, timeline, render, workflow, and job records in the shared database.

### What Does The Local Worker Need?

Required:

- `DATABASE_URL`
- `REDIS_URL`
- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET`
- `AI_PROVIDER=fallback`
- `WHISPER_URL=http://localhost:9000`
- `RENDER_WORK_DIR=C:\autoedit-work` on Windows, or another safe local path

Optional:

- `BACKGROUND_MUSIC_PATH`
- `BACKGROUND_MUSIC_VOLUME`
- `S3_PRESIGN_TTL`
- `N8N_*` variables if n8n dispatch is used

### Does The API Need Whisper?

For the current workflow, Whisper is used by the worker during analysis, not by the API request path.

The API env schema has a default `WHISPER_URL`, so the cloud API can boot without a real Whisper service. It is safe to leave the cloud API at the default; the local worker is the process that must reach local Whisper.

### Hardcoded Localhost Assumptions

Current relevant defaults:

- API CORS default: `WEB_ORIGIN=http://localhost:3000`
- frontend API default: `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000`
- Whisper default: `WHISPER_URL=http://localhost:9000`
- Redis default: `REDIS_URL=redis://localhost:6379`

For hybrid staging, override these in cloud/local environments.

## Cloud API Environment

Set these on Render/Railway:

```env
NODE_ENV=production
API_PORT=4000
TRUST_PROXY=1
DATABASE_URL=NEON_DATABASE_URL
REDIS_URL=UPSTASH_REDIS_URL
JWT_SECRET=long-random-secret
INTEGRATION_ENCRYPTION_SECRET=32-plus-character-random-secret
WEB_ORIGIN=https://YOUR_VERCEL_APP.vercel.app
API_BASE_URL=https://YOUR_API_HOST
AWS_REGION=your-s3-region
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
S3_BUCKET=your-existing-bucket
AI_PROVIDER=fallback
RENDER_WORK_DIR=/tmp/autoedit
```

Optional:

```env
WHISPER_URL=http://localhost:9000
S3_PRESIGN_TTL=3600
N8N_BASE_URL=
N8N_API_KEY=
N8N_WEBHOOK_SECRET=
```

Notes:

- This codebase currently uses `WEB_ORIGIN` for CORS.
- Do not use wildcard CORS with credentials.
- `ANTHROPIC_API_KEY` is not required when `AI_PROVIDER=fallback`.

## Local Worker Environment

Put these in `apps/api/.env` on the local PC. Do not commit the file.

```env
NODE_ENV=development
DATABASE_URL=NEON_DATABASE_URL
REDIS_URL=UPSTASH_REDIS_URL
JWT_SECRET=same-or-compatible-secret-used-by-api
INTEGRATION_ENCRYPTION_SECRET=same-secret-used-by-api
AWS_REGION=your-s3-region
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
S3_BUCKET=your-existing-bucket
AI_PROVIDER=fallback
WHISPER_URL=http://localhost:9000
RENDER_WORK_DIR=C:\autoedit-work
RENDER_CONCURRENCY=1
ANALYSIS_CONCURRENCY=1
BACKGROUND_MUSIC_PATH=
```

The worker does not need to expose a public port.

## Frontend Environment

Set this on Vercel:

```env
NEXT_PUBLIC_API_BASE_URL=https://YOUR_API_HOST
```

Important:

- The current frontend reads `NEXT_PUBLIC_API_BASE_URL`.
- If a dashboard or note says `NEXT_PUBLIC_API_URL`, map that value to `NEXT_PUBLIC_API_BASE_URL` for this codebase.

## Remote Redis Compatibility

The API uses `ioredis` and passes the Redis client into BullMQ.

Expected Upstash format:

```env
REDIS_URL=rediss://default:PASSWORD@HOST:PORT
```

`rediss://` enables TLS. Keep local development compatible by continuing to use:

```env
REDIS_URL=redis://localhost:6379
```

## Local Worker Runbook

From the repository root on the local PC:

```powershell
docker compose up -d whisper
```

Verify Whisper:

```powershell
Invoke-RestMethod http://localhost:9000/health
```

Start the worker:

```powershell
cd apps/api
npm run worker
```

Confirm:

1. Worker starts without Anthropic key.
2. Worker connects to Upstash Redis.
3. Worker receives jobs enqueued by the cloud API.
4. Worker downloads source videos from S3.
5. Worker calls local Whisper at `http://localhost:9000`.
6. Worker writes timeline/render state to Neon.
7. Worker uploads final outputs to S3.

## Staging Flow

1. User opens Vercel frontend.
2. Frontend calls Render/Railway API.
3. API authenticates user and starts S3 multipart upload.
4. Browser uploads video directly to S3.
5. API completes upload and enqueues analysis job in Upstash Redis.
6. Local worker consumes the job from Upstash.
7. Local worker downloads source media from S3.
8. Local worker uses local Whisper and fallback timeline generation.
9. Local worker renders with FFmpeg locally.
10. Local worker uploads final outputs to S3.
11. Frontend sees project status become `RENDERED`.

## Limitations

- Local PC must stay awake.
- Worker stops if the PC sleeps, loses internet, or the terminal closes.
- Uploads can enqueue while the worker is offline, but processing waits until worker reconnects.
- Upstash and Render/Railway free tiers have rate, CPU, memory, sleep, and connection limits.
- This is not production-grade deployment.
- It is suitable for demos, private testing, and first validation at nearly zero monthly cost.
