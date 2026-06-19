import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

export const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = env.S3_BUCKET;

/**
 * Large-file strategy: the browser uploads directly to S3 using presigned
 * multipart-part URLs, so big videos never stream through our API.
 *
 *   1. POST /api/upload/start         -> startMultipart()  -> { uploadId, key }
 *   2. for each part: POST /api/upload/part -> presignUploadPart() -> URL
 *      browser PUTs the chunk to the URL, keeps the returned ETag
 *   3. POST /api/upload/complete      -> completeMultipart(parts)
 */

export async function startMultipart(key: string, contentType: string) {
  const res = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
  );
  return { uploadId: res.UploadId!, key, bucket: BUCKET };
}

export async function presignUploadPart(key: string, uploadId: string, partNumber: number) {
  const cmd = new UploadPartCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3, cmd, { expiresIn: env.S3_PRESIGN_TTL });
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { ETag: string; PartNumber: number }[],
) {
  return s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
    }),
  );
}

export async function abortMultipart(key: string, uploadId: string) {
  return s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
}

/** Server-side upload (used by the render worker for output files). */
export async function putObject(key: string, body: Buffer | NodeJS.ReadableStream, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body as any, ContentType: contentType }));
  return { key, bucket: BUCKET };
}

/** Presigned GET URL for download / handing off to n8n. */
export async function presignDownload(key: string) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: env.S3_PRESIGN_TTL,
  });
}
