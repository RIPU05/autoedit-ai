# AutoEdit AI

AI-powered video editing automation platform. Upload a video, Claude analyzes it
(highlights, silence, speakers, captions, titles, social copy), an FFmpeg/Remotion
pipeline renders the result, and n8n workflows are triggered for publishing.

> This repository is a **production-ready scaffold**. Core integration logic
> (Claude, n8n, FFmpeg, BullMQ queue, S3 multipart upload, JWT + Google OAuth)
> is fully implemented. Some UI screens and edge cases are stubbed and marked
> with `// TODO` so you can extend them for your exact product.

---

## 1. Architecture

```
                         ┌─────────────────────────┐
                         │   Next.js 15 (apps/web)  │
                         │  React, Tailwind, shadcn │
                         └────────────┬─────────────┘
                                      │ REST + JWT (httpOnly cookie)
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Express API (apps/api)                           │
│  auth · projects · upload(S3 multipart) · render · n8n · webhooks      │
└───┬───────────────┬──────────────────┬──────────────┬─────────────────┘
    │               │                  │              │
    ▼               ▼                  ▼              ▼
┌─────────┐   ┌────────────┐    ┌─────────────┐  ┌──────────────┐
│PostgreSQL│   │   Redis    │    │   AWS S3     │  │  Claude API  │
│ (Prisma) │   │ (BullMQ)   │    │ (originals + │  │ (analysis +  │
│          │   │  queues    │    │  renders)    │  │  content gen)│
└─────────┘   └─────┬──────┘    └─────────────┘  └──────────────┘
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
┌────────────────┐      ┌────────────────────┐
│ analysis worker│      │   render worker     │
│ (Claude calls) │      │ (FFmpeg pipeline)   │
└───────┬────────┘      └─────────┬───────────┘
        │                         │
        └──────────► n8n ◄────────┘
            (trigger workflows, receive status via webhook)
```

**Data flow for one project**

1. User uploads video → S3 multipart, `Project` + `Asset` rows created.
2. `analysis` job enqueued → worker extracts metadata + audio, asks Claude for an
   editing strategy, persists an `EditTimeline`, captions, titles, descriptions.
3. User approves/edits the timeline → `render` job enqueued.
4. Render worker runs the FFmpeg pipeline (trim, silence removal, subtitles, zoom,
   transitions, music), uploads the result to S3, writes a `Render` row.
5. n8n workflow is triggered with the render URL + generated copy; n8n posts status
   back to `/api/webhooks/n8n`.

---

## 2. Tech Stack

| Layer       | Choice                                            |
|-------------|---------------------------------------------------|
| Frontend    | Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui |
| Backend     | Node.js, Express, TypeScript                      |
| Database    | PostgreSQL + Prisma ORM                           |
| Queue       | Redis + BullMQ                                     |
| AI          | Anthropic Claude API (`@anthropic-ai/sdk`)        |
| Automation  | n8n (REST API + webhooks)                          |
| Video       | FFmpeg (ffmpeg-static + fluent-ffmpeg), Remotion (optional) |
| Storage     | AWS S3 (multipart upload, presigned URLs)         |
| Deploy      | Docker + docker-compose                            |

---

## 3. Repository layout

```
autoedit-ai/
├── docker-compose.yml          # postgres, redis, api, worker, web, n8n
├── .env.example
├── apps/
│   ├── api/                    # Express backend + workers
│   │   ├── prisma/schema.prisma
│   │   ├── src/
│   │   │   ├── index.ts        # express app entrypoint
│   │   │   ├── worker.ts       # BullMQ worker entrypoint
│   │   │   ├── config/env.ts
│   │   │   ├── lib/            # prisma, redis, s3 clients
│   │   │   ├── middleware/     # auth, error handling
│   │   │   ├── routes/         # auth, projects, upload, render, n8n, webhooks
│   │   │   ├── services/       # claude, n8n, analysis, storage
│   │   │   ├── queue/          # queues + workers
│   │   │   └── ffmpeg/         # rendering pipeline
│   │   └── Dockerfile
│   └── web/                    # Next.js 15 frontend
│       ├── src/app/            # routes (login, dashboard, projects)
│       ├── src/components/     # UI components
│       ├── src/lib/            # api client, auth helpers
│       └── Dockerfile
└── infra/                      # extra deploy notes
```

---

## 4. Local development

```bash
# 0. prerequisites: Docker, Node 20+, pnpm (or npm), an FFmpeg install for bare-metal
cp .env.example .env            # fill in ANTHROPIC_API_KEY, AWS creds, etc.

# 1. boot infra + services
docker compose up -d postgres redis n8n

# 2. backend
cd apps/api
npm install
npx prisma migrate dev --name init
npm run dev          # API on :4000
npm run worker       # in a second terminal — BullMQ workers

# 3. frontend
cd ../web
npm install
npm run dev          # web on :3000
```

Or run everything in containers: `docker compose up --build`.

---

## 5. Production deployment

See [`infra/DEPLOYMENT.md`](infra/DEPLOYMENT.md) for the full guide
(managed Postgres/Redis, S3 bucket + IAM policy, ECS/Fly/Render options,
autoscaling the render worker, secrets, health checks, and observability).

---

## 6. Environment variables

See `.env.example` — every variable is documented inline.
