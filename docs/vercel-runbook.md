# Vercel Frontend Deployment Runbook

This runbook deploys only the AutoEdit AI Next.js frontend to Vercel and connects it to the already-running Render API.

Render API:

```text
https://autoedit-ai.onrender.com
```

The hybrid backend remains unchanged:

- API runs on Render.
- Database runs on Neon.
- Redis runs on Upstash.
- S3 remains AWS S3.
- Worker, Whisper, and FFmpeg remain local.
- `AI_PROVIDER=fallback`.
- Claude remains disabled.

## 1. Create Vercel Project

Manual action:

1. Open Vercel.
2. Create a new project.
3. Import the GitHub repository.

## 2. Configure Project Settings

Use these settings:

| Setting | Value |
| --- | --- |
| Framework | Next.js |
| Root Directory | `apps/web` |
| Install Command | `npm install` |
| Build Command | `npm run build` |

No backend services run on Vercel.

## 3. Add Environment Variable

Set this in the Vercel project:

```env
NEXT_PUBLIC_API_BASE_URL=https://autoedit-ai.onrender.com
```

Do not use localhost in Vercel.

The frontend reads this variable in:

```text
apps/web/src/lib/api.ts
```

## 4. Deploy

Manual action:

1. Trigger the Vercel deployment.
2. Wait for build to complete.
3. Copy the final Vercel URL.

## 5. Update Render CORS

After Vercel provides the final URL, update the Render API environment variable:

```env
WEB_ORIGIN=https://YOUR_VERCEL_APP.vercel.app
```

Then redeploy or restart the Render API.

The API uses `WEB_ORIGIN` for CORS in:

```text
apps/api/src/app.ts
```

Do not use wildcard CORS with credentials.

## 6. Verify Browser Flow

After Render restarts:

1. Open the Vercel URL.
2. Open browser dev tools.
3. Register or log in.
4. Confirm requests go to `https://autoedit-ai.onrender.com`.
5. Confirm no request goes to `localhost:4000`.
6. Confirm authenticated API calls do not fail with CORS errors.

## 7. Hybrid Pipeline Reminder

For full upload-to-render testing, local services must also be running:

```powershell
docker compose up -d whisper
cd apps/api
npm run worker
```

The frontend deployment alone does not process jobs. The local worker must stay awake and connected to Upstash Redis.
