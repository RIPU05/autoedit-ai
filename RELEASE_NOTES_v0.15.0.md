# AutoEdit AI v0.15.0 — Stable Hybrid Deployment

## Summary

This checkpoint marks the current stable hybrid deployment of AutoEdit AI.

The app is running with a Vercel frontend, Render API, Neon PostgreSQL, Upstash Redis, AWS S3 storage, and a local worker/Whisper setup. Browser upload through final rendered output has been verified.

## Verified

- Vercel frontend deployed and working
- Render API deployed and healthy
- Neon database connected
- Upstash Redis queue connected
- AWS S3 upload and output storage working
- Production CORS fixed
- Production auth cookies use cross-site-safe settings
- Browser login/register working
- Browser multipart upload working
- Local Whisper running
- Local worker running
- Upload to transcription to fallback analysis to render to S3 output working
- Project reaches `RENDERED`
- Multi-format render working
- Download working
- Timeline editor and version history present
- AI Director prompt path present

## Known Caveats

- Claude remains skipped
- `AI_PROVIDER=fallback` is the active deployment mode
- Local worker must stay running
- Local PC must not sleep during processing
- Upstash free tier reports an eviction policy warning
- Render free tier may cold start after inactivity
