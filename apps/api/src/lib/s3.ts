import {
  S3Client,
  type S3ClientConfig,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

export function getS3ClientConfig(): S3ClientConfig {
  const config: S3ClientConfig = {
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  };

  if (env.S3_ENDPOINT) {
    config.endpoint = env.S3_ENDPOINT;
  }

  if (env.S3_FORCE_PATH_STYLE !== undefined) {
    config.forcePathStyle = env.S3_FORCE_PATH_STYLE;
  } else if (env.S3_ENDPOINT) {
    // MinIO and local S3-compatible emulators require path-style bucket addressing
    config.forcePathStyle = true;
  }

  return config;
}

export function createS3Client(overrides?: Partial<S3ClientConfig>): S3Client {
  return new S3Client({
    ...getS3ClientConfig(),
    ...overrides,
  });
}

export const s3 = createS3Client();

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

export async function startMultipart(key: string, contentType: string, client: S3Client = s3, bucket: string = env.S3_BUCKET) {
  const res = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  );
  return { uploadId: res.UploadId!, key, bucket };
}

export async function presignUploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  client: S3Client = s3,
  bucket: string = env.S3_BUCKET,
) {
  const cmd = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(client, cmd, { expiresIn: env.S3_PRESIGN_TTL });
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { ETag: string; PartNumber: number }[],
  client: S3Client = s3,
  bucket: string = env.S3_BUCKET,
) {
  return client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
    }),
  );
}

export async function abortMultipart(key: string, uploadId: string, client: S3Client = s3, bucket: string = env.S3_BUCKET) {
  return client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

/** Server-side upload (used by the render worker for output files). */
export async function putObject(
  key: string,
  body: Buffer | NodeJS.ReadableStream,
  contentType: string,
  client: S3Client = s3,
  bucket: string = env.S3_BUCKET,
) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body as any, ContentType: contentType }));
  return { key, bucket };
}

/** Presigned GET URL for download / handing off to n8n. */
export async function presignDownload(key: string, client: S3Client = s3, bucket: string = env.S3_BUCKET) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: env.S3_PRESIGN_TTL,
  });
}
