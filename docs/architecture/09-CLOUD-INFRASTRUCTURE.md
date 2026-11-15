# AUTOAI EDIT — CLOUD INFRASTRUCTURE & TOPOLOGY SPECIFICATION

**Document ID:** ARCH-009  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Cloud Architecture & DevOps Specification

---

## 1. Hybrid Multi-Cloud Architecture Overview

AutoAI Edit rejects both monolithic cloud lock-in and premature microservice fragmentation. It implements a **Workload-Matched Hybrid Architecture**: CPU-bound transcoding, serverless GPU inference, managed transactional storage, and low-latency edge ingestion run on the exact cloud providers best suited for each workload.

> [!NOTE]
> **Cloud Provider Portability & Flexibility:** While Render (API + Docker Worker), Modal Labs (Serverless GPU), and Upstash (Redis) represent the primary validated staging topology, the application interfaces are strictly decoupled via standard Docker containers, standard Redis protocols, and S3-compatible APIs. Compute workloads can seamlessly migrate to alternative cloud providers—such as **Oracle Cloud Infrastructure (OCI)** ARM Ampere instances for high CPU/RAM per dollar, **Hetzner Cloud** for ultra-cost-effective bare metal/VPS, **AWS ECS/Fargate**, or **RunPod** serverless GPU—without modifying core business logic.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   AUTOAI EDIT HYBRID CLOUD TOPOLOGY                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

    [FRONTEND LAYER]                     [API & STATE LAYER]                     [BACKGROUND WORKERS]
    Vercel Edge Network                  Render.com Managed Services             Render.com Docker Workers
    ┌──────────────────────┐             ┌─────────────────────────┐             ┌────────────────────────┐
    │ Next.js 14 App Router│──HTTPS/CORS─► Express 4 REST API      │──BullMQ Pull─► Background Workers     │
    │ autoedit-ai.vercel   │             │ autoedit-ai.onrender    │             │ apps/api/Docker.worker │
    └──────────────────────┘             └────────────┬────────────┘             └───────────┬────────────┘
                                                      │                                     │
                                                      │ S3 Presigned URLs                   │ Extract Audio
                                                      ▼                                     ▼
                                         ┌─────────────────────────┐             ┌────────────────────────┐
                                         │ AWS S3 / Cloudflare R2  │◄──Direct───┤ Modal Serverless GPU   │
                                         │ - Raw Media Uploads     │   Stream   │ services/whisper/modal │
                                         │ - Rendered Exports      │            │ NVIDIA T4 GPU ($0.59/h)│
                                         └─────────────────────────┘             └────────────────────────┘
                                                      ▲
                                                      │ Rolling Chunks
                                         ┌────────────┴────────────┐
                                         │ MediaMTX Ingest Gateway │
                                         │ RTMP/SRT Live Broadcast │
                                         └─────────────────────────┘
```

---

## 2. Infrastructure Sizing & Compute Specifications

| Component | Cloud Provider | Plan / Hardware Tier | vCPU / RAM | Scaling Model | Baseline Fixed Cost |
|---|---|---|---|---|---|
| **Web Frontend** | Vercel | Pro / Hobby | Serverless Edge | Elastic auto-scale | $0.00 – $20.00/mo |
| **API Web Service** | Render | Standard Web Service | 1 vCPU, 2GB RAM | Continuous running | $25.00/mo |
| **Background Worker** | Render | Standard Background Worker | 1 vCPU, 2GB RAM | Continuous (0 HTTP ports) | $25.00/mo |
| **Whisper GPU** | Modal Labs | Serverless NVIDIA T4 | 16GB VRAM, 4 vCPU | Scale-to-zero (60s window) | $0.00 (within $30 credit) |
| **Transactional DB** | Neon / Supabase | PostgreSQL 16 + Pooler | 1 vCPU, 2GB RAM | Auto-suspend / Active | $0.00 – $19.00/mo |
| **Queue & Cache** | Upstash | Serverless Redis | TLS, Multi-zone | Pay-per-request / Fixed | $0.00 – $10.00/mo |
| **Object Storage** | AWS S3 / Cloudflare R2 | Standard Storage | Unlimited TB | Elastic per GB | ~$0.015 / GB-month |
| **Ingest Gateway (Stg 2)** | Hetzner / AWS EC2 | CPX21 (Hetzner) / t4g | 3 vCPU, 4GB RAM | Fixed edge instance | $7.00 – $15.00/mo |

---

## 3. Container Specifications & Dockerfiles

### 1. Cloud Worker Container (`apps/api/Dockerfile.worker`)
The background worker executes BullMQ queues and native FFmpeg pipelines without exposing web ports:
- **Base OS:** Debian 12 Bookworm Slim (`node:20-bookworm-slim`).
- **Native Binaries:** `ffmpeg`, `ffprobe`, `ca-certificates`, `curl`.
- **Prisma Engines:** Built in builder stage; `.prisma/client` copied directly into runner to eliminate runtime compile overhead.
- **Security:** Executes strictly under unprivileged user `USER node` (UID 1000).
- **Scratch Directory:** Dedicated `/tmp/autoedit` owned by `node:node`.
- **Healthcheck:**
  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
      CMD node -e "require('node:fs').accessSync(process.env.RENDER_WORK_DIR || '/tmp/autoedit', require('node:fs').constants.W_OK)" || exit 1
  ```
- **Entrypoint:** `CMD ["node", "dist/worker.js"]`

### 2. Modal Serverless Whisper Container (`services/whisper/modal_app.py`)
- **Accelerator:** NVIDIA T4 GPU (16GB VRAM).
- **Scale-To-Zero:** `@modal.cls(scaledown_window=60, timeout=1800)`. Container terminates after 60 seconds of idle time.
- **Model Baking:** Model weights (`Systran/faster-whisper-base`) are baked into the Docker image layers at build time via `run_function(download_base_model)`.
- **Cold Boot Time:** Drops from ~15 seconds to **~1.5 seconds**.

---

## 4. Upstash Redis & BullMQ Polling Safeguards

### The Upstash Command Flaw:
Default BullMQ workers poll Redis continuously for new jobs. Across 3 active queues at 5-second polling intervals:
$$\frac{86,400\text{ sec/day}}{5\text{ sec}} \times 3\text{ queues} = 51,840\text{ Redis commands/day}$$
This would burn through Upstash's 10,000 free daily commands in **4.6 hours while completely idle**.

### Production Mitigations Implemented:
1. **Drain Delay:** Configured with `drainDelay: 30000` (worker pauses polling for 30s when queue is empty).
2. **Stalled Check Interval:** Configured with `stalledInterval: 60000` (reduces stalled-lock checks to once per minute).
3. **Queue Namespacing (`BULL_PREFIX`):** Segregates `staging:*` from `bull:*`, preventing staging workers from querying production keys.
4. **Command Consumption:** With these settings, idle daily commands drop to <2,880 commands/day, safely within the free tier.

---

## 5. Storage Lifecycle & Scratch Disk Management

1. **Worker Ephemeral Scratch (`/tmp/autoedit`):**
   - Transcoding a 1-hour 1080p video creates ~1.8 GB raw MP4, ~110 MB extracted WAV, and ~150 MB rendered reel.
   - Total peak scratch disk requirement: **~2.2 GB**.
   - For multi-hour livestreams (3–6 hours), raw downloads can reach 15–25 GB. Workers implement **direct audio range extraction** (extracting audio directly from S3 URL streams without downloading the full monolithic MP4).
2. **Deterministic Purge Guarantee:**
   - Worker `finally` blocks enforce unconditional deletion of local scratch files:
     ```typescript
     finally {
       await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
     }
     ```
3. **S3 Storage Retention:**
   - Unpinned rolling live chunks: Purged after **90 minutes**.
   - Completed exports: Retained permanently for paid tiers; expired after 30 days for free tier accounts.
