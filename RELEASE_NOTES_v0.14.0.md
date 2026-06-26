# AutoEdit AI v0.14.0 - Hybrid Deploy Execution Prep

## Summary

This release prepares the actual manual execution path for the hybrid free deployment.

Claude remains skipped:

```env
AI_PROVIDER=fallback
```

No deployment is performed automatically.

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
- Local PC must stay on.
- Worker stops if the PC sleeps or loses internet.
- Local Whisper and FFmpeg are not production-grade infrastructure.
- This setup is for staging, demos, and cost-free validation, not production.

## Next Step

Manual deployment:

1. Create Neon database.
2. Create Upstash Redis.
3. Deploy Render/Railway API.
4. Deploy Vercel web.
5. Fill local `apps/api/.env` from `apps/api/.env.hybrid.example`.
6. Run `npm run smoke:hybrid`.
7. Start local worker.
8. Run one full upload/fallback/render/S3 smoke test.
