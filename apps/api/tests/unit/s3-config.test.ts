import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

describe('S3 Client Configuration (getS3ClientConfig)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      API_PORT: '0',
      WEB_ORIGIN: 'http://localhost:3000',
      API_BASE_URL: 'http://localhost:4000',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/autoedit_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-jwt-secret-at-least-16-chars',
      INTEGRATION_ENCRYPTION_SECRET: 'test-integration-secret-at-least-32-chars',
      AI_PROVIDER: 'fallback',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test-access-key-id',
      AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
      S3_BUCKET: 'test-bucket',
    };
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_FORCE_PATH_STYLE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('preserves default AWS S3 configuration when S3_ENDPOINT is absent', async () => {
    const { getS3ClientConfig } = await import('../../src/lib/s3.js');
    const config = getS3ClientConfig();

    expect(config.region).toBe('us-east-1');
    expect(config.credentials).toEqual({
      accessKeyId: 'test-access-key-id',
      secretAccessKey: 'test-secret-access-key',
    });
    expect(config.endpoint).toBeUndefined();
    expect(config.forcePathStyle).toBeUndefined();
  });

  it('configures custom endpoint and defaults forcePathStyle to true when S3_ENDPOINT is set', async () => {
    process.env.S3_ENDPOINT = 'http://127.0.0.1:9002';
    const { getS3ClientConfig } = await import('../../src/lib/s3.js');
    const config = getS3ClientConfig();

    expect(config.endpoint).toBe('http://127.0.0.1:9002');
    expect(config.forcePathStyle).toBe(true);
    expect(config.region).toBe('us-east-1');
  });

  it('respects explicit S3_FORCE_PATH_STYLE=false even when S3_ENDPOINT is set', async () => {
    process.env.S3_ENDPOINT = 'http://127.0.0.1:9002';
    process.env.S3_FORCE_PATH_STYLE = 'false';
    const { getS3ClientConfig } = await import('../../src/lib/s3.js');
    const config = getS3ClientConfig();

    expect(config.endpoint).toBe('http://127.0.0.1:9002');
    expect(config.forcePathStyle).toBe(false);
  });

  it('respects explicit S3_FORCE_PATH_STYLE=true when S3_ENDPOINT is absent', async () => {
    process.env.S3_FORCE_PATH_STYLE = 'true';
    const { getS3ClientConfig } = await import('../../src/lib/s3.js');
    const config = getS3ClientConfig();

    expect(config.endpoint).toBeUndefined();
    expect(config.forcePathStyle).toBe(true);
  });

  it('createS3Client allows overriding configuration cleanly', async () => {
    process.env.S3_ENDPOINT = 'http://127.0.0.1:9002';
    const { createS3Client } = await import('../../src/lib/s3.js');
    const client = createS3Client({ region: 'eu-west-1' });

    expect(client).toBeDefined();
    expect(typeof client.send).toBe('function');
  });
});
