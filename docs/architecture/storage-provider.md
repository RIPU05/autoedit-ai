# AutoAI Edit — Modular Storage Provider & Consumer Migration (Step 3B.1 & 3B.2)

## 1. Overview & Architecture Evolution

In Step 3B.1 and Step 3B.2, AutoAI Edit completed the transition from tightly coupled AWS S3 SDK calls to a clean, modular storage boundary centered on the `MediaStorageProvider` interface.

- **Step 3B.1:** Defined `MediaStorageProvider` interface, built `S3StorageProvider` supporting MinIO, AWS S3, Cloudflare R2, and custom S3 endpoints, and created a backward-compatibility facade in `apps/api/src/lib/s3.ts`.
- **Step 3B.2:** Migrated all production application code (upload routes, project routes, analysis background worker, render background worker, and health checks) to depend directly on `MediaStorageProvider` via `getStorageProvider()`.

Zero production application files now import `lib/s3.ts` or directly instantiate AWS SDK S3 commands.

---

## 2. Storage Provider Interface: `MediaStorageProvider`

Defined in `apps/api/src/storage/storage.types.ts`:

```typescript
export interface MediaStorageProvider {
  readonly providerType: StorageProviderType;
  readonly defaultBucket: string;
  readonly bucket: string;

  // Basic Object Operations
  putObject(input: PutObjectInput): Promise<PutObjectOutput>;
  getObject(input: GetObjectInput): Promise<GetObjectOutput>;
  getObjectMetadata(input: GetObjectMetadataInput): Promise<ObjectMetadata>;
  deleteObject(input: DeleteObjectInput): Promise<DeleteObjectOutput>;

  // Multipart Upload Lifecycle
  startMultipartUpload(input: StartMultipartUploadInput): Promise<StartMultipartUploadOutput>;
  presignUploadPart(input: PresignUploadPartInput): Promise<string>;
  completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<CompleteMultipartUploadOutput>;
  abortMultipartUpload(input: AbortMultipartUploadInput): Promise<AbortMultipartUploadOutput>;

  // Presigned Download Access
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<string>;

  // Health Diagnostics
  checkHealth(bucket?: string): Promise<StorageHealthCheckResult>;
}
```

### Core Interface Responsibilities
1. **Direct Object Operations (`putObject`, `getObject`, `getObjectMetadata`, `deleteObject`)**:
   Used by workers and routes for writing rendered MP4 exports, downloading media for processing, probing asset metadata, and deleting transient assets.
2. **Multipart Upload Lifecycle (`startMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`)**:
   Empowers browsers to stream multi-gigabyte video uploads directly to the storage bucket via presigned PUT URLs, preventing memory saturation and thread starvation on the API server.
3. **Presigned Download (`createDownloadUrl`)**:
   Issues signed, time-limited GET URLs for web preview players, worker video fetching, and client MP4 export downloads.
4. **Health Check (`checkHealth`)**:
   Validates bucket connectivity and measures latency in milliseconds without exposing credentials.

---

## 3. Production Caller Inventory & Migration Status

All production application callers have been migrated to use `getStorageProvider()`:

| Caller Component | Source File | Migrated Operation | Migration Status |
| :--- | :--- | :--- | :--- |
| **Upload Initiation** | `apps/api/src/routes/upload.routes.ts` | `storage.startMultipartUpload()` | **Migrated (Step 3B.2)** |
| **Upload Part Signing** | `apps/api/src/routes/upload.routes.ts` | `storage.presignUploadPart()` | **Migrated (Step 3B.2)** |
| **Upload Completion** | `apps/api/src/routes/upload.routes.ts` | `storage.completeMultipartUpload()` & `storage.createDownloadUrl()` | **Migrated (Step 3B.2)** |
| **Upload Abort** | `apps/api/src/routes/upload.routes.ts` | `storage.abortMultipartUpload()` | **Migrated (Step 3B.2)** |
| **Source Video Preview** | `apps/api/src/routes/projects.routes.ts` | `storage.createDownloadUrl()` | **Migrated (Step 3B.2)** |
| **Analysis Worker Download**| `apps/api/src/queue/workers/analysis.worker.ts` | `storage.createDownloadUrl()` | **Migrated (Step 3B.2)** |
| **Render Worker Source** | `apps/api/src/queue/workers/render.worker.ts` | `storage.createDownloadUrl()` | **Migrated (Step 3B.2)** |
| **Render Worker Export** | `apps/api/src/queue/workers/render.worker.ts` | `storage.putObject()` & `storage.createDownloadUrl()` | **Migrated (Step 3B.2)** |
| **Infrastructure Health** | `apps/api/src/routes/health.routes.ts` | `storage.checkHealth()` | **Migrated (Step 3B.2)** |

---

## 4. Provider Configuration Rules & Precedence

Storage configuration resolution follows strict, documented precedence in `apps/api/src/storage/storage.factory.ts`:

1. **Explicit Overrides:** Function argument parameters passed to `createStorageProvider(overrides)` or `resolveStorageConfig(overrides)` take top priority (used in tests and isolated scripts).
2. **Runtime Environment Variables:** Explicit values in `process.env.STORAGE_PROVIDER`, `process.env.S3_ENDPOINT`, `process.env.S3_BUCKET`, etc.
3. **Validated Defaults:** Static validated configuration from `apps/api/src/config/env.ts`.

### Configuration Rules & Fail-Closed Validation
- **Provider Types:** Must be one of `s3`, `minio`, `r2`, `custom-s3`. Any unsupported provider string fails immediately with an explicit error.
- **Auto-Detection Fallback:** When `STORAGE_PROVIDER` is unset or default `s3`, custom endpoints are evaluated:
  - Endpoints containing `r2.cloudflarestorage.com` resolve to `r2`.
  - Local loopback endpoints (`127.0.0.1`, `localhost`, `minio`) resolve to `minio`.
  - Any other custom endpoint resolves to `custom-s3`.
- **Endpoint Requirements:** Both `r2` and `custom-s3` require a non-empty `S3_ENDPOINT`; missing endpoints fail validation immediately.
- **Bucket and Credentials:** `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` must be non-empty strings.
- **Presigned URL TTL Bounding:** Presigned TTL is strictly bounded between **60 seconds (1 minute)** and **604,800 seconds (7 days)**, with a default of 3,600 seconds.

---

## 5. Bucket & Key Ownership Security Boundaries

1. **Server-Controlled Bucket:**
   Clients cannot specify a bucket parameter. Bucket selection is strictly controlled by server configuration (`storage.bucket`).
2. **Namespace Isolation:**
   All client upload keys must reside under the `sources/<userId>/<sessionId>/<filename>` prefix.
3. **Directory Traversal Prevention:**
   The `verifyKeyOwnership` guard strictly rejects:
   - Directory traversal sequences (`..`)
   - Windows backslash delimiters (`\`)
   - Leading slashes (`/`)
   - Double slashes (`//`)
   - Null bytes (`\0`)
4. **Ownership Verification:**
   The `userId` extracted from the key path must strictly match `req.user.sub` from the verified JWT.
5. **Session Integrity:**
   Upload ID, project ID, and S3 key must strictly match the registered upload session in Redis/memory.

---

## 6. Deprecated Compatibility Facade (`apps/api/src/lib/s3.ts`)

The file `apps/api/src/lib/s3.ts` is maintained exclusively as a backward-compatibility facade:
- Methods (`startMultipart`, `presignUploadPart`, `completeMultipart`, `abortMultipart`, `putObject`, `presignDownload`) delegate all calls to `getStorageProvider()`.
- Exported `s3` client is retained for legacy integration tests (`tests/integration/minio-storage.test.ts`), configuration tests (`tests/unit/s3-config.test.ts`), and standalone tools (`scripts/s3-upload-reliability.ts`).
- No production application code imports `lib/s3.ts`.

---

## 7. Cloudflare R2 & Self-Hosted Storage Target Notes

| Provider | `STORAGE_PROVIDER` | `S3_ENDPOINT` Example | `forcePathStyle` | Region |
| :--- | :--- | :--- | :--- | :--- |
| **AWS S3** | `s3` | *(Unset)* | `false` | `us-east-1` (or configured) |
| **Local MinIO** | `minio` | `http://127.0.0.1:9002` | `true` | `us-east-1` |
| **Cloudflare R2** | `r2` | `https://<account-id>.r2.cloudflarestorage.com` | `false` | `auto` |
| **Generic S3** | `custom-s3` | `https://s3.custom-domain.com` | Configurable | Configured region |

### Limitations & Caveats
- **Cloudflare R2:** Compatible target verified against AWS SDK v3 contracts. Does not claim live cloud verification in local tests.
- **Path-Style Addressing:** Required for IP-based or local endpoints (`127.0.0.1`) where DNS subdomain routing is unavailable. Virtual-hosted style is used for AWS and R2.

---

## 8. Scope Boundaries & What Is NOT In Step 3B.2

In accordance with strict step isolation:
- **No AI Provider Refactoring:** Transcription (Whisper) and Claude fallback logic remain unchanged.
- **No Remote URL Ingestion:** No external YouTube, Twitch, or video URL downloading.
- **No Livestream Ingestion:** No RTMP, HLS, or live chunk ingestion.
- **No Billing / Referral Logic:** Free tiers, credit balances, and referral tracking are out of scope.
- **No Production Deployments or Master Commits:** Master branch remains untouched; Render/Vercel production platforms remain unaffected.
