# AutoEdit AI v0.4.0 - Integrations UI

Release tag: `v0.4.0-integrations-ui`

## Summary

AutoEdit AI v0.4.0 builds on the v0.3.0 n8n workflow automation release. It adds frontend UI for the existing backend Claude and n8n connectors, making integrations usable directly from the app while keeping Claude optional and skippable.

## What's New

- Added `/settings/integrations` page.
- Added Claude connector card.
- Added n8n connector card.
- Added status badges for Connected, Disconnected, and Error states.
- Added connect, test, and disconnect actions.
- Added clear success and error messages.
- Added navigation link to the integrations page from dashboard and settings.
- Added frontend secret masking behavior:
  - saved Claude API keys are never displayed
  - saved n8n signing secrets are never displayed
  - n8n only shows whether a signing secret exists

## Verified

- Web build passed.
- API build passed.
- `/settings/integrations` returns 200.
- Claude invalid-key path is handled safely.
- n8n webhook test works.
- Secrets are not displayed after saving.
- v0.1 pipeline regression still passes.
- Upload, transcription, fallback timeline, render, and S3 output still work.

## Known Limitations

- Valid funded Claude key path is still not runtime-tested.
- Claude can remain skipped.
- No public deployment yet.
- Local Ollama may still use fallback mode.
- UI is functional, not final polished design.

## Next Step

Possible next branches:

- Render polish: music and crossfade.
- Route-test suite.
- Public deployment.
- Stripe monetization.

