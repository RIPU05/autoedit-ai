# AutoEdit AI v0.13.0 - Free-Tier Staging Prep

## Summary

This release prepares a free-tier staging deployment plan for AutoEdit AI.

It does not deploy production infrastructure and does not change product runtime behavior.

Claude remains skipped:

```env
AI_PROVIDER=fallback
```

## Target Free-Tier Stack

- Frontend: Vercel Free
- Backend API: Render Free Web Service
- Database: Neon Free PostgreSQL
- Redis: Upstash Free Redis
- Whisper: Hugging Face Spaces Docker CPU
- Storage: existing AWS S3 bucket
- Monitoring: Sentry Free planning
- AI: fallback provider

## What's New

- Vercel deployment guide for `apps/web`
- Render API blueprint via `render.yaml`
- Neon PostgreSQL migration guide
- Upstash Redis/BullMQ guide
- Hugging Face Docker Space guide for Whisper
- Sentry planning notes
- Free-tier staging checklist

## Verified Locally

- Web build should pass before deployment.
- API build should pass before deployment.
- Mocked regression tests should pass before deployment.
- No real Claude key is required for fallback mode.

## Important Staging Constraint

The full pipeline requires a long-running BullMQ worker.

The requested free stack includes Render Free Web Service for the API, but the worker still needs a separate free long-running process. This release documents that as a human dashboard decision. If no free worker host is available, the free staging deployment can validate API/web/DB/Redis/S3/Whisper health but cannot complete the full render pipeline.

## Known Limitations

- Deployment is not executed yet.
- No paid services are configured.
- Claude remains disabled.
- Sentry SDK instrumentation is not added yet.
- Whisper CPU on Hugging Face Spaces may be slow or cold start.
- Render Free Web Service may sleep.
- Free-tier worker hosting must be confirmed manually.

## Next Step

Manual deployment setup:

1. Create Neon database.
2. Create Upstash Redis.
3. Create Hugging Face Docker Space.
4. Create Render API service.
5. Choose/confirm free worker host.
6. Create Vercel web deployment.
7. Run Prisma migration.
8. Run one fallback upload/transcribe/render/S3 smoke test.
