# Upstash Free Redis

This document prepares Upstash Redis for AutoEdit AI staging. It does not create Redis.

## What Uses Redis

AutoEdit AI uses Redis for BullMQ queues:

- analysis queue
- render queue
- n8n dispatch queue

Both the API and worker must use the same `REDIS_URL`.

## Manual Dashboard Step

Stop here for human action:

1. Create an Upstash Redis database.
2. Choose a region close to Render and Neon.
3. Copy the Redis connection URL.
4. Add it to Render API and worker environment variables.

## Environment Variable

Use the TCP Redis URL format expected by `ioredis` and BullMQ:

```env
REDIS_URL=rediss://default:PASSWORD@HOST:PORT
```

Use `rediss://` when Upstash gives a TLS endpoint.

## BullMQ Compatibility

BullMQ uses `ioredis` connections. Upstash documents BullMQ support, but free/serverless Redis can have connection and command limits.

For staging:

- keep worker concurrency low
- keep `RENDER_CONCURRENCY=1`
- keep `ANALYSIS_CONCURRENCY=1`
- avoid parallel large video tests

## Verification

After API deployment:

```text
GET /health/redis
GET /health/queue
```

Expected:

```json
{ "ok": true }
```

## Known Free-Tier Caveats

- Free Redis limits may be tight for video queues.
- Worker restarts can leave jobs waiting until the worker reconnects.
- If Redis rejects connections or commands, pipeline jobs will not process.
