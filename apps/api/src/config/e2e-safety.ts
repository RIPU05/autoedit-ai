import fs from 'node:fs';
import path from 'node:path';

export function ensureDockerInPath(): void {
  if (process.platform !== 'win32') return;

  const currentPath = process.env.PATH || process.env.Path || '';
  const candidates = [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    'C:\\Program Files (x86)\\Docker\\Docker\\resources\\bin',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'resources', 'bin'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'DockerDesktop', 'resources', 'bin'),
    'C:\\Users\\RIPS\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin',
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'docker.exe'))) {
      if (!currentPath.split(';').includes(candidate)) {
        process.env.PATH = `${candidate};${currentPath}`;
        process.env.Path = `${candidate};${currentPath}`;
      }
      break;
    }
  }
}

export function sanitizeUrl(rawUrl?: string): string {
  if (!rawUrl) return '[undefined]';
  try {
    const u = new URL(rawUrl);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    // If not a valid URL (like a bare host or unix socket), redact any user:pass pattern
    return rawUrl.replace(/\/\/[^:@]+:[^@]+@/, '//***:***@');
  }
}

export function validateLocalE2EEnvironment(envMap: Record<string, string | undefined>): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  const isLocalHost = (host: string) =>
    ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'postgres', 'redis', 'minio', 'whisper'].includes(
      host.toLowerCase(),
    );

  // 1. DATABASE_URL
  const dbUrl = envMap.DATABASE_URL;
  if (!dbUrl) {
    errors.push('DATABASE_URL is missing. Local test database is required.');
  } else {
    try {
      const u = new URL(dbUrl);
      if (!isLocalHost(u.hostname)) {
        errors.push(`DATABASE_URL host "${u.hostname}" is not local loopback (${sanitizeUrl(dbUrl)}).`);
      }
      const pathname = u.pathname.replace(/^\//, '').toLowerCase();
      const allowedDatabases = ['autoedit_local', 'autoedit_test'];
      if (!allowedDatabases.includes(pathname)) {
        errors.push(
          `DATABASE_URL database name "${pathname}" is not an authorized local test database (allowed: ${allowedDatabases.join(', ')}).`,
        );
      }
    } catch {
      errors.push(`DATABASE_URL is malformed: ${sanitizeUrl(dbUrl)}`);
    }
  }

  // 2. REDIS_URL
  const redisUrl = envMap.REDIS_URL;
  if (!redisUrl) {
    errors.push('REDIS_URL is missing. Local development Redis is required.');
  } else {
    try {
      const u = new URL(redisUrl);
      if (!isLocalHost(u.hostname)) {
        errors.push(`REDIS_URL host "${u.hostname}" is not local loopback (${sanitizeUrl(redisUrl)}).`);
      }
    } catch {
      errors.push(`REDIS_URL is malformed: ${sanitizeUrl(redisUrl)}`);
    }
  }

  // 3. S3_ENDPOINT and S3_BUCKET
  const s3Endpoint = envMap.S3_ENDPOINT;
  const s3Bucket = envMap.S3_BUCKET;
  if (!s3Endpoint) {
    errors.push('S3_ENDPOINT is missing. Local MinIO endpoint is required for E2E tests.');
  } else {
    try {
      const u = new URL(s3Endpoint);
      if (!isLocalHost(u.hostname)) {
        errors.push(`S3_ENDPOINT "${u.hostname}" is not local loopback. Remote S3 endpoints are strictly forbidden.`);
      }
    } catch {
      errors.push(`S3_ENDPOINT is malformed: ${sanitizeUrl(s3Endpoint)}`);
    }
  }

  if (s3Bucket !== 'autoedit-local') {
    errors.push(`S3_BUCKET must be "autoedit-local", received "${s3Bucket || 'none'}".`);
  }

  // 4. API_BASE_URL and WEB_BASE_URL
  const apiBase = envMap.API_BASE_URL || 'http://localhost:4000';
  try {
    const u = new URL(apiBase);
    if (!isLocalHost(u.hostname)) {
      errors.push(`API_BASE_URL host "${u.hostname}" is not local loopback. Remote API targets are strictly forbidden.`);
    }
  } catch {
    errors.push(`API_BASE_URL is malformed: ${sanitizeUrl(apiBase)}`);
  }

  const webBase = envMap.WEB_BASE_URL || envMap.WEB_ORIGIN || 'http://localhost:3000';
  try {
    const u = new URL(webBase);
    if (!isLocalHost(u.hostname)) {
      errors.push(`WEB_BASE_URL host "${u.hostname}" is not local loopback. Remote web targets are strictly forbidden.`);
    }
  } catch {
    errors.push(`WEB_BASE_URL is malformed: ${sanitizeUrl(webBase)}`);
  }

  // 5. AI_PROVIDER
  const aiProvider = envMap.AI_PROVIDER;
  if (aiProvider !== 'fallback') {
    errors.push(
      `AI_PROVIDER must be strictly "fallback" for local E2E runs (received "${aiProvider || 'undefined'}"). Zero paid APIs allowed.`,
    );
  }

  // 6. Explicit rejection of known production domains anywhere in critical variables
  const allCriticalVars = [dbUrl, redisUrl, s3Endpoint, apiBase, webBase].filter(Boolean) as string[];
  const forbiddenDomains = [
    'render.com',
    'onrender.com',
    'vercel.app',
    'amazonaws.com',
    'upstash.io',
    'neon.tech',
    'supabase.co',
    'anthropic.com',
    'openai.com',
  ];
  for (const v of allCriticalVars) {
    for (const domain of forbiddenDomains) {
      if (v.toLowerCase().includes(domain)) {
        errors.push(`Forbidden remote domain "${domain}" detected in configuration: ${sanitizeUrl(v)}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertLocalE2EEnvironment(envMap: Record<string, string | undefined>): void {
  ensureDockerInPath();
  const result = validateLocalE2EEnvironment(envMap);
  if (!result.ok) {
    const formatted = result.errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(
      `[HARD SAFETY BLOCK] Refusing to run E2E tests against invalid or non-local configuration:\n${formatted}\n`,
    );
  }
}
