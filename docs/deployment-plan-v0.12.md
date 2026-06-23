# AutoEdit AI v0.12 Deployment Plan

This is a planning document only. It does not start deployment.

Claude remains skipped for the first public deployment. The recommended AI setting is:

```env
AI_PROVIDER=fallback
```

## Runtime Services

| Service | Role | Runtime | Notes |
| --- | --- | --- | --- |
| Next.js web | Browser app, auth screens, dashboard, upload UI, project UI | Node/Next.js | Can run as managed web service or container |
| Express API | Auth, upload orchestration, health checks, project routes, integrations | Node.js | Runs migrations before start in compose |
| BullMQ worker | Analysis jobs, Whisper calls, fallback timeline, FFmpeg render, S3 output upload | Node.js + FFmpeg | Needs persistent-ish scratch volume for render temp files |
| Whisper sidecar | Local transcription service | Docker/Python/Faster-Whisper | CPU works for MVP; RAM/CPU must be sized carefully |
| Postgres | Application database | Managed or container | Prefer managed DB for first public deploy |
| Redis | BullMQ queues | Managed or container | Must support BullMQ blocking connections |
| S3 | Source uploads and rendered outputs | AWS S3 | Bucket remains private; browser uploads through presigned URLs |
| n8n | Optional workflow automation receiver | External/self-hosted n8n | Backend connector already supports webhook dispatch |

## Deployment Options

### Option A: Railway

Shape:

- Web service: `apps/web`
- API service: `apps/api`
- Worker service: `apps/api` running `npm run start:worker`
- Managed Postgres
- Managed Redis
- Whisper as Docker service if supported by project/container settings
- S3 on AWS

Pros:

- Fastest path from repo to running app.
- Managed Postgres and Redis reduce operational load.
- Easy per-service env var management.
- Good fit for early demo/beta.

Cons:

- Whisper CPU/RAM sizing may get expensive or constrained.
- Long FFmpeg renders may need careful worker timeout/resource settings.
- Dockerized sidecar support and private service networking must be verified.

Best use:

- First hosted MVP if Whisper sidecar and worker resources are acceptable.

### Option B: Render

Shape:

- Web service: Next.js
- API web service: Express
- Background worker: BullMQ worker
- Managed Postgres
- Managed Redis
- Whisper as private web service or Docker service
- S3 on AWS

Pros:

- Clear web service/background worker model.
- Managed Postgres and Redis available.
- Good deploy logs and health checks.
- `TRUST_PROXY=1` fits common Render-style proxy setup.

Cons:

- Whisper service cold starts and CPU limits need validation.
- Long render jobs need worker sizing.
- Free/low tiers are not appropriate for video processing.

Best use:

- Practical first deployment if Railway resource layout is awkward.

### Option C: VPS With Docker Compose

Shape:

- One VPS runs Docker Compose:
  - web
  - api
  - worker
  - whisper
  - redis
- Postgres can be managed externally or in compose
- S3 on AWS
- Reverse proxy via Caddy/Nginx/Traefik

Pros:

- Maximum control over FFmpeg, worker, and Whisper resources.
- Easiest way to mirror local Docker Compose.
- Lowest cost for a CPU-heavy beta if managed carefully.

Cons:

- You own patching, backups, firewall, process recovery, TLS, monitoring.
- Single-machine risk unless backed by managed Postgres/S3.
- Scaling workers requires more manual operations.

Best use:

- Good for a controlled private beta or demo box.

### Option D: AWS ECS/Fargate

Shape:

- ECS service: API
- ECS service: worker
- ECS service: Whisper
- Web on ECS, Amplify, or Vercel-like hosting
- RDS Postgres
- ElastiCache Redis
- S3 bucket
- ALB for API and web

Pros:

- Most production-aligned with S3 and AWS IAM.
- Clear path to scaling API/worker/Whisper separately.
- Strong networking and IAM control.

Cons:

- Highest setup complexity.
- More AWS infrastructure decisions before product validation.
- Whisper/FFmpeg cost and sizing still need load testing.

Best use:

- Later production deployment after first beta usage is proven.

## Recommended First Deployment Path

Recommended: **Render or Railway managed services first**, with a bias toward **Render** if its worker/private service model handles the Whisper sidecar cleanly.

Why:

- Faster than ECS/Fargate.
- Less operational burden than a VPS.
- Supports separate API and worker processes.
- Managed Postgres/Redis are available.
- Lets us validate product usage before committing to AWS infrastructure complexity.

Fallback recommendation:

- If Whisper sidecar deployment is painful on managed PaaS, use a small VPS with Docker Compose for API/worker/Whisper/Redis and a managed Postgres database.

## Region Plan

Keep compute, database, Redis, and S3 as close as possible.

Current S3 bucket evidence from prior validation: Europe Stockholm (`eu-north-1`) was used during local testing.

Recommended first region plan:

- If the existing S3 bucket remains in `eu-north-1`, choose a host region in Europe.
- If most first users are in India, consider moving S3 and compute to a closer region such as Mumbai or Singapore before public launch.
- Do not split compute far from S3; upload completion, worker downloads, and render output uploads all pay the latency cost.

## Service Map

| Component | First deploy target | Needs Docker? | Command |
| --- | --- | --- | --- |
| Web | Managed Next.js service | Optional | `npm run build`, `npm run start` |
| API | Managed Node service or Docker | Optional, recommended if FFmpeg/native parity matters | `npm run build`, `npx prisma migrate deploy`, `npm run start` |
| Worker | Background worker service | Recommended | `npm run build`, `npm run start:worker` |
| Whisper | Private service | Yes | `services/whisper/Dockerfile` |
| Postgres | Managed DB | No | Provider managed |
| Redis | Managed Redis | No | Provider managed |
| S3 | AWS S3 | No | AWS managed |
| n8n | Existing n8n cloud/self-hosted endpoint | Optional | n8n managed or self-hosted |

## Required Environment Variables

Core:

```env
NODE_ENV=production
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
INTEGRATION_ENCRYPTION_SECRET=
WEB_ORIGIN=
API_BASE_URL=
TRUST_PROXY=1
```

Storage:

```env
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=
S3_PRESIGN_TTL=3600
```

AI/transcription:

```env
AI_PROVIDER=fallback
WHISPER_URL=
WHISPER_MODEL=base
```

Rendering:

```env
RENDER_WORK_DIR=/tmp/autoedit
BACKGROUND_MUSIC_PATH=
BACKGROUND_MUSIC_VOLUME=0.1
RENDER_CONCURRENCY=1
RENDER_TIMEOUT_MS=3600000
```

Queues/workers:

```env
ANALYSIS_CONCURRENCY=1
ANALYSIS_LOCK_DURATION_MS=900000
MEMORY_THRESHOLD_MB=1536
```

Optional integrations:

```env
N8N_BASE_URL=
N8N_API_KEY=
N8N_WEBHOOK_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
```

Claude is intentionally not required for this deployment plan. For fallback-only deployment, set `AI_PROVIDER=fallback`; `ANTHROPIC_API_KEY` is not required unless `AI_PROVIDER=claude`. Claude can remain disconnected.

## Docker Requirements

Needs Docker:

- Whisper sidecar
- Worker is strongly recommended as Docker because it needs FFmpeg/ffprobe behavior to match production
- API is recommended as Docker if the deployment target does not guarantee the same Node/native package environment

May not need Docker:

- Next.js web
- Managed Postgres
- Managed Redis
- S3

## Deployment Risks

### FFmpeg Availability

The API/worker uses `ffmpeg-static`, `ffprobe-static`, and `fluent-ffmpeg`.

Risk:

- Container or PaaS file permissions/path behavior may differ from local Windows.

Mitigation:

- Run one render smoke test after deploy.
- Keep worker in Docker if possible.

### Whisper RAM/CPU

Whisper sidecar is CPU-capable but compute-heavy.

Risk:

- Slow transcription or service restarts on small instances.

Mitigation:

- Start with `WHISPER_MODEL=base`, CPU, int8.
- Scale sidecar separately later.

### S3 Region Latency

Uploads, worker source downloads, and render output uploads all depend on S3 region latency.

Risk:

- Slow uploads or transient failures if compute and S3 are far apart.

Mitigation:

- Co-locate compute with S3.
- Keep bounded S3 PUT retry.

### Upload Timeout Limits

Browser uploads go directly to S3, but API still handles start/part/complete.

Risk:

- PaaS request timeouts affect `/api/upload/complete`, especially metadata probe download.

Mitigation:

- Metadata probe is now non-fatal.
- Keep chunk sizes reasonable.
- Monitor `upload.probe_metadata_failed`.

### Worker Restarts

BullMQ jobs may retry whole jobs after worker restart.

Risk:

- Long renders may restart or duplicate work.

Mitigation:

- Keep `RENDER_CONCURRENCY=1` initially.
- Use durable Redis.
- Watch failed job counts.

### Rate Limits Behind Proxy

Rate limits depend on correct client IP for auth routes.

Risk:

- Wrong IP grouping if proxy trust is misconfigured.

Mitigation:

- Set `TRUST_PROXY=1` behind a trusted single proxy.
- Verify login/register throttling in staging.

### Presigned URL Expiry

Render URLs and upload URLs expire.

Risk:

- n8n automations or users may access URLs too late.

Mitigation:

- Keep `S3_PRESIGN_TTL=3600` for MVP.
- n8n workflows should download promptly.

## First Deployment Checklist

1. Create managed Postgres.
2. Create managed Redis.
3. Confirm S3 bucket region and CORS exposes `ETag`.
4. Deploy Whisper private service.
5. Deploy API with `AI_PROVIDER=fallback`.
6. Run `npx prisma migrate deploy`.
7. Deploy worker.
8. Deploy web with `NEXT_PUBLIC_API_BASE_URL`.
9. Run health checks:
   - `/health/db`
   - `/health/redis`
   - `/health/s3`
10. Run smoke test:
   - register
   - upload
   - transcription
   - fallback timeline
   - render
   - final S3 output

## No-Go Conditions

Do not open public access if:

- S3 health fails.
- Redis health fails.
- Postgres migrations fail.
- Whisper is unreachable.
- Worker cannot process analysis/render jobs.
- Upload cannot complete a small test video.
- Render output does not upload to S3.
