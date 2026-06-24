# Hybrid Free Deployment Runbook

This runbook prepares AutoEdit AI for a hybrid free deployment:

- Cloud frontend on Vercel Free
- Cloud API on Render Free or Railway free/trial
- Neon Free PostgreSQL
- Upstash Free Redis
- Existing AWS S3 bucket
- Local PC worker, Whisper, FFmpeg, and render scratch

Claude remains skipped:

```env
AI_PROVIDER=fallback
```

Do not paste real secrets into Git. Stop at each dashboard step and complete it manually.

## 1. Create Neon Database

Manual action:

1. Open Neon.
2. Create a new project for AutoEdit AI staging.
3. Choose a region close to the API host and S3 bucket when possible.
4. Create or select the staging database.

## 2. Copy Neon `DATABASE_URL`

Copy the pooled runtime connection string for the API and worker.

Expected format:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require
```

For migrations, use a direct Neon connection in a trusted shell if Neon provides one.

## 3. Create Upstash Redis

Manual action:

1. Open Upstash.
2. Create a Redis database.
3. Choose a region close to the API host if possible.
4. Copy the TLS Redis URL.

Expected format:

```env
REDIS_URL=rediss://default:PASSWORD@HOST:PORT
```

The API and local worker must use the same Redis database.

## 4. Create Render API Service

Manual action:

1. Open Render.
2. Create a new Web Service from the GitHub repo.
3. Use `render.yaml` if using Blueprint, or configure manually:
   - Root directory: `apps/api`
   - Build command: `npm install && npx prisma generate && npm run build`
   - Start command: `npx prisma migrate deploy && npm run start`
   - Health path: `/health/db`

Do not create a paid worker service for this hybrid plan.

## 5. Add Render Environment Variables

Set placeholder-equivalent real values only in the Render dashboard:

```env
NODE_ENV=production
API_PORT=4000
TRUST_PROXY=1
DATABASE_URL=<Neon DATABASE_URL>
REDIS_URL=<Upstash rediss URL>
JWT_SECRET=<strong secret>
INTEGRATION_ENCRYPTION_SECRET=<32+ char secret>
WEB_ORIGIN=<Vercel frontend URL>
API_BASE_URL=<Render API URL>
AWS_REGION=<your S3 region>
AWS_ACCESS_KEY_ID=<your key>
AWS_SECRET_ACCESS_KEY=<your secret>
S3_BUCKET=<your bucket>
AI_PROVIDER=fallback
RENDER_WORK_DIR=/tmp/autoedit
```

`ANTHROPIC_API_KEY` is not required for fallback mode.

## 6. Run Prisma Migration Against Neon

Option A: Render start command runs migrations automatically:

```bash
npx prisma migrate deploy && npm run start
```

Option B: run manually from a trusted local shell:

```powershell
cd apps/api
$env:DATABASE_URL="<Neon direct migration URL>"
npx prisma generate
npx prisma migrate deploy
```

Do not commit Neon URLs.

## 7. Create Vercel Project For `apps/web`

Manual action:

1. Open Vercel.
2. Import the GitHub repo.
3. Set root directory to `apps/web`.
4. Keep framework preset as Next.js.
5. Set install command to `npm install` if needed.
6. Set build command to `npm run build` if needed.

## 8. Set Web API URL

Set in Vercel:

```env
NEXT_PUBLIC_API_BASE_URL=<Render API URL>
```

The current app uses `NEXT_PUBLIC_API_BASE_URL`, not `NEXT_PUBLIC_API_URL`.

## 9. Configure Local Worker Environment

Copy `apps/api/.env.hybrid.example` to `apps/api/.env`, then fill real values locally only.

Do not commit `apps/api/.env`.

The local worker must use the same:

- Neon database as the API
- Upstash Redis as the API
- S3 bucket as the API

## 10. Start Local Whisper

From the repo root:

```powershell
docker compose up -d whisper
```

Verify:

```powershell
Invoke-RestMethod http://localhost:9000/health
```

## 11. Run Hybrid Smoke Check

From `apps/api`:

```powershell
npm run smoke:hybrid
```

Expected:

- required env vars present
- `AI_PROVIDER=fallback`
- no Anthropic key required
- S3 bucket reachable
- Redis ping succeeds
- local Whisper health succeeds

## 12. Start Local Worker

From `apps/api`:

```powershell
npm run worker
```

Leave this terminal running.

## 13. Run Smoke Test

1. Open Vercel frontend.
2. Register or log in.
3. Upload a short 10-30 second MP4.
4. Confirm API stores upload in S3.
5. Confirm API enqueues job in Upstash Redis.
6. Confirm local worker receives job.
7. Confirm worker calls local Whisper.
8. Confirm worker renders locally.
9. Confirm worker uploads final outputs to S3.
10. Confirm frontend/API shows project `RENDERED`.

## Stop Conditions

Stop and fix before continuing if:

- Render API cannot boot.
- Neon migration fails.
- Upstash Redis ping fails.
- S3 bucket check fails.
- Local Whisper `/health` fails.
- Local worker cannot connect to Redis.
- Upload completes but worker never receives a job.
