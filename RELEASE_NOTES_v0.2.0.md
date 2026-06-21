# AutoEdit AI v0.2.0 - Backend Integrations

Release tag: `v0.2.0-backend-integrations`

## Summary

AutoEdit AI v0.2.0 builds on the validated `v0.1.0-local-pipeline` release. This release adds backend-only Claude and n8n connector support while preserving the working upload, transcription, fallback timeline, render, and final S3 output pipeline.

No frontend integration UI is included in this release.

## What's New

- Added `IntegrationAccount` database model.
- Added `IntegrationEventLog` database model.
- Added encrypted Claude credential storage.
- Added backend Claude integration routes:
  - `POST /api/integrations/claude/connect`
  - `POST /api/integrations/claude/test`
  - `GET /api/integrations/claude/status`
  - `DELETE /api/integrations/claude/disconnect`
- Added backend n8n integration routes:
  - `POST /api/integrations/n8n/connect`
  - `POST /api/integrations/n8n/test`
  - `GET /api/integrations/n8n/status`
  - `DELETE /api/integrations/n8n/disconnect`
- Added best-effort n8n event dispatch.
- Added HMAC SHA-256 signing for n8n webhook payloads with `X-AutoEdit-Signature`.
- Added backend event dispatch points for:
  - `project.created`
  - `upload.completed`
  - `transcript.completed`
  - `render.completed`
  - `render.failed`
- Added per-user Claude key lookup support for analysis jobs.

## Bug Fixes

- Fixed BigInt serialization on project API responses.
- Fixed the local integration encryption environment gap by documenting and validating `INTEGRATION_ENCRYPTION_SECRET`.
- Confirmed the v0.1 local upload, transcription, fallback, render, and S3 output pipeline still works after backend integration changes.

## Required Configuration

`INTEGRATION_ENCRYPTION_SECRET` is required for Claude and n8n integrations.

Requirements:

- Must be at least 32 characters.
- Must never be committed.
- Must be added locally to `apps/api/.env`.
- Must be configured as a deployment environment variable in production.

Example placeholder only:

```env
INTEGRATION_ENCRYPTION_SECRET=replace-with-32-byte-minimum-random-secret
```

Keep all real `.env` files ignored.

## Verified

- Prisma migration applied.
- No Prisma drift detected.
- API build passed.
- Web build passed.
- v0.1 pipeline regression passed.
- S3 upload passed.
- Whisper transcription passed.
- Fallback render passed.
- Final rendered outputs uploaded to S3.
- n8n success dispatch logged.
- n8n failure logged without breaking the main pipeline.
- Missing Claude key handling passed.
- Invalid Claude key handling passed.
- No secret leakage found in tracked files.

## Known Limitations

- Valid funded Claude key path is implemented but not yet runtime-tested with a real funded key.
- Frontend integrations UI is not built yet.
- Local Ollama may still fall back because smaller local models can produce weak or malformed structured JSON.
- n8n integration is backend-only for now.

## Upgrade Notes

- Run Prisma migrations before using the backend integration routes.
- Set `INTEGRATION_ENCRYPTION_SECRET` before connecting Claude or n8n.
- Keep `.env` files ignored.
- Do not merge future integration UI until the backend routes are stable in the target environment.

## Next Recommended Test

- Connect a real funded Claude key.
- Verify the per-user Claude analysis path.
- Confirm an AI-generated timeline is produced instead of the fallback timeline.

