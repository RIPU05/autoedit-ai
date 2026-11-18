import crypto from 'node:crypto';
import type { RedisLikeClient } from '../ingestion-coordinator.js';

/**
 * Atomic Lua: acquire lease only if key does not exist (SET NX PX).
 * Returns { 1, ARGV[1] } on acquire, or { 0, currentToken } if held by someone else.
 */
const ACQUIRE_LOCK_LUA = `
local k = KEYS[1]
local token = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local existing = redis.call('GET', k)
if existing == false then
  redis.call('SET', k, token, 'PX', ttlMs)
  return { 1, token }
end
if existing == token then
  redis.call('PEXPIRE', k, ttlMs)
  return { 1, token }
end
return { 0, existing }
`;

/**
 * Atomic Lua: renew lease TTL ONLY if current holder matches ARGV[1].
 * Returns 1 if renewed, 0 if missing or owned by a different token.
 */
const RENEW_LOCK_LUA = `
local k = KEYS[1]
local token = ARGV[1]
local ttlMs = tonumber(ARGV[2])
if redis.call('GET', k) == token then
  return redis.call('PEXPIRE', k, ttlMs)
end
return 0
`;

/**
 * Atomic Lua: compare-and-delete — deletes key ONLY if current holder matches ARGV[1].
 * Prevents a slow/stalled worker from ever deleting a newer worker's active lock.
 * Returns 1 if released, 0 if missing or owned by a different token.
 */
const RELEASE_LOCK_LUA = `
local k = KEYS[1]
local token = ARGV[1]
if redis.call('GET', k) == token then
  return redis.call('DEL', k)
end
return 0
`;

/**
 * Atomic Lua: verify exact owner match (GET == token) and return remaining pttl in ms.
 * Returns { 1, pttlMs } if owned, { 0, -2 } if missing, { 0, pttlMs } if owned by another.
 */
const VERIFY_OWNER_LUA = `
local k = KEYS[1]
local token = ARGV[1]
local cur = redis.call('GET', k)
if cur == false then
  return { 0, -2 }
end
local pttl = redis.call('PTTL', k)
if cur == token then
  return { 1, pttl }
end
return { 0, pttl }
`;

export interface AcquireLockResult {
  acquired: boolean;
  ownerToken: string;
}

export interface VerifyOwnerResult {
  isOwner: boolean;
  pttlMs: number;
}

/**
 * Generates a unique, unguessable per-attempt ownership token scoped to workerId & generation.
 */
export function generateWorkOwnerToken(workerId: string, generation: number): string {
  return `${workerId}:g${generation}:${crypto.randomUUID()}`;
}

/**
 * Owner-tokenized Redis lease helper for shared media work coordination.
 *
 * SECURITY / CORRECTNESS BOUNDARY:
 * - Never executes unconditional DEL; release is strictly compare-and-delete via Lua.
 * - Renewal strictly checks token ownership before extending TTL.
 * - Redis lease is a fast coordination layer; PostgreSQL SharedMediaWork generation +
 *   ownerToken + leaseExpiresAt remain the durable fencing authority even if Redis loses keys.
 */
export class SharedWorkRedisLock {
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisLikeClient,
    keyPrefix = 'autoedit:media:api:',
  ) {
    this.keyPrefix = keyPrefix;
  }

  lockKey(sharedWorkKey: string): string {
    return `${this.keyPrefix}wlock:${sharedWorkKey}`;
  }

  async acquire(params: {
    sharedWorkKey: string;
    token: string;
    ttlMs: number;
  }): Promise<AcquireLockResult> {
    const ttl = Math.max(500, Math.floor(params.ttlMs));
    const res = (await this.redis.eval(
      ACQUIRE_LOCK_LUA,
      1,
      this.lockKey(params.sharedWorkKey),
      params.token,
      ttl,
    )) as [number | string, string];
    return {
      acquired: Number(res?.[0]) === 1,
      ownerToken: String(res?.[1] ?? ''),
    };
  }

  async renew(params: {
    sharedWorkKey: string;
    token: string;
    ttlMs: number;
  }): Promise<boolean> {
    const ttl = Math.max(500, Math.floor(params.ttlMs));
    const res = await this.redis.eval(
      RENEW_LOCK_LUA,
      1,
      this.lockKey(params.sharedWorkKey),
      params.token,
      ttl,
    );
    return Number(res) === 1;
  }

  async verifyOwner(params: {
    sharedWorkKey: string;
    token: string;
  }): Promise<VerifyOwnerResult> {
    const res = (await this.redis.eval(
      VERIFY_OWNER_LUA,
      1,
      this.lockKey(params.sharedWorkKey),
      params.token,
    )) as [number | string, number | string];
    return {
      isOwner: Number(res?.[0]) === 1,
      pttlMs: Number(res?.[1] ?? -2),
    };
  }

  async release(params: {
    sharedWorkKey: string;
    token: string;
  }): Promise<boolean> {
    const res = await this.redis.eval(
      RELEASE_LOCK_LUA,
      1,
      this.lockKey(params.sharedWorkKey),
      params.token,
    );
    return Number(res) === 1;
  }

  async getCurrentOwnerToken(sharedWorkKey: string): Promise<string | null> {
    const res = await this.redis.eval(
      `local v = redis.call('GET', KEYS[1]); if v == false then return nil else return v end`,
      1,
      this.lockKey(sharedWorkKey),
    );
    return typeof res === 'string' && res.length > 0 ? res : null;
  }
}
