import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';

function testKeyFor(req: Request) {
  const testKey = req.headers['x-test-rate-limit-key'];
  return `test:${typeof testKey === 'string' && testKey.length > 0 ? testKey : 'default'}`;
}

function clientIpKey(req: Request) {
  if (env.NODE_ENV === 'test') return testKeyFor(req);
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
}

function userOrIpKey(req: Request) {
  if (!req.user?.sub) return clientIpKey(req);
  const testKey = req.headers['x-test-rate-limit-key'];
  if (env.NODE_ENV === 'test' && typeof testKey === 'string' && testKey.length > 0) {
    return `test:${testKey}:user:${req.user.sub}`;
  }
  return `user:${req.user.sub}`;
}

function makeLimiter(max: number, keyGenerator?: (req: Request) => string) {
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : env.NODE_ENV === 'test' ? { keyGenerator: testKeyFor } : {}),
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: 'rate limit exceeded',
        retryAfterSec: Math.ceil(options.windowMs / 1000),
      });
    },
  });
}

export const AUTH_LIMITER = makeLimiter(5);
export const UPLOAD_LIMITER = makeLimiter(20, userOrIpKey);
export const INTEGRATION_LIMITER = makeLimiter(10, userOrIpKey);
export const GENERAL_API_LIMITER = makeLimiter(100, userOrIpKey);
