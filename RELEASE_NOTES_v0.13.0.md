# AutoEdit AI v0.13.0 - Hybrid Free Deployment Prep

## Summary

This release prepares a hybrid free-tier staging deployment plan for AutoEdit AI.

It does not deploy production infrastructure and does not change product runtime behavior.

Claude remains skipped:

```env
AI_PROVIDER=fallback
```

## Target Hybrid Stack

- Frontend: Vercel Free
- Backend API: Render Free Web Service or Railway free/trial web service
- Database: Neon Free PostgreSQL
- Redis: Upstash Free Redis
- Storage: existing AWS S3 bucket
- Worker: local PC
- Whisper: local Docker sidecar
- FFmpeg rendering: local PC
- DNS: Cloudflare later
- Monitoring: Sentry later
- AI: fallback provider

## What's New

- Hybrid deployment guide for cloud API/frontend plus local worker
- Vercel deployment guide for `apps/web`
- Render API blueprint via `render.yaml`
- Render API deployment guide
- Neon PostgreSQL migration guide
- Upstash Redis/BullMQ guide
- Hugging Face Docker Space guide retained as an alternate Whisper reference
- Sentry planning notes
- Hybrid staging checklist
- Hybrid smoke test runbook

## Verified Locally

- Web build passed.
- API build passed.
- Mocked regression tests passed.
- No real Claude key is required for fallback mode.

## Important Staging Constraint

The full pipeline requires a long-running BullMQ worker.

For this hybrid plan, the worker runs on the local PC and consumes jobs from the same Upstash Redis queue used by the cloud API. The PC must stay awake and connected for jobs to process.

## Known Limitations

- Deployment is not executed yet.
- No paid services are configured.
- Claude remains disabled.
- Sentry SDK instrumentation is not added yet.
- Render/Railway free web service may sleep.
- Local PC must stay on for worker/Whisper/FFmpeg processing.
- Upstash and cloud-host free limits may affect reliability.
- This is not production-grade.

## Next Step

Manual deployment setup:

1. Create Neon database.
2. Create Upstash Redis.
3. Create Render or Railway API service.
4. Create Vercel web deployment.
5. Configure local worker env against Neon, Upstash, and S3.
6. Start local Whisper and worker.
7. Run Prisma migration.
8. Run one fallback upload/transcribe/render/S3 smoke test.
