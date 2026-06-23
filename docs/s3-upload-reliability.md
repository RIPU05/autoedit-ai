# S3 Upload Reliability

This document records the v0.11.0 upload reliability investigation.

## Upload Flow

AutoEdit uploads videos with S3 multipart upload:

1. `POST /api/upload/start`
   - Creates an S3 multipart upload.
   - Creates a `Project` shell with status `UPLOADING`.
   - Returns `projectId`, `key`, and `uploadId`.

2. `POST /api/upload/part`
   - Returns a presigned S3 `PUT` URL for one part number.
   - The browser uploads the file chunk directly to S3.
   - The browser reads the returned `ETag`.

3. `POST /api/upload/complete`
   - Sends `{ ETag, PartNumber }[]` to S3 `CompleteMultipartUpload`.
   - The backend sorts parts by `PartNumber`.
   - The backend creates the source asset record.
   - The backend enqueues analysis.

The video file does not stream through the API during upload.

## Investigation Summary

The old intermittent failure was reproduced as transient network/S3 connectivity during direct S3 operations and post-complete metadata probing.

Observed evidence:

- No `InvalidPart`
- No `InvalidPartOrder`
- No `NoSuchBucket`
- No `SignatureDoesNotMatch`
- No persistent missing `ETag`
- No CORS/ETag exposure failure
- No API `429` during paced reliability runs

The old helper script used raw quoted ETags, while the frontend strips quotes. Both quoted and unquoted ETag completion were verified as acceptable in this environment.

## Fixes Applied

### Bounded S3 PUT Retry

The frontend now retries only direct presigned S3 part `PUT` operations.

Retry behavior:

- Max attempts: 3
- Backoff: 1 second, then 2 seconds
- Retried operation: direct S3 `PUT` for the same upload id and part number
- Not blindly retried: `/api/upload/start`
- Not blindly retried: `/api/upload/complete`

If all attempts fail, the upload fails with a clear part-level error.

### Non-Fatal Metadata Probe

`/api/upload/complete` still attempts to download the completed object and run `ffprobe` for metadata, but that probe is now best-effort.

If the probe download or `ffprobe` fails:

- upload completion still succeeds
- source asset is still created
- analysis job is still enqueued
- a structured warning is logged as `upload.probe_metadata_failed`

## Reliability Script

Run from `apps/api` with the API server running:

```powershell
npx tsx scripts/s3-upload-reliability.ts
```

The default matrix runs:

- 25 small uploads
- 10 medium uploads
- 3 multipart-style uploads
- 1 ETag normalization check

The script records:

- pass/fail
- request timing
- part number
- ETag presence
- retry count
- S3/API status when available
- failure classification

Environment overrides:

```env
S3_RELIABILITY_SMALL=25
S3_RELIABILITY_MEDIUM=10
S3_RELIABILITY_MULTIPART=3
S3_RELIABILITY_REQUEST_DELAY_MS=3250
S3_RELIABILITY_REQUEST_TIMEOUT_MS=180000
S3_RELIABILITY_UPLOAD_PART_ATTEMPTS=3
```

## Final Observed Run

Final matrix after hardening:

- Total: 39
- Passed: 35
- Failed: 4
- Failure class: transient external network/S3 connectivity

Failures after hardening:

- 2 `/api/upload/complete` client-side timeouts while the upload had already reached S3
- 2 direct S3 `PUT` failures after bounded retries

No application logic failure was observed in the final run.

## S3 CORS Requirements

The bucket CORS config must expose `ETag` so browsers can complete multipart uploads:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

## Rate Limit Considerations

Upload API routes are rate-limited per authenticated user.

For very small chunk sizes or aggressive parallel uploads, tune:

- frontend chunk size
- client upload concurrency
- `UPLOAD_LIMITER`

The reliability script paces requests to avoid confusing rate-limit failures with S3 failures.

## Deployment Notes

Before public deployment:

- keep the bucket private
- keep `ETag` exposed in CORS
- monitor S3 `PUT` latency/failure rate
- monitor `upload.probe_metadata_failed`
- consider server-side object metadata probing in a background job if probe latency becomes noisy

The old intermittent S3 PUT caveat is now replaced by a clearer external-network caveat: direct browser-to-S3 uploads can still fail under poor local network conditions, but app-level upload completion no longer depends on best-effort metadata probing, and direct part PUTs now retry safely.
