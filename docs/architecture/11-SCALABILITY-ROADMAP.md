# AUTOAI EDIT — SCALABILITY ROADMAP: FROM MVP TO 10,000 CONCURRENT CREATORS

**Document ID:** ARCH-011  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Systems Architecture & Scaling Strategy

---

## 1. Phased Scaling Strategy Overview

Scaling a video and live broadcast platform to 10,000 concurrent creators requires managing massive network bandwidth (60 Gbps at 10k streams), intensive compute, and high database write velocity.

To avoid premature optimization and uncontrolled cloud burn, AutoAI Edit defines three distinct scaling phases:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THREE-TIER SCALING ROADMAP                           │
└────────────────────────────────────────────────────────────────────────────────────────┘

  [PHASE A: FUNCTIONAL MVP]               [PHASE B: CREATOR BETA]                 [PHASE C: SCALE PRODUCTION]
  Target: 10–50 Concurrent Creators       Target: 100–500 Concurrent Creators     Target: 10,000 Streams
  ┌───────────────────────────────┐       ┌───────────────────────────────┐       ┌───────────────────────────────┐
  │ - Single Render API (1 vCPU)  │       │ - 2x Render API Auto-Scale    │       │ - Multi-Region K8s Clusters   │
  │ - 1x Background Worker        │       │ - 3–5 Worker Pool with BullMQ │       │ - Distributed MediaMTX Edge   │
  │ - Modal Serverless GPU (T4)   │       │ - Modal GPU (up to 10 inst)   │       │ - Cloudflare R2 + Fastly CDN  │
  │ - Upstash Serverless Redis    │       │ - Managed Upstash Fixed Plan  │       │ - Redis Cluster with Sharding │
  │ - Direct S3 Bucket            │       │ - Neon DB with PgBouncer Pool │       │ - DB Read Replicas & Part.    │
  │ Monthly Cost: $50 – $75       │       │ Monthly Cost: $250 – $500     │       │ Monthly Cost: Dynamically Met.│
  └───────────────────────────────┘       └───────────────────────────────┘       └───────────────────────────────┘
```

---

## 2. Phase A: Functional MVP Architecture (10–50 Concurrent Creators)

### Architectural Footprint:
- **Web & API:** Next.js on Vercel edge; single Render Express API instance (1 vCPU, 2GB RAM).
- **Worker Execution:** Single Render background worker running with `concurrency: 1`. Jobs process serially or with minimal parallelism.
- **Transcription:** Modal Faster-Whisper GPU scaling from 0 to 2 instances on demand.
- **Queue:** Upstash Serverless Redis configured with `drainDelay: 30000` to remain within free/cheap command limits.
- **Database:** PostgreSQL on Neon serverless with direct connections.
- **Media Storage:** AWS S3 Standard with presigned direct-to-S3 browser uploads.
- **Operational Focus:** Strict correctness, 0 crashes, rock-solid BOLA security, non-destructive versioning.

---

## 3. Phase B: Creator Beta Architecture (100–500 Concurrent Creators)

### Key Architectural Upgrades:
1. **Dynamic Worker Horizontal Scaling:**
   - Render API auto-scales between 2 and 4 instances based on CPU utilization (>75%).
   - Worker pool expands to 3–5 background workers. BullMQ distributes `analysis` and `render` jobs across the worker pool using Redis locks.
2. **Database Connection Pooling:**
   - PostgreSQL connection exhaustion is prevented by activating **PgBouncer** connection pooling on Neon/Supabase.
   - Long-lived worker queries use transaction-mode pooling; API routes use session pooling.
3. **Modal Concurrency Expansion:**
   - Modal GPU concurrency limit raised to 10 parallel containers.
   - Audio extraction offloaded so that workers only send small WAV files to Modal, maximizing throughput.
4. **MediaMTX Ingestion Cluster:**
   - Dedicated standalone edge instance running MediaMTX handling up to 50 simultaneous RTMP broadcasts.

---

## 4. Phase C: Enterprise Scale Architecture (Up to 10,000 Simultaneous Streams)

At 10,000 simultaneous live streams (each streaming at 6 Mbps 1080p60), the platform ingests **60 Gigabits per second** of video data.

### 1. Distributed Edge Ingest Gateway (Geo-DNS & Anycast)
- **Ingest Nodes:** MediaMTX deployed across 5 global regions (US-East, US-West, EU-Central, AP-Southeast, SA-East) on bare-metal providers (e.g. Hetzner, AWS EC2 Spot).
- **Geo-DNS Routing:** Streamers automatically connect to the lowest-latency edge ingest node (e.g. `us-east.ingest.autoedit.ai`).
- **Edge Segmentation:** Ingest nodes immediately split incoming RTMP/SRT streams into 6-second chunks and push directly to Cloudflare R2 object storage.

### 2. High-Throughput Queue Sharding & Redis Clustering
- **Partitioned Queues:** BullMQ queues are partitioned by creator hash: `analysis:shard_0` through `analysis:shard_7`.
- **Redis Cluster:** Multi-node Redis cluster with read-replicas separating pub/sub events from job queues.

### 3. Database Partitioning & Archival
- **Time-Series Partitioning:** The `ChatEvent` and `MediaSegment` tables are partitioned by month (`createdAt`) using PostgreSQL native declarative partitioning.
- **Cold Storage Offload:** Chat logs and telemetry older than 90 days are archived to S3 Glacier as compressed Parquet files, keeping active database indexes lean.

### 4. Backpressure & Load Shedding
When global queue backlog exceeds 500 active rendering jobs:
1. **Priority Queuing:** Pro and Studio subscribers maintain high-priority lanes; free-tier exports are queued in an asynchronous batch lane.
2. **Dynamic Quality Adaptation:** Workers dynamically drop secondary format exports (e.g. render 9:16 reel immediately, defer 16:9 landscape export until queue drain).

---

## 5. Scalability Acceptance Matrix

| Parameter | Phase A: MVP | Phase B: Creator Beta | Phase C: 10,000 Streams |
|---|---|---|---|
| **Max Concurrent Live Streams** | 2 | 25 | 10,000 |
| **Simultaneous Video Renders** | 1 | 5 | 500+ |
| **Max Upload File Size** | 2 GB | 5 GB | 15 GB |
| **Database Pool Connections** | 20 | 100 (PgBouncer) | 5,000 (Distributed Pool) |
| **Live Stream End-to-End Latency** | ~6.0s (HLS) | ~3.0s (Low-Latency HLS) | <1.0s (WebRTC / SRT) |
| **Storage Architecture** | AWS S3 Single Region | S3 + Cloudflare R2 | Multi-Region R2 + Fastly CDN |
