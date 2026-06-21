# AutoEdit AI v0.3.0 - n8n Workflows

Release tag: `v0.3.0-n8n-workflows`

## Summary

AutoEdit AI v0.3.0 builds on the v0.2.0 backend integrations release. It improves n8n workflow automation reliability, standardizes outbound n8n event payloads, adds workflow template documentation, and keeps frontend integration UI out of scope.

This release does not change the Claude path.

## What's New

- Standardized flat n8n event payloads.
- `render.completed` payloads now include:
  - `projectId`
  - `renderId`
  - `renderFormat`
  - `renderUrl`
  - `timestamp`
- Event logs now include `projectId` and `renderId` where available.
- `responseStatusCode` is captured for n8n webhook responses.
- Error messages are captured for failed n8n dispatch attempts.
- HMAC signing with `X-AutoEdit-Signature` was verified.
- Added backend test command for n8n webhook dispatch:

  ```powershell
  cd apps/api
  npm run test:n8n-webhook
  ```

- Added workflow template documentation:

  ```text
  docs/n8n-workflow-template.md
  ```

## Verified

- API build passed.
- Pipeline regression passed.
- n8n disconnected mode: render still completes.
- n8n connected-working mode: event reaches webhook.
- n8n connected-failing mode: failure is logged and render still completes.
- All three output formats rendered and uploaded to S3.

## Known Limitations

- No frontend integrations UI yet.
- n8n setup still requires API/manual route setup.
- Claude remains skipped for this release.
- Local AI may still use fallback mode.

## Next Step

- Build `/settings/integrations` frontend page later.
- Or continue with render polish, music, and crossfade improvements.

