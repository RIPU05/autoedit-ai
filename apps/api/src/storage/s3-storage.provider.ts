import {
  S3Client,
  type S3ClientConfig,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  MediaStorageProvider,
  StorageConfig,
  StorageProviderType,
  PutObjectInput,
  PutObjectOutput,
  GetObjectInput,
  GetObjectOutput,
  GetObjectMetadataInput,
  ObjectMetadata,
  DeleteObjectInput,
  DeleteObjectOutput,
  StartMultipartUploadInput,
  StartMultipartUploadOutput,
  PresignUploadPartInput,
  CompleteMultipartUploadInput,
  CompleteMultipartUploadOutput,
  AbortMultipartUploadInput,
  AbortMultipartUploadOutput,
  CreateDownloadUrlInput,
  StorageHealthCheckResult,
} from './storage.types.js';

/**
 * S3-compatible implementation of MediaStorageProvider.
 *
 * Works natively with:
 * - AWS S3 (production standard)
 * - Local MinIO (local dev / Docker infrastructure)
 * - Cloudflare R2 (compatible S3 API)
 * - Future self-hosted or Ceph S3 endpoints
 */
export class S3StorageProvider implements MediaStorageProvider {
  readonly providerType: StorageProviderType;
  readonly defaultBucket: string;
  private readonly client: S3Client;
  private readonly defaultPresignTtl: number;

  constructor(config: StorageConfig, clientOverride?: S3Client) {
    this.providerType = config.providerType;
    this.defaultBucket = config.bucket;
    this.defaultPresignTtl = config.presignTtlSec ?? 3600;

    if (clientOverride) {
      this.client = clientOverride;
    } else {
      const clientConfig: S3ClientConfig = {
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      };

      if (config.endpoint) {
        clientConfig.endpoint = config.endpoint;
      }

      if (config.forcePathStyle !== undefined) {
        clientConfig.forcePathStyle = config.forcePathStyle;
      } else if (config.endpoint) {
        // MinIO and local emulators require path-style bucket addressing
        clientConfig.forcePathStyle = true;
      }

      this.client = new S3Client(clientConfig);
    }
  }

  /**
   * Returns the underlying S3Client instance for advanced or legacy operations.
   */
  getClient(): S3Client {
    return this.client;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectOutput> {
    const bucket = input.bucket ?? this.defaultBucket;
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        Body: input.body as any,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
    return {
      key: input.key,
      bucket,
      etag: res.ETag,
    };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectOutput> {
    const bucket = input.bucket ?? this.defaultBucket;
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: input.key,
      }),
    );
    return {
      body: res.Body as NodeJS.ReadableStream,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      etag: res.ETag,
      metadata: res.Metadata,
      lastModified: res.LastModified,
    };
  }

  async getObjectMetadata(input: GetObjectMetadataInput): Promise<ObjectMetadata> {
    const bucket = input.bucket ?? this.defaultBucket;
    const res = await this.client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: input.key,
      }),
    );
    return {
      contentLength: res.ContentLength,
      contentType: res.ContentType,
      etag: res.ETag,
      lastModified: res.LastModified,
      metadata: res.Metadata,
    };
  }

  async deleteObject(input: DeleteObjectInput): Promise<DeleteObjectOutput> {
    const bucket = input.bucket ?? this.defaultBucket;
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: input.key,
      }),
    );
    return {
      key: input.key,
      bucket,
      success: true,
    };
  }

  async startMultipartUpload(input: StartMultipartUploadInput): Promise<StartMultipartUploadOutput> {
    const bucket = input.bucket ?? this.defaultBucket;
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
    return {
      uploadId: res.UploadId!,
      key: input.key,
      bucket,
    };
  }

  async presignUploadPart(input: PresignUploadPartInput): Promise<string> {
    const bucket = input.bucket ?? this.defaultBucket;
    const cmd = new UploadPartCommand({
      Bucket: bucket,
      Key: input.key,
      UploadId: input.uploadId,
      PartNumber: input.partNumber,
    });
    return getSignedUrl(this.client, cmd, {
      expiresIn: input.expiresIn ?? this.defaultPresignTtl,
    });
  }

  async completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<CompleteMultipartUploadOutput> {
    const bucket = input.bucket ?? this.defaultBucket;
    const sortedParts = [...input.parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const res = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: { Parts: sortedParts },
      }),
    );
    return {
      key: input.key,
      bucket,
      location: res.Location,
      etag: res.ETag,
    };
  }

  async abortMultipartUpload(input: AbortMultipartUploadInput): Promise<AbortMultipartUploadOutput> {
    const bucket = input.bucket ?? this.defaultBucket;
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
    return {
      key: input.key,
      uploadId: input.uploadId,
      success: true,
    };
  }

  async createDownloadUrl(input: CreateDownloadUrlInput): Promise<string> {
    const bucket = input.bucket ?? this.defaultBucket;
    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: input.key,
    });
    return getSignedUrl(this.client, cmd, {
      expiresIn: input.expiresIn ?? this.defaultPresignTtl,
    });
  }

  async checkHealth(bucketOverride?: string): Promise<StorageHealthCheckResult> {
    const bucket = bucketOverride ?? this.defaultBucket;
    const t0 = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return {
        ok: true,
        provider: this.providerType,
        bucket,
        ms: Date.now() - t0,
      };
    } catch (err: any) {
      return {
        ok: false,
        provider: this.providerType,
        bucket,
        error: err?.message || String(err),
        ms: Date.now() - t0,
      };
    }
  }
}
