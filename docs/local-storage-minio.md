# AutoAI Edit — Local S3-Compatible Storage Guide (Step 2B)

This guide documents the local S3-compatible storage setup using MinIO, introduced in Step 2A and integrated in Step 2B.

---

## 1. How to Start Local Storage and Infrastructure

The isolated local infrastructure runs via Docker Compose without touching production or paid cloud services.

```bash
# Start all local containers (PostgreSQL, Redis, MinIO, Faster-Whisper)
docker compose -f docker-compose.local.yml up -d

# Verify all containers are running and healthy
docker compose -f docker-compose.local.yml ps
```

The MinIO service exposes two ports:
- **S3 API Port:** `127.0.0.1:9002`
- **Web Console Port:** `127.0.0.1:9003`

The companion container `autoedit-local-minio-init` automatically creates the private test bucket `autoedit-local` upon startup.

To inspect MinIO via browser console:
- **URL:** http://127.0.0.1:9003
- **Username:** `minio_local_admin`
- **Password:** `minio_local_secret_key`

---

## 2. Configuring the API for Local MinIO

Copy `.env.local.example` or update your local `.env` with the following variables:

```ini
# S3 Storage Configuration — Local MinIO
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=minio_local_admin
AWS_SECRET_ACCESS_KEY=minio_local_secret_key
S3_BUCKET=autoedit-local
S3_ENDPOINT=http://127.0.0.1:9002
S3_FORCE_PATH_STYLE=true
S3_PRESIGN_TTL=3600
```

---

## 3. Host Endpoint vs. Container Networking

Understanding endpoint resolution is critical when working with presigned URLs and containerized services:

1. **Host-Running API / Browser:**
   - When the API and Next.js frontend run on the host machine, they communicate with MinIO at `http://127.0.0.1:9002`.
   - Browser client uploads (direct multipart PUT) must send requests to `127.0.0.1:9002` where the port is published on the Windows host.

2. **Container-to-Container Communication:**
   - If the API runs inside a Docker container on the compose network, it reaches MinIO using the internal container service name: `http://minio:9002`.

3. **Presigned URL Signatures:**
   - S3 presigned URLs embed the target `Host` header in the cryptographic signature (`X-Amz-SignedHeaders=host`).
   - If the API signs a URL with `http://minio:9002` but a browser attempts to access it at `http://127.0.0.1:9002`, MinIO will reject the request with `SignatureDoesNotMatch`.
   - In Step 2B, the API signs URLs using `http://127.0.0.1:9002` so that the host browser and worker processes can access and upload directly.

---

## 4. How to Verify the Storage Connection

Run the dedicated automated integration tests:

```bash
# Run real MinIO integration tests
npm test --prefix apps/api -- tests/integration/minio-storage.test.ts
```

Tests verified:
- Bucket connectivity and health
- Direct object upload and retrieval with SHA-256 verification
- Presigned GET URL download via standard HTTP fetch
- Complete multipart upload lifecycle (initiating, presigning parts, uploading 5MB+ chunks, collecting ETags, completing, and verifying stitched object hash)
- Multipart abort and cleanup
- Error handling on missing keys and unauthorized credentials

---

## 5. Troubleshooting Presigned URL Signature Failures

If you encounter `SignatureDoesNotMatch` or upload errors:

1. **Host Header Mismatch:**
   - Ensure the hostname in `S3_ENDPOINT` matches the exact URL accessed by the client. Do not use `localhost` in one place and `127.0.0.1` in another.
2. **Virtual-Host vs Path-Style Addressing:**
   - MinIO requires path-style addressing (`http://127.0.0.1:9002/autoedit-local/...`).
   - If `S3_FORCE_PATH_STYLE` is set to `false`, the AWS SDK attempts virtual-hosted addressing (`http://autoedit-local.127.0.0.1:9002/...`), which fails without custom DNS resolution.
   - Keep `S3_FORCE_PATH_STYLE=true`.
3. **Minimum Multipart Part Size:**
   - MinIO and AWS S3 enforce a minimum part size of 5 MiB (5,242,880 bytes) for all parts except the last part. Any intermediate part smaller than 5 MiB will cause `CompleteMultipartUpload` to fail with `EntityTooSmall`.

---

## 6. How to Switch Back to AWS S3 (Production Mode)

To restore standard AWS S3 operation without any code modifications:

1. Simply remove or comment out `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` in your `.env`:
   ```ini
   # Production AWS S3
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   S3_BUCKET=my-production-bucket
   # S3_ENDPOINT=
   # S3_FORCE_PATH_STYLE=
   ```
2. When `S3_ENDPOINT` is omitted, the API automatically uses default AWS S3 virtual-hosted endpoints with standard AWS routing. No code changes are required.
