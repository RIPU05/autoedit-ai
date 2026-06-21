import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  INTEGRATION_ENCRYPTION_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),

  ANTHROPIC_API_KEY: z.string(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),
  CLAUDE_FAST_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  AI_PROVIDER: z.enum(['claude', 'ollama', 'fallback']).default('claude'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:8b'),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET: z.string(),
  S3_PRESIGN_TTL: z.coerce.number().default(3600),

  N8N_BASE_URL: z.string().optional(),
  N8N_API_KEY: z.string().optional(),
  N8N_WEBHOOK_SECRET: z.string().default('change-me'),

  RENDER_WORK_DIR: z.string().default('/tmp/autoedit'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5_368_709_120),

  // queue + worker controls (Phase 6)
  ANALYSIS_CONCURRENCY: z.coerce.number().default(2),
  ANALYSIS_LOCK_DURATION_MS: z.coerce.number().default(1000 * 60 * 15),
  RENDER_CONCURRENCY: z.coerce.number().default(1),
  RENDER_TIMEOUT_MS: z.coerce.number().default(1000 * 60 * 60), // 1h ceiling
  MEMORY_THRESHOLD_MB: z.coerce.number().default(1536),

  // Transcription sidecar (services/whisper)
  WHISPER_URL: z.string().url().default('http://localhost:9000'),
  WHISPER_MODEL: z.string().default('base'),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
