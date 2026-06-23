# AutoEdit AI v0.11.0 — S3 Upload Reliability

## Summary

This release investigates and hardens the S3 multipart upload path before public deployment.

The original intermittent upload issue was classified as transient network/S3 PUT behavior plus an overly critical metadata-probe step after upload completion.

## What Was Investigated

Reviewed:

- backend upload routes
- S3 multipart helper
- frontend direct-to-S3 upload code
- old `tmp/run-v03-pipeline.ps1` helper behavior
- route regression tests
- live S3 upload matrix

## Fixes Applied

### Bounded Direct S3 PUT Retry

Frontend upload now retries only direct presigned S3 part `PUT` operations.

- Max attempts: 3
- Backoff: 1 second, then 2 seconds
- Operation retried: same presigned part `PUT`
- `/api/upload/start` is not blindly retried
- `/api/upload/complete` is not blindly retried

If all attempts fail, the upload fails cleanly with a part-level error.

### Non-Fatal Metadata Probe

`/api/upload/complete` no longer fails the upload if the best-effort metadata probe download or `ffprobe` fails.

The backend now:

- completes S3 multipart upload
- creates the asset record
- enqueues analysis
- logs `upload.probe_metadata_failed` when metadata probing fails

## Verified

- API build passed
- Web build passed
- Regression tests passed
- 21 mocked tests passed
- ETag quoting verified
- part ordering verified
- CORS/ETag exposure verified
- no `InvalidPart`
- no `InvalidPartOrder`
- no persistent missing `ETag`
- no metadata-probe-caused upload failure

## Live Reliability Matrix

Final matrix after hardening:

- Total cases: 39
- Passed: 35
- Failed: 4
- Failure class: transient external network/S3 connectivity

The remaining failures were not classified as app logic bugs.

## Remaining Caveat

Direct browser-to-S3 uploads still depend on network quality between the client and S3.

The old intermittent S3 PUT caveat is replaced with this clearer external-network caveat:

- direct S3 `PUT` can still fail after bounded retries under poor connectivity
- app upload completion no longer depends on best-effort metadata probing
- no S3 completion payload, CORS, ETag, bucket, or region bug was found

## Documentation

Added:

- `docs/s3-upload-reliability.md`

Added script:

- `apps/api/scripts/s3-upload-reliability.ts`

## Next Step

Recommended next branches:

- deployment hardening
- production upload observability
- CDN/S3 transfer acceleration evaluation if public users see upload latency
- resumable upload UI only after deployment traffic proves it is needed
