import type { Request, Response, NextFunction } from 'express';
import { verifyToken, COOKIE_NAME, type JwtPayload } from '../utils/auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const bearer = req.headers.authorization?.replace('Bearer ', '');
  const token = req.cookies?.[COOKIE_NAME] ?? bearer;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Admin gate — looks up the user's role (JWT only carries id/email).
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const { prisma } = await import('../lib/prisma.js');
    const user = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { role: true } });
    if (user?.role !== 'ADMIN') return res.status(403).json({ error: 'admin only' });
    next();
  } catch {
    return res.status(500).json({ error: 'auth check failed' });
  }
}

// Central error handler — keep it last in the middleware chain.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'internal server error' });
}

// Wrap async handlers so thrown errors hit errorHandler.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
