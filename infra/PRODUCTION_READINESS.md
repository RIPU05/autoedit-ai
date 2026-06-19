# AutoEdit AI — Production Readiness Report

_Status: pre-launch hardening complete (Phases 1–7). This report reflects the
architecture after reliability, transcription, creator-memory, analytics, and
testing work._

## 1. Architecture review

Three runtime tiers, scaled independently:

- **API (Express)** — stateless, behind a load balancer. Handles auth, uploads
  (presigned S3 multipart), project CRUD, prompt edits, analytics, feedback,
  health. Horizontally scalable; no local state.
- **Workers (BullMQ)** — `analysis` (Director→specialist agents, CPU-light but
  Claude-bound) and `render` (FFmpeg, CPU-heavy). Separate process from the API
  so renders scale on their own.
- **Whisper sidecar (FastAPI)** — transcription, scaled separately, GPU-ready.

Stateful backends: PostgreSQL (Prisma), Redis (queues), S3 (media). Claude and
n8n are external dependencies.

Observability is now first-class: every pipeline stage is timed into
`StageTiming`, every failure is categorized into `ErrorEvent`, `/health/*`
covers all five dependencies, and a memory sampler flags RSS spikes.

## 2. Bottlenecks (ranked)

1. **Render (FFmpeg)** — the dominant cost. Per-clip re-encode + concat + a
   second subtitle/music pass. A 1h source producing several outputs is minutes
   of CPU. *Mitigations in place:* per-segment cutting (already chunked),
   `priority` so short-form jumps the queue, a hard `RENDER_TIMEOUT_MS`, and
   `RENDER_CONCURRENCY=1` per worker (scale by replica count). *Next:* GPU NVENC.
2. **Transcription** — long podcasts dominate wall-clock. Sidecar uses VAD +
   `base` model on CPU by default. *Mitigation:* separate service, retry+timeout.
   *Next:* GPU (`float16`) and/or chunked parallel transcription.
3. **Claude analysis** — the multi-agent pipeline makes ~6 calls/project.
   Director is serial; specialists run in parallel. Latency ≈ Director + slowest
   specialist. *Mitigation:* specialists use the fast model.
4. **S3 egress** — workers download the full source per job. *Next:* cache hot
   sources on a shared volume; range-read for probe instead of full download.

## 3. Security concerns

- **Auth:** JWT in httpOnly cookies; bcrypt(12); Google OAuth. *Add:* refresh
  tokens + rotation, and per-IP rate limits on `/upload/*` (only `/auth` is
  limited today).
- **Secrets:** all via env/secret-manager; n8n API keys encrypted at rest
  (AES-256-GCM). *Action:* use a dedicated `ENCRYPTION_KEY` rather than deriving
  from `JWT_SECRET`.
- **S3:** block public access; serve via presigned URLs only. Validate
  `contentType` and enforce `MAX_UPLOAD_BYTES` server-side. Lifecycle-expire raw
  sources after successful render.
- **Webhooks:** inbound n8n calls are HMAC-verified. Keep `N8N_WEBHOOK_SECRET`
  rotated.
- **Admin:** `/feedback/admin` and `/analytics/global` are role-gated (`ADMIN`).
- **Prompt-injection:** transcripts/filenames are treated as data, never
  instructions, in agent prompts.

## 4. Scalability concerns

- API and whisper scale horizontally with no shared state.
- Render throughput = `RENDER_CONCURRENCY × worker_replicas`. Autoscale workers
  on BullMQ `waiting` depth.
- Postgres is the long-term ceiling; analytics aggregates over `StageTiming`
  should move to a rollup table or a warehouse past ~10⁵ projects.
- Redis is fine to low-hundreds of jobs/s; use a managed cluster.

## 5. Performance concerns

- Memory: FFmpeg work files are streamed and the scratch dir is cleaned per job;
  the sampler raises a `MEMORY` ErrorEvent past `MEMORY_THRESHOLD_MB`.
- Dead-letter queue captures exhausted jobs for replay instead of silent loss.
- Graceful shutdown: workers handle SIGTERM; BullMQ recovers stalled jobs on
  restart.

## 6. Capacity estimates (planning, not guarantees)

Assumptions: render worker = 4 vCPU, libx264 CPU encode, average job a 60s reel.

- **Per render worker:** ~1 concurrent render; ~1.5–4× realtime encode → a 60s
  reel in ~20–40s. ≈ 100–150 reels/hour/worker.
- **Concurrent renders:** = worker replicas. 10 workers ≈ 10 simultaneous,
  ~1,000–1,500 reels/hour. GPU NVENC raises this 3–5×.
- **Concurrent users (API):** a 2 vCPU API instance handles hundreds of RPS of
  light JSON; uploads bypass the API (direct-to-S3). 3–4 API instances
  comfortably serve a few thousand concurrent active users.
- **Practical launch envelope:** ~2k weekly active creators with 3 API instances,
  10 render workers, 2 whisper instances, managed Postgres/Redis. Render queue is
  the first thing to autoscale.

## 7. Deployment recommendations

- Run `npx prisma migrate deploy` on release before the API serves.
- Separate services: `api`, `worker` (autoscaled on queue depth), `whisper`
  (GPU pool for production), plus managed Postgres + Redis.
- Health checks: load balancer → `GET /health` (503 if any dep down); per-dep at
  `/health/{redis,db,s3,claude,queue}`.
- Ship logs (JSON lines) to a central aggregator; alert on `ErrorEvent` rate by
  category and on DLQ depth.
- Dashboards: wire the analytics endpoints to your North-star board (Time-to-
  first-edit, Time-to-render, Render success rate, WAC).
- Backups: Postgres PITR; S3 versioning on the media bucket.
- Cost control: GPU only on whisper/render pools; lifecycle-expire raw uploads.

## 8. Go/no-go checklist

- [x] Health endpoints for every dependency
- [x] Stage timing + categorized error capture
- [x] Real transcription (words, confidence, en/hi/hinglish)
- [x] Retry + timeout on external calls; DLQ on exhaustion
- [x] Worker concurrency + queue priority controls
- [x] Creator memory injected into AI prompts
- [x] Analytics + feedback loops
- [x] Integration test scenarios (30s / 5m / 30m / 1h)
- [ ] GPU render/transcription pool (recommended before scale)
- [ ] Refresh-token rotation + upload rate limits (recommended before launch)
- [ ] Load test at target concurrency
