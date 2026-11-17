import type { CanonicalSourceId, SharedIngestionState } from '@autoedit/contracts';
import { MediaSourceError } from './errors.js';

export interface IngestionCoordinationRecord {
  canonicalSourceId: CanonicalSourceId;
  state: SharedIngestionState;
  ownerWorkerId: string | null;
  fencingToken: number;
  attempts: number;
  maxRetries: number;
  leaseExpiresAtMs: number;
  updatedAtMs: number;
  requesters: string[];
  artifactRef?: string;
  lastError?: string;
}

export type IngestionRequestAction =
  | 'ACQUIRED_NEW'
  | 'ACQUIRED_RECOVERY'
  | 'ATTACH_EXISTING'
  | 'REUSE_READY'
  | 'FAILED_MAX_RETRIES';

export interface RequestIngestionInput {
  canonicalSourceId: CanonicalSourceId;
  requesterId: string;
  workerId: string;
  leaseMs?: number;
  maxRetries?: number;
  nowMs?: number;
}

export interface RequestIngestionResult {
  action: IngestionRequestAction;
  deduplicated: boolean;
  fencingToken: number;
  record: IngestionCoordinationRecord;
}

export interface CoordinationStore {
  get(canonicalSourceId: CanonicalSourceId): Promise<IngestionCoordinationRecord | null>;
  requestIngestion(input: Required<RequestIngestionInput>): Promise<RequestIngestionResult>;
  transitionState(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nextState: SharedIngestionState;
    leaseMs?: number;
    artifactRef?: string;
    lastError?: string;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord>;
  renewLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs: number;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord>;
  releaseLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nowMs: number;
  }): Promise<boolean>;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_TRACKED_REQUESTERS = 5000;

function addRequester(list: string[], requesterId: string): string[] {
  if (list.includes(requesterId)) return list;
  if (list.length >= MAX_TRACKED_REQUESTERS) return list;
  return [...list, requesterId];
}

/**
 * Deterministic in-memory coordination store implementing the exact same
 * lease, fencing-token, retry, and recovery semantics as the Redis Lua store.
 * Useful for isolated unit and concurrency tests.
 */
export class InMemoryCoordinationStore implements CoordinationStore {
  private readonly records = new Map<CanonicalSourceId, IngestionCoordinationRecord>();

  async get(canonicalSourceId: CanonicalSourceId): Promise<IngestionCoordinationRecord | null> {
    const rec = this.records.get(canonicalSourceId);
    return rec ? { ...rec, requesters: [...rec.requesters] } : null;
  }

  async requestIngestion(input: Required<RequestIngestionInput>): Promise<RequestIngestionResult> {
    const existing = this.records.get(input.canonicalSourceId);

    // Case 1: Already READY -> reuse immediately, zero duplicate work
    if (existing && existing.state === 'READY') {
      const updated: IngestionCoordinationRecord = {
        ...existing,
        requesters: addRequester(existing.requesters, input.requesterId),
        updatedAtMs: input.nowMs,
      };
      this.records.set(input.canonicalSourceId, updated);
      return {
        action: 'REUSE_READY',
        deduplicated: true,
        fencingToken: updated.fencingToken,
        record: { ...updated, requesters: [...updated.requesters] },
      };
    }

    // Case 2: Active lease held by a live worker -> attach requester, zero duplicate work
    if (
      existing &&
      (existing.state === 'ACQUIRING' || existing.state === 'INGESTING') &&
      existing.leaseExpiresAtMs > input.nowMs
    ) {
      const updated: IngestionCoordinationRecord = {
        ...existing,
        requesters: addRequester(existing.requesters, input.requesterId),
        updatedAtMs: input.nowMs,
      };
      this.records.set(input.canonicalSourceId, updated);
      return {
        action: 'ATTACH_EXISTING',
        deduplicated: true,
        fencingToken: updated.fencingToken,
        record: { ...updated, requesters: [...updated.requesters] },
      };
    }

    // Case 3: Lease expired (worker crashed) or previous attempt failed -> bounded recovery
    if (existing) {
      const nextAttempts = existing.attempts + 1;
      const maxRetries = existing.maxRetries || input.maxRetries;

      if (nextAttempts > maxRetries) {
        const exhausted: IngestionCoordinationRecord = {
          ...existing,
          state: 'FAILED',
          ownerWorkerId: null,
          leaseExpiresAtMs: 0,
          updatedAtMs: input.nowMs,
          lastError: existing.lastError ?? 'Maximum ingestion retry attempts exceeded.',
          requesters: addRequester(existing.requesters, input.requesterId),
        };
        this.records.set(input.canonicalSourceId, exhausted);
        return {
          action: 'FAILED_MAX_RETRIES',
          deduplicated: true,
          fencingToken: exhausted.fencingToken,
          record: { ...exhausted, requesters: [...exhausted.requesters] },
        };
      }

      const recovered: IngestionCoordinationRecord = {
        ...existing,
        state: 'ACQUIRING',
        ownerWorkerId: input.workerId,
        fencingToken: existing.fencingToken + 1,
        attempts: nextAttempts,
        maxRetries,
        leaseExpiresAtMs: input.nowMs + input.leaseMs,
        updatedAtMs: input.nowMs,
        requesters: addRequester(existing.requesters, input.requesterId),
      };
      this.records.set(input.canonicalSourceId, recovered);
      return {
        action: 'ACQUIRED_RECOVERY',
        deduplicated: false,
        fencingToken: recovered.fencingToken,
        record: { ...recovered, requesters: [...recovered.requesters] },
      };
    }

    // Case 4: Brand new canonical source -> acquire lease atomically
    const created: IngestionCoordinationRecord = {
      canonicalSourceId: input.canonicalSourceId,
      state: 'ACQUIRING',
      ownerWorkerId: input.workerId,
      fencingToken: 1,
      attempts: 1,
      maxRetries: input.maxRetries,
      leaseExpiresAtMs: input.nowMs + input.leaseMs,
      updatedAtMs: input.nowMs,
      requesters: [input.requesterId],
    };
    this.records.set(input.canonicalSourceId, created);
    return {
      action: 'ACQUIRED_NEW',
      deduplicated: false,
      fencingToken: created.fencingToken,
      record: { ...created, requesters: [...created.requesters] },
    };
  }

  async transitionState(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nextState: SharedIngestionState;
    leaseMs?: number;
    artifactRef?: string;
    lastError?: string;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord> {
    const existing = this.records.get(input.canonicalSourceId);
    if (!existing) {
      throw new MediaSourceError({
        code: 'COORDINATION_CONFLICT',
        message: `No active ingestion record for ${input.canonicalSourceId}.`,
      });
    }
    if (existing.ownerWorkerId !== input.workerId || existing.fencingToken !== input.fencingToken) {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: `Stale worker "${input.workerId}" (token ${input.fencingToken}) no longer owns ${input.canonicalSourceId}.`,
      });
    }
    if (existing.leaseExpiresAtMs <= input.nowMs) {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: `Lease expired for worker "${input.workerId}" on ${input.canonicalSourceId}.`,
      });
    }

    const isTerminal = input.nextState === 'READY' || input.nextState === 'FAILED' || input.nextState === 'EXPIRED';
    const updated: IngestionCoordinationRecord = {
      ...existing,
      state: input.nextState,
      ownerWorkerId: isTerminal ? null : existing.ownerWorkerId,
      leaseExpiresAtMs: isTerminal
        ? 0
        : input.leaseMs
          ? input.nowMs + input.leaseMs
          : existing.leaseExpiresAtMs,
      artifactRef: input.artifactRef ?? existing.artifactRef,
      lastError: input.lastError ?? existing.lastError,
      updatedAtMs: input.nowMs,
    };
    this.records.set(input.canonicalSourceId, updated);
    return { ...updated, requesters: [...updated.requesters] };
  }

  async renewLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs: number;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord> {
    const existing = this.records.get(input.canonicalSourceId);
    if (!existing || existing.ownerWorkerId !== input.workerId || existing.fencingToken !== input.fencingToken) {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: `Cannot renew lease: worker "${input.workerId}" does not own ${input.canonicalSourceId}.`,
      });
    }
    if (existing.leaseExpiresAtMs <= input.nowMs) {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: `Cannot renew lease: lease already expired for ${input.canonicalSourceId}.`,
      });
    }
    const updated: IngestionCoordinationRecord = {
      ...existing,
      leaseExpiresAtMs: input.nowMs + input.leaseMs,
      updatedAtMs: input.nowMs,
    };
    this.records.set(input.canonicalSourceId, updated);
    return { ...updated, requesters: [...updated.requesters] };
  }

  async releaseLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nowMs: number;
  }): Promise<boolean> {
    const existing = this.records.get(input.canonicalSourceId);
    if (!existing || existing.ownerWorkerId !== input.workerId || existing.fencingToken !== input.fencingToken) {
      return false;
    }
    const updated: IngestionCoordinationRecord = {
      ...existing,
      state: existing.state === 'READY' ? 'READY' : 'EXPIRED',
      ownerWorkerId: null,
      leaseExpiresAtMs: 0,
      updatedAtMs: input.nowMs,
    };
    this.records.set(input.canonicalSourceId, updated);
    return true;
  }

  clear(): void {
    this.records.clear();
  }
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const REQUEST_INGESTION_LUA = `
local key = KEYS[1]
local canonicalId = ARGV[1]
local requesterId = ARGV[2]
local workerId = ARGV[3]
local leaseMs = tonumber(ARGV[4])
local maxRetries = tonumber(ARGV[5])
local nowMs = tonumber(ARGV[6])
local recordTtlMs = tonumber(ARGV[7])

local raw = redis.call('GET', key)
local rec = nil
if raw then
  rec = cjson.decode(raw)
end

local function addRequester(list, id)
  if not list then list = {} end
  for _, v in ipairs(list) do
    if v == id then return list end
  end
  if #list < 5000 then
    table.insert(list, id)
  end
  return list
end

if rec and rec.state == 'READY' then
  rec.requesters = addRequester(rec.requesters, requesterId)
  rec.updatedAtMs = nowMs
  redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
  return cjson.encode({ action = 'REUSE_READY', deduplicated = true, fencingToken = rec.fencingToken, record = rec })
end

if rec and (rec.state == 'ACQUIRING' or rec.state == 'INGESTING') and rec.leaseExpiresAtMs > nowMs then
  rec.requesters = addRequester(rec.requesters, requesterId)
  rec.updatedAtMs = nowMs
  redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
  return cjson.encode({ action = 'ATTACH_EXISTING', deduplicated = true, fencingToken = rec.fencingToken, record = rec })
end

if rec then
  local nextAttempts = (rec.attempts or 0) + 1
  local limit = rec.maxRetries or maxRetries
  if nextAttempts > limit then
    rec.state = 'FAILED'
    rec.ownerWorkerId = cjson.null
    rec.leaseExpiresAtMs = 0
    rec.updatedAtMs = nowMs
    rec.requesters = addRequester(rec.requesters, requesterId)
    if not rec.lastError then rec.lastError = 'Maximum ingestion retry attempts exceeded.' end
    redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
    return cjson.encode({ action = 'FAILED_MAX_RETRIES', deduplicated = true, fencingToken = rec.fencingToken, record = rec })
  end
  rec.state = 'ACQUIRING'
  rec.ownerWorkerId = workerId
  rec.fencingToken = (rec.fencingToken or 0) + 1
  rec.attempts = nextAttempts
  rec.maxRetries = limit
  rec.leaseExpiresAtMs = nowMs + leaseMs
  rec.updatedAtMs = nowMs
  rec.requesters = addRequester(rec.requesters, requesterId)
  redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
  return cjson.encode({ action = 'ACQUIRED_RECOVERY', deduplicated = false, fencingToken = rec.fencingToken, record = rec })
end

local created = {
  canonicalSourceId = canonicalId,
  state = 'ACQUIRING',
  ownerWorkerId = workerId,
  fencingToken = 1,
  attempts = 1,
  maxRetries = maxRetries,
  leaseExpiresAtMs = nowMs + leaseMs,
  updatedAtMs = nowMs,
  requesters = { requesterId }
}
redis.call('SET', key, cjson.encode(created), 'PX', recordTtlMs)
return cjson.encode({ action = 'ACQUIRED_NEW', deduplicated = false, fencingToken = 1, record = created })
`;

const MUTATE_LEASE_LUA = `
local key = KEYS[1]
local mode = ARGV[1]
local workerId = ARGV[2]
local token = tonumber(ARGV[3])
local nextState = ARGV[4]
local leaseMs = tonumber(ARGV[5])
local artifactRef = ARGV[6]
local lastError = ARGV[7]
local nowMs = tonumber(ARGV[8])
local recordTtlMs = tonumber(ARGV[9])

local raw = redis.call('GET', key)
if not raw then
  return cjson.encode({ error = 'COORDINATION_CONFLICT' })
end
local rec = cjson.decode(raw)
if rec.ownerWorkerId ~= workerId or rec.fencingToken ~= token then
  return cjson.encode({ error = 'LEASE_EXPIRED' })
end
if mode ~= 'release' and rec.leaseExpiresAtMs <= nowMs then
  return cjson.encode({ error = 'LEASE_EXPIRED' })
end

if mode == 'renew' then
  rec.leaseExpiresAtMs = nowMs + leaseMs
  rec.updatedAtMs = nowMs
elseif mode == 'release' then
  if rec.state ~= 'READY' then rec.state = 'EXPIRED' end
  rec.ownerWorkerId = cjson.null
  rec.leaseExpiresAtMs = 0
  rec.updatedAtMs = nowMs
else
  local isTerminal = (nextState == 'READY' or nextState == 'FAILED' or nextState == 'EXPIRED')
  rec.state = nextState
  if isTerminal then
    rec.ownerWorkerId = cjson.null
    rec.leaseExpiresAtMs = 0
  elseif leaseMs > 0 then
    rec.leaseExpiresAtMs = nowMs + leaseMs
  end
  if artifactRef ~= '' then rec.artifactRef = artifactRef end
  if lastError ~= '' then rec.lastError = lastError end
  rec.updatedAtMs = nowMs
end

redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
return cjson.encode({ ok = true, record = rec })
`;

/**
 * Redis-backed atomic coordination store using existing ioredis connection.
 * Uses single-key Lua scripts for atomic lease acquisition, renewal, fencing, and recovery.
 */
export class RedisCoordinationStore implements CoordinationStore {
  private readonly keyPrefix: string;
  private readonly recordTtlMs: number;

  constructor(
    private readonly redis: RedisLikeClient,
    opts?: { keyPrefix?: string; recordTtlMs?: number },
  ) {
    this.keyPrefix = opts?.keyPrefix ?? 'autoedit:ingest:coord:';
    this.recordTtlMs = opts?.recordTtlMs ?? 24 * 60 * 60 * 1000;
  }

  private key(canonicalSourceId: CanonicalSourceId): string {
    return `${this.keyPrefix}${canonicalSourceId}`;
  }

  async get(canonicalSourceId: CanonicalSourceId): Promise<IngestionCoordinationRecord | null> {
    const raw = await this.redis.get(this.key(canonicalSourceId));
    if (!raw) return null;
    return JSON.parse(raw) as IngestionCoordinationRecord;
  }

  async requestIngestion(input: Required<RequestIngestionInput>): Promise<RequestIngestionResult> {
    const raw = (await this.redis.eval(
      REQUEST_INGESTION_LUA,
      1,
      this.key(input.canonicalSourceId),
      input.canonicalSourceId,
      input.requesterId,
      input.workerId,
      input.leaseMs,
      input.maxRetries,
      input.nowMs,
      this.recordTtlMs,
    )) as string;
    return JSON.parse(raw) as RequestIngestionResult;
  }

  async transitionState(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nextState: SharedIngestionState;
    leaseMs?: number;
    artifactRef?: string;
    lastError?: string;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord> {
    const raw = (await this.redis.eval(
      MUTATE_LEASE_LUA,
      1,
      this.key(input.canonicalSourceId),
      'transition',
      input.workerId,
      input.fencingToken,
      input.nextState,
      input.leaseMs ?? 0,
      input.artifactRef ?? '',
      input.lastError ?? '',
      input.nowMs,
      this.recordTtlMs,
    )) as string;
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; record?: IngestionCoordinationRecord };
    if (parsed.error === 'COORDINATION_CONFLICT') {
      throw new MediaSourceError({
        code: 'COORDINATION_CONFLICT',
        message: `No active ingestion record for ${input.canonicalSourceId}.`,
      });
    }
    if (parsed.error === 'LEASE_EXPIRED' || !parsed.record) {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: `Worker "${input.workerId}" (token ${input.fencingToken}) lost lease on ${input.canonicalSourceId}.`,
      });
    }
    return parsed.record;
  }

  async renewLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs: number;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord> {
    const raw = (await this.redis.eval(
      MUTATE_LEASE_LUA,
      1,
      this.key(input.canonicalSourceId),
      'renew',
      input.workerId,
      input.fencingToken,
      '',
      input.leaseMs,
      '',
      '',
      input.nowMs,
      this.recordTtlMs,
    )) as string;
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; record?: IngestionCoordinationRecord };
    if (parsed.error || !parsed.record) {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: `Cannot renew lease for worker "${input.workerId}" on ${input.canonicalSourceId}.`,
      });
    }
    return parsed.record;
  }

  async releaseLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nowMs: number;
  }): Promise<boolean> {
    const raw = (await this.redis.eval(
      MUTATE_LEASE_LUA,
      1,
      this.key(input.canonicalSourceId),
      'release',
      input.workerId,
      input.fencingToken,
      '',
      0,
      '',
      '',
      input.nowMs,
      this.recordTtlMs,
    )) as string;
    const parsed = JSON.parse(raw) as { ok?: boolean };
    return Boolean(parsed.ok);
  }
}

/**
 * Shared Ingestion Coordinator
 * Guarantees at most one active lease per canonicalSourceId at a time using
 * TTL leases and monotonic fencing tokens (at-least-once with fencing on crash recovery).
 */
export class SharedIngestionCoordinator {
  constructor(private readonly store: CoordinationStore) {}

  requestIngestion(input: RequestIngestionInput): Promise<RequestIngestionResult> {
    return this.store.requestIngestion({
      canonicalSourceId: input.canonicalSourceId,
      requesterId: input.requesterId,
      workerId: input.workerId,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  markIngesting(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    return this.store.transitionState({
      ...input,
      nextState: 'INGESTING',
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  markReady(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    artifactRef: string;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    return this.store.transitionState({
      ...input,
      nextState: 'READY',
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  markFailed(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    error: string;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    return this.store.transitionState({
      canonicalSourceId: input.canonicalSourceId,
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      nextState: 'FAILED',
      lastError: input.error,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  renewLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    return this.store.renewLease({
      canonicalSourceId: input.canonicalSourceId,
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  releaseLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nowMs?: number;
  }): Promise<boolean> {
    return this.store.releaseLease({
      canonicalSourceId: input.canonicalSourceId,
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  getState(canonicalSourceId: CanonicalSourceId): Promise<IngestionCoordinationRecord | null> {
    return this.store.get(canonicalSourceId);
  }
}
