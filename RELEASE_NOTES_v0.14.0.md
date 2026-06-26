# AutoEdit AI v0.14.0 - Hybrid Deployment Success

## Summary

This release prepares and validates the first successful hybrid free deployment smoke test for AutoEdit AI.

Claude remains skipped:

```env
AI_PROVIDER=fallback
```

The deployment uses Vercel for the frontend, Render for the API, Neon for Postgres, Upstash for Redis, AWS S3 for storage, and the local PC for the worker, Whisper, and FFmpeg rendering.

## What's New

- Manual hybrid deployment runbook
- Placeholder-only API hybrid env example
- Placeholder-only web hybrid env example
- Non-destructive hybrid smoke check script
- `npm run smoke:hybrid`
- Updated hybrid smoke test flow
- Vercel frontend deployment runbook
- Render API integration guidance for `NEXT_PUBLIC_API_BASE_URL`
- Render `WEB_ORIGIN` CORS update step after Vercel URL is assigned

## Successful Hybrid Smoke Test

The first hybrid deployment smoke test passed end-to-end.

Verified:

- Vercel frontend loaded successfully
- Render API health passed
- Neon database connected
- Upstash Redis connected
- AWS S3 connected
- Local Whisper running
- Local worker running
- Auth registration passed
- Upload start passed
- Upload part passed
- Upload complete passed
- Upstash queue received the job
- Local worker consumed the job
- Whisper transcription ran
- Fallback analysis ran
- FFmpeg render completed
- All render formats completed:
  - short
  - reel
  - landscape
- All final outputs uploaded to S3
- Project reached `RENDERED`

## Current Architecture

- Frontend: Vercel
- API: Render
- Database: Neon Postgres
- Redis: Upstash Redis
- Storage: AWS S3
- Worker: local PC
- Whisper: local Docker sidecar
- Rendering: local FFmpeg
- AI: fallback provider

## Smoke Check Coverage

The smoke script checks:

- required env vars are present
- `AI_PROVIDER=fallback`
- Anthropic key is not required
- Upstash/Redis ping succeeds
- S3 bucket is reachable
- local Whisper health endpoint is reachable

The script does not upload files, create database records, enqueue jobs, or mutate S3.

## Caveats

- Render free may sleep.
- Vercel frontend must set `NEXT_PUBLIC_API_BASE_URL=https://autoedit-ai.onrender.com`.
- Render API must update `WEB_ORIGIN` to the final Vercel URL after deployment.
- Railway free/trial availability depends on account status.
- Upstash free limits may affect BullMQ reliability.
- Upstash free Redis reported an eviction policy warning: `optimistic-volatile` instead of `noeviction`.
- Local PC must stay on.
- Worker stops if the PC sleeps or loses internet.
- Local Whisper and FFmpeg are not production-grade infrastructure.
- Claude remains skipped.
- This setup is for staging, demos, and cost-free validation, not production.

## Next Step

Use the hybrid deployment for continued staging validation, then decide whether to harden toward production hosting or keep the local-worker architecture for demos.
