# AUTOAI EDIT — SECURITY, RELIABILITY & UNIT ECONOMICS

**Document ID:** ARCH-010  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Infosec, Site Reliability Engineering & Financial Analysis

---

## 1. Information Security & Tenant Isolation Architecture

AutoAI Edit is designed according to the principle of **Defense in Depth**, enforcing isolation across the database, network, compute, and storage layers:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       DEFENSE IN DEPTH ARCHITECTURE                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  [EDGE & NETWORK LAYER]
  ├── Helmet Security Headers (HSTS, X-Content-Type-Options: nosniff, Frameguard)
  ├── Strict CORS Origin Validation (Whitelist web origin only)
  └── Redis-Backed Sliding-Window Rate Limiting (Protects auth, upload, and integrations)
  │
  [AUTHENTICATION & SESSION LAYER]
  ├── Signed JWT Tokens with Short Lifespan stored in HttpOnly, SameSite=Strict cookies
  └── BOLA Middleware (Broken Object Level Authorization): verifies session ownership on every S3 chunk
  │
  [CREDENTIAL & SECRET LAYER]
  ├── Zero Secrets in Git: Strict pre-commit sanitization and CI secret scanning
  └── AES-256-GCM Encryption at rest for all third-party OAuth tokens (Twitch, YouTube, Claude, n8n)
  │
  [STORAGE & MEDIA LAYER]
  ├── Presigned S3 URLs with 1-hour expiration; no public S3 bucket access
  └── Scoped Storage Paths: users/{userId}/projects/{projectId}/*
  │
  [CONTAINER & WORKER LAYER]
  ├── Non-Root Container Execution (USER node UID 1000)
  └── Isolated Scratch Storage: /tmp/autoedit with path traversal guardrails
```

---

## 2. OAuth Token & Stream Key Cryptography

### 1. AES-256-GCM Token Encryption (`apps/api/src/services/integration-crypto.service.ts`)
All third-party OAuth access tokens, refresh tokens, and user API keys are encrypted before storage:
- **Cipher:** `aes-256-gcm`
- **Key Derivation:** Master key derived from `INTEGRATION_ENCRYPTION_SECRET` (256-bit).
- **IV:** Unique 16-byte random initialization vector generated per encryption operation.
- **Auth Tag:** 16-byte authentication tag appended to ciphertext to prevent tampering.
- **Format:** `iv.ciphertext.authTag` (Hex-encoded).

### 2. Stream Key Cryptography (`LIVE-004`)
- Stream keys are treated with the same sensitivity as user passwords.
- The raw stream key (`live_sk_...`) is displayed to the creator once upon generation.
- The database stores only the **SHA-256 hash** of the key.
- When OBS connects to MediaMTX, the authentication webhook hashes the provided key and performs a timing-safe equality check (`crypto.timingSafeEqual`) to prevent timing attack vulnerabilities.

---

## 3. Reliability, Fault Tolerance & Circuit Breakers

### 1. BullMQ Retry Backoff & Dead Letter Queue (DLQ)
- **Retry Schedule:** All background jobs implement an exponential backoff policy:
  $$\text{Delay}(attempt) = 5000\text{ms} \times 2^{(attempt - 1)}$$
- **DLQ Routing:** If a job fails after 3 attempts, it is automatically routed to `${BULL_PREFIX}:dead-letter`. A critical error event is logged in `ErrorEvent` for engineering review without terminating the worker process.

### 2. Scratch Path Traversal Protection
Workers validate that all scratch operations resolve strictly within `RENDER_WORK_DIR`:
```typescript
const baseDir = path.resolve(env.RENDER_WORK_DIR);
const workDir = path.resolve(baseDir, 'analysis', safeProject, safeJobId);
if (!workDir.startsWith(baseDir)) {
  throw new Error('path traversal detected in worker scratch directory');
}
```

### 3. Worker Memory & Concurrency Guardrails
- **Worker Concurrency:** Capped at `ANALYSIS_CONCURRENCY=1` and `RENDER_CONCURRENCY=1` per worker.
- **Memory Ceiling:** If Node RSS memory exceeds `MEMORY_THRESHOLD_MB` (default: 1536 MB), the worker pauses queue consumption and triggers garbage collection before claiming new jobs.

---

## 4. Disaster Recovery & Failure Matrix

| Failure Scenario | Root Cause | Automated Recovery Mechanism | Impact on End User |
|---|---|---|---|
| **OBS Network Drop** | Creator internet disruption | Ingest gateway holds session in `DISCONNECTED` state for 180s grace period; resumes seamlessly upon reconnect. | Zero data loss; stream resumes as single session. |
| **Worker Container Crash** | Host OOM or kernel panic | Render restarts container. BullMQ stalled-job detector reclaims in-flight jobs after lock timeout. | Job restarts automatically from active queue. |
| **Modal GPU Timeout** | Cold boot stall or network flake | `transcribe.service.ts` retry wrapper retries request up to 3 times before failing gracefully. | Slight delay (10–15s); user sees progress spinner. |
| **Claude API Outage** | Anthropic API 5xx or rate limit | AI Gateway falls back to deterministic rule-based editor (`AI-003`); project still finishes successfully. | Editorial cuts completed with rule-based reasoning. |
| **Redis Connection Loss** | Upstash network blip | `ioredis` automatically retries connection; in-memory offline queue buffers commands until reconnect. | Temporary delay; no lost jobs. |
| **S3 Upload Interruption** | Client network drop | Multipart chunking preserves uploaded parts; client resumes from last completed chunk. | Creator resumes upload without re-sending full file. |

---

## 5. Engineering Cost Projections & Unit Economics

> [!NOTE]
> **Pricing & Tier Packaging Disclaimer:** The unit costs below represent **theoretical engineering cost projections** based on current cloud provider pricing (Modal GPU, Render CPU, Anthropic/Google tokens, AWS S3/Cloudflare R2 storage). **Retail subscription pricing, free-tier limits, and packaging remain undecided** and will be finalized only after empirical cost tracking, fraud prevention testing, and user feedback during the Milestone 4/5 beta.

AutoAI Edit's unit economics distinguish between **LITE Mode** (zero AI inference compute) and **PRO Mode** (multimodal GPU + LLM inference) as detailed in [`ARCH-018: LITE & PRO Processing Architecture`](file:///c:/Users/RIPS/Desktop/autoeditAI/autoedit-ai/docs/architecture/18-LITE-AND-PRO-PROCESSING-ARCHITECTURE.md):

```
Engineering Cost Comparison per Rendered Clip:
┌──────────────────────────────────────┬──────────────────────────────────────┐
│       LITE MODE (~$0.0306 / clip)    │       PRO MODE (~$0.1146 / clip)     │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ CPU Transcode (720p FFmpeg): $0.0180 │ CPU Transcode (1080p60):    $0.0350  │
│ Cloud Ingress / Buffer:      $0.0070 │ Modal GPU Whisper (45s audio):$0.0450│
│ Egress / Storage Lease:      $0.0050 │ Claude/Gemini LLM Reasoning: $0.0150 │
│ Signal Detection (EWMA):     $0.0006 │ Cloud Ingress & Buffer:      $0.0090 │
│ GPU / LLM AI Inference:      $0.0000 │ Egress & 7-Day Lease:        $0.0106 │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

### 5.1 Quota Strategy & Double-Charge Protection
1. **Idempotent Reservations:** All export and AI inference requests acquire an atomic `UsageReservation` in Redis keyed by `hash(tenantId, jobId, timestamp)` with a 15-minute TTL.
2. **Failure Protection:** If a transcode worker or GPU container crashes, the reservation is automatically released (`RELEASED`), immediately restoring tenant balance with zero financial or quota penalty. Retries with the same idempotency key never incur secondary deductions.
3. **Decoupled Metric Allowances:** Chat monitoring hours (virtually free cloud bandwidth) are tracked independently from video ingestion hours and rendered export credits.

### 5.2 Projected Monthly Compute & Infrastructure Cost Models (Illustrative):

| Creator Usage Model | Monthly Videos Processed | Estimated Compute & AI Cost | Fixed Infra Overhead (Render/DB) | Total Estimated Cost / Month | Retail Pricing Strategy |
|---|---|---|---|---|---|
| **Free / LITE Tier** | 5 clips (from 2h stream) | ~$0.15 | $0.00 (Covered by free tiers) | **~$0.15** | Free (Quota & abuse limit calibration in beta) |
| **Creator PRO Model** | 30 clips (from 15h media) | ~$3.45 | $50.00 (Single worker pool) | **~$53.45** | Paid SaaS (Pricing finalized post-beta telemetry) |
| **Streamer PRO Model** | 120 clips (from 40h streams) | ~$13.75 | $50.00 (Dedicated worker pool) | **~$63.75** | Paid SaaS (Pricing finalized post-beta telemetry) |
| **Studio Multi-Seat Model**| 500 clips (multi-seat) | ~$57.30 | $75.00 (Scaled worker pool) | **~$132.30** | Paid SaaS (Pricing finalized post-beta telemetry) |
