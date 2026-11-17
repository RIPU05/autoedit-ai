# AutoAI Edit — Modular Storage Provider Foundation (Step 3B.1)

## 1. Overview & Purpose

In Step 3B.1, AutoAI Edit introduces a clean, unified storage provider interface (`MediaStorageProvider`) to decouple media storage operations from the underlying infrastructure. 

Prior to Step 3B.1, direct calls to `@aws-sdk/client-s3` and helper methods in `apps/api/src/lib/s3.ts` were tightly coupled throughout routes and workers. With this modular abstraction, AutoAI Edit can seamlessly operate with:
- **Local MinIO** for 100% offline, zero-cost development and testing.
- **AWS S3** for production deployment on Render/AWS.
- **Cloudflare R2** for zero-egress-fee production object storage.
- **Generic S3-Compatible Storage** (Ceph, Wasabi, Backblaze B2, MinIO clusters) without changing any route or worker code.

---

## 2. Core Storage Interface: `MediaStorageProvider`

The interface is defined in `apps/api/src/storage/storage.types.ts`:

```typescript
export interface MediaStorageProvider {
  readonly providerType: StorageProviderType;
  readonly bucket: string;

  // Basic Object Operations
  putObject(input: PutObjectInput): Promise<PutObjectOutput>;
  getObject(input: GetObjectInput): Promise<GetObjectOutput>;
  getObjectMetadata(input: GetObjectMetadataInput): Promise<GetObjectMetadataOutput>;
  deleteObject(input: DeleteObjectInput): Promise<DeleteObjectOutput>;

  // Multipart Upload Lifecycle
  startMultipartUpload(input: StartMultipartUploadInput): Promise<StartMultipartUploadOutput>;
  presignUploadPart(input: PresignUploadPartInput): Promise<string>;
  completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<CompleteMultipartUploadOutput>;
  abortMultipartUpload(input: AbortMultipartUploadInput): Promise<AbortMultipartUploadOutput>;

  // Presigned Download Access
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<string>;

  // Health Diagnostics
  checkHealth(): Promise<StorageHealthCheckResult>;
}
```

### Key Responsibilities
1. **Direct Object Operations (`putObject`, `getObject`, `getObjectMetadata`, `deleteObject`)**:
   Used by workers and routes for reading video assets, uploading generated clips, probing asset headers (content length, etags), and deleting transient media.
2. **Multipart Upload Management (`startMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`)**:
   Enables chunked browser uploads for large video files directly to the storage bucket via presigned PUT URLs, preventing API server buffering or network bottlenecks.
3. **Presigned Download (`createDownloadUrl`)**:
   Generates secure, time-limited GET URLs for web preview players, worker video fetching, and client MP4 export downloads.
4. **Health Check (`checkHealth`)**:
   Probes bucket accessibility via `HeadBucketCommand` and returns latency in milliseconds without leaking secrets.

---

## 3. Configuration & Provider Types

The storage provider is resolved at runtime via `apps/api/src/storage/storage.factory.ts` and configured by environment variables in `apps/api/src/config/env.ts`.

### Storage Providers Supported

| Provider | `STORAGE_PROVIDER` | `S3_ENDPOINT` Required? | `S3_FORCE_PATH_STYLE` | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Local MinIO** | `minio` (or `s3` with endpoint) | Yes (`http://127.0.0.1:9002`) | `true` | Local Docker-based MinIO container for local dev/test. |
| **AWS S3** | `s3` (default) | No (uses AWS defaults) | `false` | Standard AWS S3 in `us-east-1` (or configured region). |
| **Cloudflare R2** | `r2` | Yes (`https://<account_id>.r2.cloudflarestorage.com`) | `false` | S3-compatible zero-egress object storage. |
| **Generic S3** | `custom-s3` | Yes | Configurable (`true`/`false`) | Self-hosted MinIO, Ceph, Wasabi, or Backblaze. |

### Path-Style vs. Virtual-Hosted Addressing

- **Path-Style (`http(s)://endpoint/bucket/key`)**:
  - **When Required**: Local development with MinIO or IP-based storage endpoints (`127.0.0.1`, `localhost`, raw IP addresses). Because DNS cannot dynamically route subdomains like `bucket.127.0.0.1`, path-style addressing is mandatory.
  - **Configuration**: Set `S3_FORCE_PATH_STYLE=true`.
- **Virtual-Hosted-Style (`https://bucket.s3.region.amazonaws.com/key`)**:
  - **When Required**: Standard AWS S3 and modern production cloud deployments. AWS deprecated path-style for new buckets; virtual-hosted style routes through AWS edge DNS.
  - **Configuration**: Set `S3_FORCE_PATH_STYLE=false` (the default when `S3_ENDPOINT` is unset).

---

## 4. Multipart Upload Lifecycle

Large video uploads follow a 6-stage lifecycle using presigned URLs:

```
[Browser / Client]                   [AutoAI API]                      [Storage Provider / MinIO]
       |                                   |                                        |
  (1)  | --- POST /upload/initiate ------> |                                        |
       |                                   | --- startMultipartUpload() ----------> |
       |                                   | <--- returns uploadId ---------------- |
       | <--- returns uploadId ------------|                                        |
       |                                   |                                        |
  (2)  | --- POST /upload/part-url ------> |                                        |
       |     (uploadId, partNumber: 1)     | --- presignUploadPart() -------------> |
       | <--- returns presigned PUT URL ---|                                        |
       |                                   |                                        |
  (3)  | ========================= PUT Part 1 Raw Bytes ==========================> |
       | <======================== returns ETag 1 ================================= |
       |                                   |                                        |
  (4)  | --- POST /upload/part-url ------> |                                        |
       |     (uploadId, partNumber: 2)     | --- presignUploadPart() -------------> |
       | <--- returns presigned PUT URL ---|                                        |
       |                                   |                                        |
  (5)  | ========================= PUT Part 2 Raw Bytes ==========================> |
       | <======================== returns ETag 2 ================================= |
       |                                   |                                        |
  (6)  | --- POST /upload/complete ------> |                                        |
       |     (uploadId, [ETag1, ETag2])    | --- completeMultipartUpload() -------> |
       |                                   | <--- stitched object ready ----------- |
       | <--- returns 200 OK --------------|                                        |
       |                                   |                                        |
 [Abort| --- POST /upload/abort ---------> |                                        |
  Flow]|     (uploadId)                    | --- abortMultipartUpload() ----------> |
       | <--- returns 200 OK --------------|                                        |
```

---

## 5. Backward Compatibility & Consumer Delegation

To maintain 100% backward compatibility with existing tests and scripts:
1. `apps/api/src/lib/s3.ts` acts as a facade delegating all operations to `getStorageProvider()`.
2. Existing routes (`apps/api/src/routes/upload.routes.ts`, `apps/api/src/routes/projects.routes.ts`) continue working without disruption.
3. Workers (`apps/api/src/queue/workers/analysis.worker.ts`, `render.worker.ts`) interact through standard functions or provider instances.
4. Health routes (`apps/api/src/routes/health.routes.ts`) verify bucket connectivity using the active provider.

---

## 6. Scope Boundaries & What Is NOT In Step 3B.1

In accordance with strict step isolation:
- **No AI Provider Refactoring**: Transcription (Whisper) and Claude fallback logic remain untouched.
- **No Remote URL Ingestion**: No downloading from external YouTube, Twitch, or HTTP video URLs.
- **No Livestream Ingestion**: No RTMP, HLS, or live chunk ingestion.
- **No Billing / Referral Logic**: Free tiers, credit balances, and referral tracking are out of scope.
- **No Cloud-Specific Native SDKs**: No `@google-cloud/storage` or `@azure/storage-blob`; only S3-compatible providers via AWS SDK v3 are supported.
- **No Production Deployments or Master Commits**: Master branch remains untouched; Render/Vercel production remains unaffected.
