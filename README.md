# AutoEdit AI

[![AutoEdit AI CI](https://github.com/RIPU05/autoedit-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/RIPU05/autoedit-ai/actions/workflows/ci.yml)

AutoEdit AI is an AI-assisted video editing pipeline for turning uploaded videos into edited, captioned, render-ready outputs. It supports cloud storage through S3, local transcription through Whisper, local or cloud AI analysis, FFmpeg rendering, and a fallback timeline path when external AI is unavailable.

## Main Features

- User authentication and project dashboard
- S3 multipart video upload
- PostgreSQL persistence through Prisma
- Redis/BullMQ background workers
- Whisper sidecar transcription
- AI analysis with Claude or local Ollama/Qwen
- Fallback timeline generation when AI providers fail
- FFmpeg render pipeline
- Final rendered video upload to S3
- Health checks for database, Redis, S3, Claude, and Ollama

## Current Status

| Area | Status |
| --- | --- |
| Upload | Working |
| S3 | Working |
| Whisper | Working |
| Transcription | Working |
| Fallback timeline | Working |
| Render | Working |
| Final S3 output | Working |
| Claude | Optional / requires credits |
| Ollama | Optional / local model may fallback |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js, React, TypeScript, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL, Prisma |
| Queue | Redis, BullMQ |
| Storage | AWS S3 multipart upload and signed URLs |
| Transcription | Faster-Whisper sidecar |
| AI | Anthropic Claude, Ollama/Qwen, fallback provider |
| Rendering | FFmpeg |
| Local infra | Docker Compose |

## Architecture Flow

```text
Browser / Next.js web app
  -> Express API
  -> S3 multipart upload
  -> PostgreSQL project and asset records
  -> Redis/BullMQ analysis job
  -> Worker downloads source video from S3
  -> FFmpeg probe and audio extraction
  -> Whisper transcription
  -> Claude or Ollama analysis
  -> fallback timeline if AI is unavailable
  -> timeline and edit version saved to database
  -> render job queued
  -> FFmpeg render
  -> final output uploaded to S3
```

## Repository Layout

```text
autoedit-ai/
  apps/
    api/                Express API, Prisma, workers, FFmpeg pipeline
    web/                Next.js frontend
  services/
    whisper/            Whisper sidecar service
  infra/                Deployment notes
  docker-compose.yml    Local Postgres, Redis, Whisper services
  .env.example          Safe environment template
```

## Local Setup

Prerequisites:

- Node.js 20 or newer
- npm
- Docker Desktop
- FFmpeg support through the project dependencies
- AWS S3 bucket and IAM credentials for upload/render output
- Optional: Ollama for free local AI analysis
- Optional: Anthropic API key for Claude analysis

Install dependencies:

```powershell
cd apps/api
npm install

cd ../web
npm install
```

Create environment files:

```powershell
Copy-Item .env.example .env
Copy-Item .env.example apps/api/.env
```

Fill in real values in `apps/api/.env`. Do not commit `.env` files.

## Docker Setup

Start local infrastructure:

```powershell
docker compose up -d postgres redis whisper
```

Check containers:

```powershell
docker compose ps
```

Expected local services:

- PostgreSQL on `localhost:5432`
- Redis on `localhost:6379`
- Whisper sidecar on `localhost:9000`

## Database Migration

From `apps/api`:

```powershell
npx prisma generate
npx prisma migrate dev
```

Check migration status:

```powershell
npx prisma migrate status
```

## Running The API

From `apps/api`:

```powershell
npm run dev
```

The API should be available at:

```text
http://localhost:4000
```

Useful health checks:

```text
http://localhost:4000/health/db
http://localhost:4000/health/redis
http://localhost:4000/health/s3
http://localhost:4000/health/ollama
http://localhost:4000/health/claude
```

## Running The Worker

From `apps/api`, in a separate terminal:

```powershell
npm run worker
```

The worker processes analysis and render jobs from Redis/BullMQ.

## Running The Web App

From `apps/web`:

```powershell
npm run dev
```

The web app should be available at:

```text
http://localhost:3000
```

## S3 Setup Notes

Create an S3 bucket in the same region configured by `AWS_REGION`.

The IAM user or role needs permissions for the configured bucket, including:

- `s3:ListBucket`
- `s3:GetBucketLocation`
- `s3:GetBucketCors`
- `s3:PutObject`
- `s3:GetObject`
- `s3:DeleteObject`
- `s3:AbortMultipartUpload`
- `s3:ListBucketMultipartUploads`
- `s3:ListMultipartUploadParts`

Bucket CORS should allow browser uploads and expose `ETag`:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

## Ollama Setup Notes

Ollama is optional. If enabled, it can run local AI analysis before falling back to the basic timeline generator.

Install and start Ollama, then pull a model:

```powershell
ollama pull qwen3:1.7b
```

Recommended local settings:

```env
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:1.7b
```

If Ollama returns invalid JSON, times out, or is unavailable, the worker should use the fallback timeline path.

## Claude Setup Notes

Claude is optional and requires a valid Anthropic API key with available credits.

```env
AI_PROVIDER=claude
ANTHROPIC_API_KEY=your-anthropic-api-key
```

If Claude is unavailable due to authentication, billing, rate limits, or credits, the app can fall back to a basic timeline.

## Whisper Setup Notes

The local Whisper sidecar is started by Docker Compose:

```powershell
docker compose up -d whisper
```

The API expects:

```env
WHISPER_URL=http://localhost:9000
```

## Build Commands

API:

```powershell
cd apps/api
npm run build
```

Web:

```powershell
cd apps/web
npm run build
```

## Known Limitations

- Claude requires valid billing and credits.
- Local Ollama performance depends heavily on the machine and selected model.
- Ollama responses may fall back if strict JSON generation fails.
- Render performance depends on video length, FFmpeg behavior, disk speed, and CPU.
- Production hardening still needs rate limiting, stronger observability, complete route tests, and deployment-specific security review.

## Security Notes

- Never commit `.env` files.
- Never commit AWS credentials.
- Never commit Anthropic keys.
- Use a long random `JWT_SECRET`.
- Use least-privilege IAM permissions for S3.
- Rotate leaked credentials immediately.
