# AutoEdit AI v0.10.0 — n8n Auto-Publishing Readiness

## Summary

This release makes AutoEdit AI's n8n integration more practical for auto-publishing workflows after render completion.

It builds on the existing v0.3 n8n dispatch system and keeps Claude skipped. Deployment is still not started.

## What's New

### Publishing-Ready `render.completed` Payload

`render.completed` events now include top-level fields useful for downstream automation:

* `projectId`
* `userId`
* `renderId`
* `renderFormat`
* `outputS3Key`
* `renderUrl`
* `renderUrlExpiresAt`
* `expiresInSeconds`
* `projectTitle`
* `createdAt`
* `timestamp`

`renderUrl` is a presigned S3 download URL. The bucket remains private.

### Workflow Templates

Added:

* `docs/n8n-auto-publishing.md`

Starter workflows include:

* Discord notification
* Google Drive save
* Google Sheets log
* Telegram notification
* YouTube publishing notes

Updated:

* `docs/n8n-workflow-template.md`

## Verified

* API build passed
* Regression tests passed
* n8n event payload tests updated
* render.completed includes a usable presigned render URL
* output S3 key is included at the top level
* n8n dispatch remains best-effort
* render pipeline logic remains unchanged
* no secrets are exposed in payloads

## Platform Credential Caveats

AutoEdit does not store or ship platform publishing credentials in code.

Publishing destinations are configured inside n8n:

* YouTube requires Google OAuth/API credentials.
* Google Drive and Google Sheets require Google OAuth credentials.
* Telegram requires a bot token.
* Discord can use a Discord node or webhook.
* TikTok and Instagram publishing may require platform API access, app review, or business account approvals.

## Presigned URL Caveat

`renderUrl` expires according to `S3_PRESIGN_TTL`.

n8n workflows should download or forward the render promptly. Store `outputS3Key` when a durable backend reference is needed.

Delayed workflows should refresh the URL through the backend or download the file before expiry.

Temporary local webhook harness files used during validation are not included in this release.

## Known Limitations

* Claude remains skipped.
* Deployment has not started.
* Live platform publishing credentials are not included.
* TikTok/Instagram direct publishing may require approval outside AutoEdit.
* Live full pipeline regression remains manual.

## Next Step

Recommended next branches:

* deployment hardening
* public deployment smoke tests
* Stripe / usage limits
* real Claude key test
* platform-specific n8n examples after deployment
