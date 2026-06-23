# AutoEdit AI v0.12.0 - Deployment Architecture Planning

## Summary

This release plans the first practical deployment path for the current fallback-based AutoEdit AI product.

Claude remains skipped. The deployment target for this planning release is:

```env
AI_PROVIDER=fallback
```

No deployment is started in this release, and no application runtime logic is changed.

## What's Included

- Runtime service audit for web, API, worker, Whisper, Postgres, Redis, S3, and n8n
- Deployment options for Railway, Render, VPS with Docker Compose, and AWS ECS/Fargate
- Recommended first deployment path
- Region planning guidance
- Service map for deployable components
- Required environment variable checklist
- Docker requirements by service
- Deployment risks and no-go conditions
- First deployment checklist

## Recommended First Path

The recommended first hosted path is Render or Railway, with a bias toward Render if its private service and background worker model handles the Whisper sidecar cleanly.

If managed PaaS resource limits make Whisper or FFmpeg unreliable, the fallback recommendation is a VPS with Docker Compose for API, worker, Whisper, and Redis, plus managed Postgres and AWS S3.

AWS ECS/Fargate remains the strongest later production path, but it is more infrastructure than the project needs before first public validation.

## Required Services

- Next.js web app
- Express API
- BullMQ worker
- Whisper sidecar
- Postgres
- Redis
- AWS S3
- Optional n8n webhook receiver

## Required Configuration

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `INTEGRATION_ENCRYPTION_SECRET`
- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET`
- `TRUST_PROXY=1`
- `WHISPER_URL`
- `AI_PROVIDER=fallback`
- `BACKGROUND_MUSIC_PATH` only if background music should be enabled

Claude credentials are not part of the fallback deployment plan. `ANTHROPIC_API_KEY` is required only when `AI_PROVIDER=claude`; fallback-only deployment can boot without it.

## Deployment Risks

- FFmpeg and ffprobe availability in hosted workers
- Whisper RAM and CPU requirements
- S3 region latency during upload, worker download, and output upload
- Upload and completion timeout limits
- Background worker restarts during long renders
- Rate limiting behind production proxies
- Presigned render URL expiry for n8n workflows and user downloads

## Known Limitations

- Claude remains skipped.
- The product deploys first with fallback editing, not paid AI editing.
- Public deployment has not started.
- Live deployment smoke testing is still required.
- Whisper resource sizing must be validated on the chosen host.
- Claude can remain disconnected for fallback-only deployment.

## Next Step

Recommended next branch:

```text
feature/deployment-staging-v0.13
```

Goal: perform the first staging deployment with `AI_PROVIDER=fallback`, verify health checks, and run one full upload/transcribe/fallback/render/S3 smoke test.
