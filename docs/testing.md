# Testing AutoEdit AI

AutoEdit AI uses Vitest for backend regression coverage.

## Commands

From `apps/api`:

```powershell
npm test
npm run test:regression
npm run build
```

`npm run test:regression` currently runs the same deterministic Vitest suite as `npm test`. It exists as the stable command for CI and future broader regression checks.

## What Is Covered

Route regression tests cover:

- Auth register/login/me.
- Project listing and project detail.
- Multipart upload start/part/complete.
- Claude integration status/connect/test/disconnect error handling.
- n8n integration connect/test/disconnect behavior.
- Health checks for db, redis, s3, and Ollama with mocks.
- Response checks to ensure saved secrets are not returned.

Worker regression tests cover:

- Analysis worker transcript persistence.
- No-audio analysis path with transcription skipped.
- AI provider fallback path.
- Fallback timeline persistence.
- Automatic render job enqueueing.
- Render worker completion and output upload path.
- Best-effort n8n render event dispatch.
- Render failure logging path.

## Mocking Strategy

The automated suite does not call real paid or cloud services.

Mocked:

- Prisma persistence uses in-memory test tables.
- S3 multipart and object operations.
- Anthropic/Claude HTTP calls.
- Ollama health response.
- Redis/BullMQ queues and workers.
- n8n dispatch.
- FFmpeg probe/transcription in route and worker tests.

Not mocked by default:

- Express routing/middleware.
- JWT signing and auth middleware.
- Integration credential encryption/masking.
- Route validation with Zod.

## Manual Pipeline Regression

The manual product regression still uses the real local stack:

```powershell
docker compose up -d postgres redis whisper
cd apps/api
powershell.exe -ExecutionPolicy Bypass -File tmp\run-v03-pipeline.ps1 -Mode disconnected -Title "manual regression"
```

Expected flow:

Upload -> S3 -> Whisper -> fallback timeline -> render -> final S3 output.

## Known Gaps

- Web UI tests are not included yet.
- Tests do not launch Docker services.
- Tests do not call real AWS, Anthropic, Ollama, or n8n.
- No-audio upload hardening remains a future branch.
- No-audio upload handling is covered at the worker level; full media regression should also be run manually when FFmpeg/worker behavior changes.
- Full FFmpeg media rendering remains covered by manual regression and focused render quality checks, not by CI tests.
