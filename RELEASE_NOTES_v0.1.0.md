# AutoEdit AI v0.1.0 Local Pipeline

Release tag: `v0.1.0-local-pipeline`

This release is the first stable local checkpoint for the AutoEdit AI video pipeline. It confirms the core upload, transcription, timeline, render, and storage flow can run locally with real S3 storage and local infrastructure.

## What Works

- User authentication and dashboard flow
- Project creation and project listing
- AWS S3 bucket connectivity
- Multipart upload to S3
- Worker download of uploaded media from S3
- FFmpeg video probe and silence detection
- Whisper transcription through the local sidecar
- Transcript storage in PostgreSQL
- Fallback timeline generation when external AI is unavailable
- Render queue processing through Redis/BullMQ
- FFmpeg render pipeline
- Final rendered output upload to S3
- Health checks for database, Redis, S3, Claude, and Ollama
- Safe fallback behavior when Claude or Ollama cannot produce a valid analysis

## Current Limitations

- This is a local pipeline release, not a production launch release.
- Claude requires a valid Anthropic API key with available credits.
- Ollama analysis depends on local hardware and model quality.
- Smaller Ollama models may return invalid or incomplete JSON.
- The fallback timeline is functional but intentionally basic.
- Long videos may require more render time, disk space, and worker tuning.
- Production observability, rate limiting, alerting, and full route test coverage still need hardening.
- Deployment-specific security review is still required before public launch.

## Required Services

Local development requires:

- PostgreSQL
- Redis
- Whisper sidecar
- AWS S3 bucket
- API server
- Worker process
- Next.js web app

Optional AI providers:

- Ollama for local AI analysis
- Anthropic Claude for cloud AI analysis

## Local Setup Summary

1. Install dependencies in `apps/api` and `apps/web`.
2. Copy `.env.example` to a local `.env` file and `apps/api/.env`.
3. Fill in local database, Redis, S3, JWT, and AI provider values.
4. Start local infrastructure:

   ```powershell
   docker compose up -d postgres redis whisper
   ```

5. Run Prisma from `apps/api`:

   ```powershell
   npx prisma generate
   npx prisma migrate dev
   ```

6. Start the API:

   ```powershell
   cd apps/api
   npm run dev
   ```

7. Start the worker in a second terminal:

   ```powershell
   cd apps/api
   npm run worker
   ```

8. Start the web app:

   ```powershell
   cd apps/web
   npm run dev
   ```

## Known AI Limitation With Ollama

Ollama support is present and can be selected with:

```env
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:1.7b
```

On lower-end local hardware, larger models such as `qwen3:8b` may be too slow for the analysis worker. Smaller models such as `qwen3:1.7b` are faster, but may still return malformed JSON. When this happens, the worker should log the Ollama failure and continue through the fallback timeline generator.

## Claude Provider Note

Claude support remains available and is intended for higher-quality analysis when an Anthropic API key has valid billing and credits.

Use:

```env
AI_PROVIDER=claude
ANTHROPIC_API_KEY=your-anthropic-api-key
```

If Claude is unavailable because of authentication, billing, credits, rate limits, or provider errors, the pipeline can continue through fallback timeline generation.

## Next Roadmap

- Improve structured JSON reliability for local Ollama analysis.
- Add stronger validation and repair for AI timeline responses.
- Add route and worker integration tests for upload, analysis, render, and download flows.
- Add production rate limiting and abuse protection.
- Add operator-visible failed job reporting.
- Improve render progress reporting in the UI.
- Add production deployment documentation for managed Postgres, Redis, S3, and worker scaling.
- Add monitoring, logs, alerts, and error tracking.
- Harden S3 IAM policy and environment validation for production.

