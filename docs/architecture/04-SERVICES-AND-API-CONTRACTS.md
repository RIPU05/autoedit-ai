# AUTOAI EDIT — SERVICES ARCHITECTURE & API CONTRACTS

**Document ID:** ARCH-004  
**Version:** 1.0.0-PROD  
**Target Repository:** `https://github.com/RIPU05/autoedit-ai`  
**Classification:** Systems Architecture & API Specification

---

## 1. Physical & Logical Service Topology

AutoAI Edit decouples frontend user interactions, persistent API routing, long-running CPU media transcoding, and serverless GPU deep learning inference into dedicated, independently scalable services:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       PHYSICAL SERVICE ARCHITECTURE                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                     ┌─────────────────────────┐
                                     │  Client Browser (React) │
                                     └────────────┬────────────┘
                                                  │ HTTPS / WSS
                                                  ▼
                         ┌─────────────────────────────────────────────────┐
                         │ Next.js 14 Web Application (Vercel)             │
                         │ URL: https://autoedit-ai.vercel.app/            │
                         └────────────────────────┬────────────────────────┘
                                                  │ REST API / CORS
                                                  ▼
                         ┌─────────────────────────────────────────────────┐
                         │ AutoEdit Express API Server (Render Web Service)│
                         │ URL: https://autoedit-ai.onrender.com/          │
                         │ Node 20 LTS, Express 4, Prisma Client           │
                         └──────────────┬──────────────────┬───────────────┘
                                        │                  │
                ┌───────────────────────┴──────┐           └───────────────────────┐
                ▼                              ▼                                   ▼
   ┌──────────────────────────┐   ┌──────────────────────────┐   ┌───────────────────────────────────┐
   │ PostgreSQL (Neon / Supa) │   │ Upstash Redis (BullMQ)   │   │ AWS S3 / Cloudflare R2            │
   │ Managed DB with pooling  │   │ Queues: analysis, render │   │ Raw media, chunks, export clips   │
   └──────────────────────────┘   └────────────┬─────────────┘   └─────────────────▲─────────────────┘
                                               │ BullMQ Pull                       │ S3 Direct Stream
                                               ▼                                   │
                         ┌───────────────────────────────────────────┐             │
                         │ Render Background Worker (Docker)         │             │
                         │ apps/api/Dockerfile.worker                ├─────────────┘
                         │ Native FFmpeg + Debian Bookworm + Node 20 │
                         └─────────────────────┬─────────────────────┘
                                               │ POST /transcribe (Token Auth)
                                               ▼
                         ┌───────────────────────────────────────────┐
                         │ Modal Serverless Faster-Whisper GPU       │
                         │ services/whisper/modal_app.py             │
                         │ NVIDIA T4 GPU, CTranslate2, Scale-to-Zero │
                         └───────────────────────────────────────────┘
```

---

## 2. Global API Conventions & Standards

1. **Base URL:** `https://autoedit-ai.onrender.com/api` (Local: `http://localhost:4000/api`)
2. **Content Type:** All requests and responses use `application/json` unless handling binary uploads or multipart forms.
3. **Authentication:**
   - Authenticated endpoints require a signed JWT token provided either in the `HttpOnly` cookie named `autoedit_token` or via the `Authorization: Bearer <token>` header.
4. **Standard Error Schema:**
   ```json
   {
     "error": "Human-readable error explanation",
     "code": "MACHINE_READABLE_ERROR_CODE",
     "details": {}
   }
   ```
5. **Rate Limiting Headers:**
   - `X-RateLimit-Limit`: Maximum requests permitted within window.
   - `X-RateLimit-Remaining`: Requests remaining in active window.
   - `X-RateLimit-Reset`: Unix timestamp when limit resets.
   - `Retry-After`: Seconds to wait before retrying on HTTP 429.

---

## 3. REST API Endpoint Catalog

### A. Authentication Endpoints (`apps/api/src/routes/auth.routes.ts`)

#### 1. Register User
- **Route:** `POST /api/auth/register`
- **Rate Limit:** 10 requests / 15 minutes
- **Request Body:**
  ```json
  {
    "email": "creator@example.com",
    "password": "SecurePassword123!",
    "name": "Jane Doe"
  }
  ```
- **Responses:**
  - `201 Created`: `{ "user": { "id": "cuid", "email": "...", "name": "...", "role": "USER" } }` (Sets cookie)
  - `400 Bad Request`: Email already registered or invalid password complexity.
  - `429 Too Many Requests`: Rate limit exceeded.

#### 2. Login User
- **Route:** `POST /api/auth/login`
- **Rate Limit:** 10 requests / 15 minutes
- **Request Body:** `{ "email": "creator@example.com", "password": "SecurePassword123!" }`
- **Responses:**
  - `200 OK`: `{ "user": { "id": "...", "email": "..." } }`
  - `401 Unauthorized`: Invalid credentials.

#### 3. Current User Context
- **Route:** `GET /api/auth/me`
- **Responses:**
  - `200 OK`: `{ "user": { "id": "...", "email": "...", "role": "USER", "creatorProfile": {} } }`
  - `401 Unauthorized`: No active session.

#### 4. Logout User
- **Route:** `POST /api/auth/logout`
- **Responses:** `200 OK`: Clears cookie.

---

### B. Project & Media Lifecycle (`apps/api/src/routes/projects.routes.ts`)

#### 1. List Projects
- **Route:** `GET /api/projects`
- **Query Parameters:** `?limit=20&cursor=cuid&status=ANALYZED`
- **Responses:** `200 OK`: `{ "projects": [Project], "nextCursor": "cuid" }`

#### 2. Create Project Shell
- **Route:** `POST /api/projects`
- **Request Body:** `{ "title": "Episode 42: Cloud Scaling", "description": "Weekly podcast" }`
- **Responses:** `201 Created`: `{ "project": { "id": "proj_123", "status": "UPLOADING" } }`

#### 3. Get Project Detail
- **Route:** `GET /api/projects/:id`
- **Responses:**
  - `200 OK`: Full project payload including `sourceAsset`, `analysis`, `timeline`, `versions`, `renders`.
  - `404 Not Found`: Project does not exist or belongs to another user.

#### 4. Delete Project
- **Route:** `DELETE /api/projects/:id`
- **Responses:** `200 OK`: Cascades deletion across database records and purges S3 assets.

---

### C. BOLA-Guarded S3 Upload System (`apps/api/src/routes/upload.routes.ts`)

#### 1. Initiate Multipart Upload
- **Route:** `POST /api/projects/:id/upload/initiate`
- **Request Body:** `{ "filename": "recording.mp4", "sizeBytes": 1572864000, "mimeType": "video/mp4" }`
- **Responses:**
  - `200 OK`:
    ```json
    {
      "uploadId": "mp_upload_abc123",
      "s3Key": "users/usr_1/projects/proj_1/source.mp4",
      "bucket": "autoedit-production"
    }
    ```

#### 2. Presign Upload Chunk Part
- **Route:** `POST /api/projects/:id/upload/part`
- **Request Body:** `{ "uploadId": "mp_upload_abc123", "partNumber": 1 }`
- **Responses:** `200 OK`: `{ "presignedUrl": "https://s3.amazonaws.com/...", "expiresIn": 3600 }`

#### 3. Complete Multipart Upload
- **Route:** `POST /api/projects/:id/upload/complete`
- **Request Body:**
  ```json
  {
    "uploadId": "mp_upload_abc123",
    "parts": [{ "PartNumber": 1, "ETag": "\"e-tag-1\"" }]
  }
  ```
- **Responses:**
  - `200 OK`: `{ "success": true, "status": "UPLOADED" }` (Enqueues BullMQ `analysis` job)
  - `403 Forbidden`: Upload session does not belong to requesting user.
  - `409 Conflict`: Upload already completed or duplicate completion request.

---

### D. Studio Editing & Version History (`apps/api/src/routes/projects.routes.ts`)

#### 1. Submit Natural-Language Prompt Edit
- **Route:** `POST /api/projects/:id/edit`
- **Request Body:**
  ```json
  {
    "prompt": "Cut out the awkward silence at minute 2 and speed up the outro",
    "currentTimeline": { "operations": [], "effects": {} }
  }
  ```
- **Responses:**
  - `200 OK`:
    ```json
    {
      "version": {
        "id": "ver_456",
        "name": "Tighter pacing",
        "aiExplanation": "Trimmed 8.2s of low-amplitude silence and added dynamic zoom",
        "timelineJson": {}
      }
    }
    ```

#### 2. Restore Past Timeline Version
- **Route:** `POST /api/projects/:id/versions/:versionId/restore`
- **Responses:**
  - `200 OK`: Restores specified snapshot as active timeline without destroying history.

---

### E. Cloud Rendering & Export (`apps/api/src/routes/projects.routes.ts`)

#### 1. Queue Video Render
- **Route:** `POST /api/projects/:id/render`
- **Request Body:**
  ```json
  {
    "format": "reel",
    "quality": "high",
    "burnedSubtitles": true
  }
  ```
- **Responses:**
  - `202 Accepted`: `{ "renderId": "rnd_789", "status": "QUEUED" }` (Enqueues BullMQ `render` job)

#### 2. Poll Render Status
- **Route:** `GET /api/projects/:id/renders/:renderId`
- **Responses:**
  - `200 OK`:
    ```json
    {
      "id": "rnd_789",
      "status": "COMPLETED",
      "progress": 100,
      "outputUrl": "https://s3.amazonaws.com/.../reel_1080x1920.mp4?X-Amz-Signature=..."
    }
    ```

---

### F. Health & Infrastructure Probes (`apps/api/src/routes/health.routes.ts`)

- `GET /api/health`: Overall service uptime and version.
- `GET /api/health/db`: PostgreSQL connectivity probe via Prisma `$queryRaw` SELECT 1.
- `GET /api/health/redis`: Upstash Redis ping check.
- `GET /api/health/whisper`: Calls `WHISPER_URL/health` verifying transcription microservice.

---

## 4. BullMQ Asynchronous Queue Payload Contracts

Queues are managed via `apps/api/src/queue/queues.ts` with prefix isolation (`env.BULL_PREFIX`):

### 1. `analysis` Queue
- **Queue Name:** `${BULL_PREFIX}:analysis`
- **Job Name:** `analyze`
- **Payload Schema:**
  ```typescript
  export interface AnalysisJobData {
    projectId: string;
    s3Key: string;
    bucket: string;
    userPrompt?: string;
  }
  ```
- **Retry Policy:** 3 attempts, exponential backoff (5000ms base). On terminal failure, routes to `${BULL_PREFIX}:dead-letter`.

### 2. `render` Queue
- **Queue Name:** `${BULL_PREFIX}:render`
- **Job Name:** `render`
- **Payload Schema:**
  ```typescript
  export interface RenderJobData {
    projectId: string;
    renderId: string;
    format: 'reel' | 'short' | 'landscape';
  }
  ```
- **Priority:** Short-form vertical renders (`reel`, `short`) receive priority 1; landscape receives priority 10.

### 3. `n8n-dispatch` Queue
- **Queue Name:** `${BULL_PREFIX}:n8n-dispatch`
- **Job Name:** `dispatch`
- **Payload Schema:**
  ```typescript
  export interface N8nJobData {
    connectionId: string;
    workflowRunId: string;
    webhookPath: string;
    payload: Record<string, unknown>;
  }
  ```

---

## 5. Modal Serverless Faster-Whisper Interface (`services/whisper/modal_app.py`)

### Endpoint 1: File Upload (`POST /transcribe`)
- **Headers:** `X-Whisper-Secret: <secret>` or `Authorization: Bearer <secret>`
- **Body:** Multipart `file` (WAV/MP3), optional `language` ('en', 'hi', 'hinglish').

### Endpoint 2: Direct S3 Streaming (`POST /transcribe-s3`)
- **Headers:** `X-Whisper-Secret: <secret>`
- **Body:**
  ```json
  {
    "audio_url": "https://s3.amazonaws.com/.../audio.wav?X-Amz-Signature=...",
    "language": "en"
  }
  ```

### Response Schema (Compatible with `transcribe.service.ts`):
```json
{
  "language": "en",
  "duration": 45.28,
  "avgConfidence": 0.965,
  "segments": [
    {
      "start": 0.0,
      "end": 3.42,
      "text": "Welcome to AutoAI Edit, the future of video clipping.",
      "confidence": 0.98
    }
  ],
  "words": [
    { "start": 0.0, "end": 0.42, "word": "Welcome", "confidence": 0.99 },
    { "start": 0.45, "end": 0.62, "word": "to", "confidence": 0.99 },
    { "start": 0.65, "end": 1.15, "word": "AutoAI", "confidence": 0.97 }
  ]
}
```
