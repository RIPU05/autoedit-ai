/**
 * Storage Provider Abstraction Layer
 *
 * Defines the contract for object storage operations in AutoAI Edit.
 * Decouples upload, worker, render, and download business logic from
 * specific cloud vendors (AWS S3, local MinIO, Cloudflare R2, or self-hosted S3).
 */

export type StorageProviderType = 's3' | 'minio' | 'r2' | 'custom-s3';

export interface StorageConfig {
  providerType: StorageProviderType;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  presignTtlSec?: number;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array | NodeJS.ReadableStream;
  contentType?: string;
  bucket?: string;
  metadata?: Record<string, string>;
}

export interface PutObjectOutput {
  key: string;
  bucket: string;
  etag?: string;
}

export interface GetObjectInput {
  key: string;
  bucket?: string;
}

export interface GetObjectOutput {
  body: NodeJS.ReadableStream;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  metadata?: Record<string, string>;
  lastModified?: Date;
}

export interface GetObjectMetadataInput {
  key: string;
  bucket?: string;
}

export interface ObjectMetadata {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface DeleteObjectInput {
  key: string;
  bucket?: string;
}

export interface DeleteObjectOutput {
  key: string;
  bucket: string;
  success: boolean;
}

export interface StartMultipartUploadInput {
  key: string;
  contentType: string;
  bucket?: string;
  metadata?: Record<string, string>;
}

export interface StartMultipartUploadOutput {
  uploadId: string;
  key: string;
  bucket: string;
}

export interface PresignUploadPartInput {
  key: string;
  uploadId: string;
  partNumber: number;
  bucket?: string;
  expiresIn?: number;
}

export interface MultipartPartItem {
  PartNumber: number;
  ETag: string;
}

export interface CompleteMultipartUploadInput {
  key: string;
  uploadId: string;
  parts: MultipartPartItem[];
  bucket?: string;
}

export interface CompleteMultipartUploadOutput {
  key: string;
  bucket: string;
  location?: string;
  etag?: string;
}

export interface AbortMultipartUploadInput {
  key: string;
  uploadId: string;
  bucket?: string;
}

export interface AbortMultipartUploadOutput {
  key: string;
  uploadId: string;
  success: boolean;
}

export interface CreateDownloadUrlInput {
  key: string;
  bucket?: string;
  expiresIn?: number;
}

export interface StorageHealthCheckResult {
  ok: boolean;
  provider: string;
  bucket: string;
  endpoint?: string;
  error?: string;
  ms: number;
}

export interface MediaStorageProvider {
  readonly providerType: StorageProviderType;
  readonly defaultBucket: string;

  putObject(input: PutObjectInput): Promise<PutObjectOutput>;
  getObject(input: GetObjectInput): Promise<GetObjectOutput>;
  getObjectMetadata(input: GetObjectMetadataInput): Promise<ObjectMetadata>;
  deleteObject(input: DeleteObjectInput): Promise<DeleteObjectOutput>;

  startMultipartUpload(input: StartMultipartUploadInput): Promise<StartMultipartUploadOutput>;
  presignUploadPart(input: PresignUploadPartInput): Promise<string>;
  completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<CompleteMultipartUploadOutput>;
  abortMultipartUpload(input: AbortMultipartUploadInput): Promise<AbortMultipartUploadOutput>;

  createDownloadUrl(input: CreateDownloadUrlInput): Promise<string>;
  checkHealth(bucket?: string): Promise<StorageHealthCheckResult>;
}
