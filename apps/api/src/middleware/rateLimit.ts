import rateLimit, { type Store, type Options, type ClientRateLimitInfo } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';
import { connection as redis } from '../lib/redis.js';

function testKeyFor(req: Request) {
  const testKey = req.headers['x-test-rate-limit-key'];
  return `test:${typeof testKey === 'string' && testKey.length > 0 ? testKey : 'default'}`;
}

export function clientIpKey(req: Request): string {
  if (env.NODE_ENV === 'test') return testKeyFor(req);
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
}

export function userOrIpKey(req: Request): string {
  if (!req.user?.sub) return clientIpKey(req);
  const testKey = req.headers['x-test-rate-limit-key'];
  if (env.NODE_ENV === 'test' && typeof testKey === 'string' && testKey.length > 0) {
    return `test:${testKey}:user:${req.user.sub}`;
  }
  return `user:${req.user.sub}`;
}

export class ResilientRedisRateLimitStore implements Store {
  prefix: string;
  windowMs: number;
  private memoryFallback = new Map<string, { totalHits: number; resetTime: number }>();

  constructor(prefix: string, windowMs = 60_000) {
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const fullKey = `rl:${this.prefix}:${key}`;
    const now = Date.now();
    const resetTime = new Date(now + this.windowMs);

    // If in test mode or redis pipeline is not available, use fast memory store
    if (env.NODE_ENV === 'test' || !redis || typeof (redis as any).pipeline !== 'function') {
      return this.incrementMemory(key, now);
    }

    try {
      const p = (redis as any).pipeline();
      p.incr(fullKey);
      p.pttl(fullKey);
      const results = await p.exec();

      if (!results || results.length < 2) {
        return this.incrementMemory(key, now);
      }

      const [incrErr, hits] = results[0];
      const [ttlErr, ttlMs] = results[1];

      if (incrErr || ttlErr) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'rate_limit.redis_pipeline_error_fallback',
            key: fullKey,
            error: incrErr?.message || ttlErr?.message,
          }),
        );
        return this.incrementMemory(key, now);
      }

      const totalHits = Number(hits);

      if (ttlMs === -1 || ttlMs === -2 || totalHits === 1) {
        await (redis as any).pexpire(fullKey, this.windowMs).catch(() => {});
        return { totalHits, resetTime };
      }

      return { totalHits, resetTime: new Date(now + Math.max(0, Number(ttlMs))) };
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'rate_limit.redis_exception_fallback',
          key: fullKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return this.incrementMemory(key, now);
    }
  }

  private incrementMemory(key: string, now: number): ClientRateLimitInfo {
    const entry = this.memoryFallback.get(key);
    if (!entry || now > entry.resetTime) {
      const resetTime = now + this.windowMs;
      this.memoryFallback.set(key, { totalHits: 1, resetTime });
      return { totalHits: 1, resetTime: new Date(resetTime) };
    }
    entry.totalHits += 1;
    return { totalHits: entry.totalHits, resetTime: new Date(entry.resetTime) };
  }

  async decrement(key: string): Promise<void> {
    const fullKey = `rl:${this.prefix}:${key}`;
    if (env.NODE_ENV !== 'test' && redis && typeof (redis as any).decr === 'function') {
      try {
        await (redis as any).decr(fullKey);
      } catch {}
    }
    const entry = this.memoryFallback.get(key);
    if (entry && entry.totalHits > 0) {
      entry.totalHits -= 1;
    }
  }

  async resetKey(key: string): Promise<void> {
    const fullKey = `rl:${this.prefix}:${key}`;
    if (env.NODE_ENV !== 'test' && redis && typeof (redis as any).del === 'function') {
      try {
        await (redis as any).del(fullKey);
      } catch {}
    }
    this.memoryFallback.delete(key);
  }

  resetAll(): void {
    this.memoryFallback.clear();
  }
}

export function makeLimiter(
  prefix: string,
  max: number,
  windowMs = 60_000,
  keyGenerator?: (req: Request) => string,
) {
  const store = new ResilientRedisRateLimitStore(prefix, windowMs);
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: keyGenerator ?? (env.NODE_ENV === 'test' ? testKeyFor : clientIpKey),
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: 'rate limit exceeded',
        retryAfterSec: Math.ceil(options.windowMs / 1000),
      });
    },
  });
}

// Route-specific auth limiters
// Registration: 5 requests per 15 minutes (5/min in test mode)
export const AUTH_REGISTER_LIMITER = makeLimiter(
  'auth:reg',
  5,
  env.NODE_ENV === 'test' ? 60_000 : 15 * 60_000,
  clientIpKey,
);

// Login: 10 requests per 15 minutes (5/min in test mode)
export const AUTH_LOGIN_LIMITER = makeLimiter(
  'auth:login',
  env.NODE_ENV === 'test' ? 5 : 10,
  env.NODE_ENV === 'test' ? 60_000 : 15 * 60_000,
  clientIpKey,
);

// Session check (/api/auth/me): 120 requests per minute
export const AUTH_SESSION_LIMITER = makeLimiter('auth:me', 120, 60_000, userOrIpKey);

// Logout: 60 requests per minute
export const AUTH_LOGOUT_LIMITER = makeLimiter('auth:logout', 60, 60_000, userOrIpKey);

// Backwards-compatible legacy limiter
export const AUTH_LIMITER = AUTH_REGISTER_LIMITER;

// Feature limiters
export const UPLOAD_LIMITER = makeLimiter('upload', 20, 60_000, userOrIpKey);
export const INTEGRATION_LIMITER = makeLimiter('integration', 10, 60_000, userOrIpKey);
export const GENERAL_API_LIMITER = makeLimiter('general', 100, 60_000, userOrIpKey);
export const MEDIA_RESOLVE_LIMITER = makeLimiter('media:resolve', 60, 60_000, userOrIpKey);
export const MEDIA_JOB_LIMITER = makeLimiter('media:jobs', 30, 60_000, userOrIpKey);
