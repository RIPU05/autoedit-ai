# Vercel Free Deployment - Web

This document prepares the AutoEdit AI frontend for Vercel Free. It does not deploy the app.

## What Runs On Vercel

Vercel should host only the Next.js web app in `apps/web`.

Do not run the Express API, BullMQ worker, Whisper sidecar, Redis, or Postgres on Vercel.

## Project Settings

Use these Vercel settings:

| Setting | Value |
| --- | --- |
| Framework preset | Next.js |
| Root directory | `apps/web` |
| Install command | `npm install` |
| Build command | `npm run build` |
| Output directory | Vercel default for Next.js |

Vercel usually auto-detects the Next.js build when the root directory is set to `apps/web`.

## Environment Variables

Set these in the Vercel dashboard:

```env
NEXT_PUBLIC_API_BASE_URL=https://YOUR_RENDER_API_HOST
```

The current frontend code reads `NEXT_PUBLIC_API_BASE_URL` in `apps/web/src/lib/api.ts`.

Do not use `NEXT_PUBLIC_API_URL` unless the frontend code is changed later. For v0.13, keep the existing variable name.

## Manual Dashboard Step

Stop here for human action:

1. Create/import the GitHub repo in Vercel.
2. Set root directory to `apps/web`.
3. Add `NEXT_PUBLIC_API_BASE_URL`.
4. Deploy.

## Verification

After deployment:

1. Open the Vercel URL.
2. Confirm the home page loads.
3. Confirm login/register requests target the Render API URL.
4. Confirm no browser console error says `localhost:4000`.

## Known Free-Tier Caveats

- The frontend can deploy independently.
- Upload and render workflows depend on the API and worker being reachable.
- If the Render API is asleep, the first request may be slow or fail once before retry.
