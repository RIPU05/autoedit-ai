import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  API_PORT: '0',
  WEB_ORIGIN: 'http://localhost:3000',
  API_BASE_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/autoedit_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-jwt-secret-at-least-16-chars',
  INTEGRATION_ENCRYPTION_SECRET: 'test-integration-secret-at-least-32-chars',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3:1.7b',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test-access-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'autoedit-test-bucket',
  RENDER_WORK_DIR: path.join(process.cwd(), 'tmp', 'env-test-work'),
  DOTENV_CONFIG_PATH: path.join(process.cwd(), 'tmp', 'missing-env-file'),
};

const loadEnv = async (overrides: Record<string, string | undefined>) => {
  vi.resetModules();
  const original = { ...process.env };

  process.env = { ...original, ...baseEnv };
  delete process.env.ANTHROPIC_API_KEY;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    const mod = await import('../../src/config/env.js');
    return mod.env;
  } finally {
    process.env = original;
  }
};

describe('env validation', () => {
  it('allows fallback provider without an Anthropic key', async () => {
    const env = await loadEnv({ AI_PROVIDER: 'fallback', ANTHROPIC_API_KEY: undefined });

    expect(env.AI_PROVIDER).toBe('fallback');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('allows ollama provider without an Anthropic key', async () => {
    const env = await loadEnv({ AI_PROVIDER: 'ollama', ANTHROPIC_API_KEY: undefined });

    expect(env.AI_PROVIDER).toBe('ollama');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('rejects claude provider without an Anthropic key', async () => {
    await expect(loadEnv({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: undefined })).rejects.toThrow(
      'ANTHROPIC_API_KEY is required when AI_PROVIDER=claude',
    );
  });

  it('allows claude provider with an Anthropic key', async () => {
    const env = await loadEnv({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'test-anthropic-key' });

    expect(env.AI_PROVIDER).toBe('claude');
    expect(env.ANTHROPIC_API_KEY).toBe('test-anthropic-key');
  });
});
