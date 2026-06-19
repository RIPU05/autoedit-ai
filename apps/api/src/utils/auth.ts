import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

export interface JwtPayload {
  sub: string; // user id
  email: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const comparePassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

// httpOnly cookie options for the JWT
export const cookieOptions = {
  httpOnly: true as const,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};
export const COOKIE_NAME = 'autoedit_token';
