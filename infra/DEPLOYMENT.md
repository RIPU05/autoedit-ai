# AutoEdit AI — Production Deployment

## 1. Provision managed infrastructure

| Component  | Recommendation                                                        |
|------------|-----------------------------------------------------------------------|
| Postgres   | Managed (RDS, Neon, Supabase). Enable automated backups + PITR.       |
| Redis      | Managed (ElastiCache, Upstash). BullMQ needs `maxRetriesPerRequest:null`. |
| Object store | S3 bucket, **block public access ON**; serve via presigned URLs/CloudFront. |
| Compute    | API and worker as separate services (see below).                      |
| n8n        | Self-host (its own container) or n8n Cloud.                           |

### S3 bucket + IAM
Create a bucket (e.g. `autoedit-media`) and an IAM user/role limited to it:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject","s3:GetObject","s3:AbortMultipartUpload","s3:ListBucketMultipartUploads"],
    "Resource": ["arn:aws:s3:::autoedit-media", "arn:aws:s3:::autoedit-media/*"]
  }]
}
```

CORS on the bucket (browser uploads directly via presigned PUT):

```json
[{
  "AllowedOrigins": ["https://app.yourdomain.com"],
  "AllowedMethods": ["PUT","GET"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"]
}]
```

## 2. Two service types

Run **API** and **worker** from the same image, different commands:

- **API** (`node dist/index.js`) — stateless, behind a load balancer, autoscale on CPU/RPS.
- **Worker** (`node dist/worker.js`) — CPU/GPU heavy (FFmpeg). Scale **horizontally**:
  each instance keeps render concurrency at 1 (set in `render.worker.ts`). Use a
  larger instance class for renders or attach a GPU and switch libx264 → NVENC.

```bash
# build + push
docker build -t registry/autoedit-api ./apps/api
docker push registry/autoedit-api
# run N workers
docker compose up --scale worker=4 -d
```

Platform options: AWS ECS/Fargate, Fly.io, Render, or Kubernetes. The render
worker benefits from a queue-length autoscaler (scale on BullMQ `waiting` count).

## 3. Migrations

Run on deploy, before the API starts serving:

```bash
npx prisma migrate deploy
```

The compose `api` service already does this in its command.

## 4. Secrets

Never bake secrets into images. Inject via the platform's secret manager:
`ANTHROPIC_API_KEY`, `JWT_SECRET`, AWS creds, `N8N_API_KEY`, `N8N_WEBHOOK_SECRET`,
Google OAuth creds, `DATABASE_URL`, `REDIS_URL`.

## 5. n8n wiring

1. In AutoEdit, open Settings → Connect n8n: paste base URL + API key.
2. Build a workflow whose first node is a **Webhook** (path e.g. `autoedit-publish`).
3. Set that workflow as the default in AutoEdit.
4. On render completion, the render worker fires the webhook with
   `{ projectId, title, format, videoUrl, socialCopy, titles }`.
5. Your workflow uploads to YouTube/TikTok/etc., then POSTs back to
   `https://api.yourdomain.com/api/webhooks/n8n` with the `X-AutoEdit-Signature`
   header (HMAC-SHA256 of the body using `N8N_WEBHOOK_SECRET`) and
   `{ workflowRunId, status, result }`.

## 6. Observability & limits

- Health check: `GET /health`.
- Add structured logging (pino) and a queue dashboard (Bull Board) on an internal route.
- Rate-limit auth (already wired) and the upload endpoints.
- Set `MAX_UPLOAD_BYTES` and validate `contentType` server-side.
- Lifecycle-expire raw source files in S3 after successful render to control cost.

## 7. Transcription

Implemented as a **faster-whisper sidecar** in `services/whisper` (FastAPI).
The render/analysis worker calls it over HTTP (`WHISPER_URL`) and gets back timed
cues with `start`, `end`, `text`, and optional `speaker`. Those cues are what
Claude reasons over to pick highlights and write captions.

- CPU default: `WHISPER_MODEL=base`, `WHISPER_COMPUTE_TYPE=int8`.
- GPU: set `WHISPER_DEVICE=cuda` + `WHISPER_COMPUTE_TYPE=float16`, use a CUDA base
  image, and uncomment the `deploy.resources.devices` block in compose.
- Speaker diarization: set `ENABLE_DIARIZATION=true`, provide `HUGGINGFACE_TOKEN`,
  and uncomment `pyannote.audio` + `torch` in `services/whisper/requirements.txt`.
- Scale transcription independently of rendering — it's its own service.

## 8. Scaling the render path

- GPU encode: swap `libx264` for `h264_nvenc` in `ffmpeg/pipeline.ts` on GPU workers.
- Pre-warm: keep at least one worker hot to avoid cold-start latency.
- Long videos: chunk the source and render segments in parallel jobs, then concat.
