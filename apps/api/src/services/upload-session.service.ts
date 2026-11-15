import { connection as redis } from '../lib/redis.js';
import { env } from '../config/env.js';

export interface UploadSession {
  projectId: string;
  userId: string;
  uploadId: string;
  key: string;
  bucket: string;
  createdAt: number;
}

const memoryStore = new Map<string, UploadSession>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REDIS_TTL_SEC = 24 * 60 * 60;

function cleanupMemoryStore() {
  const now = Date.now();
  for (const [id, session] of memoryStore.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      memoryStore.delete(id);
    }
  }
}

export async function registerUploadSession(session: Omit<UploadSession, 'createdAt'>): Promise<UploadSession> {
  const fullSession: UploadSession = {
    ...session,
    createdAt: Date.now(),
  };

  memoryStore.set(session.uploadId, fullSession);
  cleanupMemoryStore();

  if (env.NODE_ENV !== 'test') {
    try {
      if (typeof (redis as any)?.set === 'function') {
        await (redis as any).set(
          `upload:session:${session.uploadId}`,
          JSON.stringify(fullSession),
          'EX',
          REDIS_TTL_SEC,
        );
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'upload_session.redis_set_failed',
          uploadId: session.uploadId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return fullSession;
}

export async function getUploadSession(uploadId: string): Promise<UploadSession | null> {
  const local = memoryStore.get(uploadId);
  if (local) {
    if (Date.now() - local.createdAt <= SESSION_TTL_MS) {
      return local;
    }
    memoryStore.delete(uploadId);
  }

  if (env.NODE_ENV !== 'test') {
    try {
      if (typeof (redis as any)?.get === 'function') {
        const raw = await (redis as any).get(`upload:session:${uploadId}`);
        if (raw) {
          const parsed = JSON.parse(raw) as UploadSession;
          memoryStore.set(uploadId, parsed);
          return parsed;
        }
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'upload_session.redis_get_failed',
          uploadId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return null;
}

export async function clearUploadSession(uploadId: string): Promise<void> {
  memoryStore.delete(uploadId);

  if (env.NODE_ENV !== 'test') {
    try {
      if (typeof (redis as any)?.del === 'function') {
        await (redis as any).del(`upload:session:${uploadId}`);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

export function resetUploadSessionsForTesting(): void {
  memoryStore.clear();
}
