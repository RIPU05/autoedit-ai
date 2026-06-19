import { Router } from 'express';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../lib/prisma.js';
import {
  signToken,
  hashPassword,
  comparePassword,
  cookieOptions,
  COOKIE_NAME,
} from '../utils/auth.js';
import { requireAuth, asyncHandler, HttpError } from '../middleware/auth.js';
import { env } from '../config/env.js';

export const authRouter = Router();

const credSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { email, password, name } = credSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, 'email already registered');
    const user = await prisma.user.create({
      data: { email, name, passwordHash: await hashPassword(password) },
    });
    const token = signToken({ sub: user.id, email: user.email });
    res
      .cookie(COOKIE_NAME, token, cookieOptions)
      .json({ user: { id: user.id, email: user.email, name: user.name }, token });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = credSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || !(await comparePassword(password, user.passwordHash))) {
      throw new HttpError(401, 'invalid credentials');
    }
    const token = signToken({ sub: user.id, email: user.email });
    res
      .cookie(COOKIE_NAME, token, cookieOptions)
      .json({ user: { id: user.id, email: user.email, name: user.name }, token });
  }),
);

authRouter.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions).json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { id: true, email: true, name: true, avatarUrl: true },
    });
    res.json({ user });
  }),
);

// ─── Google OAuth ────────────────────────────────────────────────────────────
// Flow: frontend redirects to /api/auth/google -> Google -> /google/callback.
const googleClient =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL)
    : null;

authRouter.get('/google', (_req, res) => {
  if (!googleClient) throw new HttpError(501, 'google oauth not configured');
  const url = googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'consent',
  });
  res.redirect(url);
});

authRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    if (!googleClient) throw new HttpError(501, 'google oauth not configured');
    const code = z.string().parse(req.query.code);
    const { tokens } = await googleClient.getToken(code);
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token!,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p?.email) throw new HttpError(400, 'google profile missing email');

    const user = await prisma.user.upsert({
      where: { email: p.email },
      create: { email: p.email, name: p.name, googleId: p.sub, avatarUrl: p.picture },
      update: { googleId: p.sub, avatarUrl: p.picture },
    });
    const token = signToken({ sub: user.id, email: user.email });
    res.cookie(COOKIE_NAME, token, cookieOptions).redirect(`${env.WEB_ORIGIN}/dashboard`);
  }),
);
