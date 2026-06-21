import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';

function getKey() {
  if (!env.INTEGRATION_ENCRYPTION_SECRET || env.INTEGRATION_ENCRYPTION_SECRET.length < 32) {
    throw new Error('INTEGRATION_ENCRYPTION_SECRET must be set to at least 32 characters');
  }
  return crypto.createHash('sha256').update(env.INTEGRATION_ENCRYPTION_SECRET).digest();
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(encryptedValue: string) {
  const [ivRaw, tagRaw, dataRaw] = encryptedValue.split('.');
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error('Invalid encrypted secret format');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64')), decipher.final()]).toString('utf8');
}

export function maskSecret(value: string) {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function encryptJson(value: unknown) {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(encryptedValue: string): T {
  return JSON.parse(decryptSecret(encryptedValue)) as T;
}
