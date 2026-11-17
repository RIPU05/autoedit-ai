import { describe, expect, it } from 'vitest';
import {
  validateLocalE2EEnvironment,
  assertLocalE2EEnvironment,
  sanitizeUrl,
} from '../../src/config/e2e-safety.js';

describe('E2E Local Environment Safety Validation', () => {
  const validLocalEnv = {
    DATABASE_URL: 'postgresql://autoedit:secret_pwd@localhost:5432/autoedit_local?schema=public',
    REDIS_URL: 'redis://:redis_secret@localhost:6379',
    S3_ENDPOINT: 'http://127.0.0.1:9002',
    S3_BUCKET: 'autoedit-local',
    API_BASE_URL: 'http://localhost:4000',
    WEB_BASE_URL: 'http://localhost:3000',
    AI_PROVIDER: 'fallback',
  };

  it('accepts valid local loopback environment configuration', () => {
    const result = validateLocalE2EEnvironment(validLocalEnv);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(() => assertLocalE2EEnvironment(validLocalEnv)).not.toThrow();
  });

  it('rejects remote production DATABASE_URL and masks password in error message', () => {
    const env = {
      ...validLocalEnv,
      DATABASE_URL: 'postgresql://admin:super_secret_db_pass@dpg-abc123.oregon-postgres.render.com/autoedit_prod',
    };
    const result = validateLocalE2EEnvironment(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('is not local loopback'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Forbidden remote domain'))).toBe(true);

    // Verify credentials are sanitized
    const allErrors = result.errors.join(' ');
    expect(allErrors).not.toContain('super_secret_db_pass');
    expect(allErrors).toContain('***:***');
  });

  it('rejects production database name on localhost', () => {
    const env = {
      ...validLocalEnv,
      DATABASE_URL: 'postgresql://autoedit:pwd@localhost:5432/production_live',
    };
    const result = validateLocalE2EEnvironment(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('not an authorized local test database'))).toBe(true);
  });

  it('rejects remote REDIS_URL and sanitizes token', () => {
    const env = {
      ...validLocalEnv,
      REDIS_URL: 'rediss://default:secret_token_123@us1-quick-sloth.upstash.io:6379',
    };
    const result = validateLocalE2EEnvironment(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('REDIS_URL host'))).toBe(true);
    expect(result.errors.some((e) => e.includes('upstash.io'))).toBe(true);

    const allErrors = result.errors.join(' ');
    expect(allErrors).not.toContain('secret_token_123');
  });

  it('rejects remote AWS S3 endpoint and unauthorized bucket', () => {
    const env = {
      ...validLocalEnv,
      S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      S3_BUCKET: 'production-video-assets',
    };
    const result = validateLocalE2EEnvironment(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Remote S3 endpoints are strictly forbidden'))).toBe(true);
    expect(result.errors.some((e) => e.includes('S3_BUCKET must be "autoedit-local"'))).toBe(true);
  });

  it('rejects production API and frontend URLs', () => {
    const env = {
      ...validLocalEnv,
      API_BASE_URL: 'https://autoedit-ai.onrender.com',
      WEB_BASE_URL: 'https://autoedit-ai.vercel.app',
    };
    const result = validateLocalE2EEnvironment(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('API_BASE_URL host'))).toBe(true);
    expect(result.errors.some((e) => e.includes('WEB_BASE_URL host'))).toBe(true);
  });

  it('rejects paid AI_PROVIDER (claude or ollama)', () => {
    const env1 = { ...validLocalEnv, AI_PROVIDER: 'claude' };
    const res1 = validateLocalE2EEnvironment(env1);
    expect(res1.ok).toBe(false);
    expect(res1.errors.some((e) => e.includes('must be strictly "fallback"'))).toBe(true);

    const env2 = { ...validLocalEnv, AI_PROVIDER: 'ollama' };
    const res2 = validateLocalE2EEnvironment(env2);
    expect(res2.ok).toBe(false);
  });

  it('assertLocalE2EEnvironment throws descriptive error on unsafe config', () => {
    const unsafeEnv = {
      ...validLocalEnv,
      API_BASE_URL: 'https://autoedit-ai.onrender.com',
    };
    expect(() => assertLocalE2EEnvironment(unsafeEnv)).toThrowError(/\[HARD SAFETY BLOCK\]/);
  });

  it('sanitizeUrl masks credentials in varied URL formats', () => {
    expect(sanitizeUrl('postgres://user:mypassword@localhost:5432/db')).toBe('postgres://***:***@localhost:5432/db');
    expect(sanitizeUrl('redis://:supersecret@127.0.0.1:6379')).toBe('redis://:***@127.0.0.1:6379');
    expect(sanitizeUrl('')).toBe('[undefined]');
  });
});
