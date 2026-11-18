import crypto from 'node:crypto';
import {
  CacheableSourceIdSchema,
  type CacheableSourceId,
  type CanonicalSourceId,
  type SharedIngestionState,
} from '@autoedit/contracts';
import { MediaSourceError } from './errors.js';

function shortHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Layer A: Source acquisition / segmentation work identity scoped by immutable source + revision.
 */
export function buildSourceWorkId(
  canonicalSourceId: CanonicalSourceId,
  sourceRevision = 'v1',
): CacheableSourceId {
  const base = assertCacheableCanonicalId(canonicalSourceId);
  const safeRev = sourceRevision.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${base}::src::${safeRev}` as CacheableSourceId;
}

/**
 * Layer B: Source analysis work identity scoped by source + revision + algorithm & detection options.
 */
export function buildAnalysisWorkId(
  canonicalSourceId: CanonicalSourceId,
  params: {
    sourceRevision: string;
    algorithmVersion: string;
    scoreThreshold: number;
    cooldownSec: number;
    bufferConfig?: unknown;
  },
): CacheableSourceId {
  const base = assertCacheableCanonicalId(canonicalSourceId);
  return `${base}::ana::${shortHash(params)}` as CacheableSourceId;
}

/**
 * Layer C: Derived base clip work identity scoped by source + revision + window + render settings.
 */
export function buildClipWorkId(
  canonicalSourceId: CanonicalSourceId,
  cacheKey: string,
): CacheableSourceId {
  const base = assertCacheableCanonicalId(canonicalSourceId);
  return `${base}::clip::${cacheKey.slice(0, 24)}` as CacheableSourceId;
}

/**
 * Compact, fixed-size O(1) work-ownership record.
 * Deliberately excludes per-user subscriber lists so high fan-in (e.g. 1,000+ clippers)
 * never bloats Redis lock payloads; subscriber notifications belong outside the lock.
 */
export interface IngestionCoordinationRecord {
  canonicalSourceId: CacheableSourceId;
  state: SharedIngestionState;
  ownerWorkerId: string | null;
  fencingToken: number;
  attempts: number;
  maxRetries: number;
  leaseExpiresAtMs: number;
  updatedAtMs: number;
  attachedCount: number;
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

export interface InvalidateReadyResult {
  action: 'ACQUIRED_REPAIR' | 'CONFLICT_ALREADY_RECOVERING';
  fencingToken: number;
  record: IngestionCoordinationRecord | null;
}

export interface CoordinationStore {
  get(canonicalSourceId: CacheableSourceId): Promise<IngestionCoordinationRecord | null>;
  requestIngestion(input: {
    canonicalSourceId: CacheableSourceId;
    requesterId: string;
    workerId: string;
    leaseMs: number;
    maxRetries: number;
    nowMs: number;
  }): Promise<RequestIngestionResult>;
  transitionState(input: {
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    nextState: SharedIngestionState;
    leaseMs?: number;
    artifactRef?: string;
    lastError?: string;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord>;
  renewLease(input: {
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs: number;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord>;
  releaseLease(input: {
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    nowMs: number;
  }): Promise<boolean>;
  invalidateReadyArtifact(input: {
    canonicalSourceId: CacheableSourceId;
    expectedArtifactRef: string;
    expectedFencingToken: number;
    repairWorkerId: string;
    leaseMs: number;
    maxRetries: number;
    nowMs: number;
  }): Promise<InvalidateReadyResult>;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

const ALLOWED_TRANSITIONS: Record<SharedIngestionState, ReadonlySet<SharedIngestionState>> = {
  PENDING: new Set(),
  ACQUIRING: new Set(['INGESTING', 'READY', 'FAILED']),
  INGESTING: new Set(['READY', 'FAILED']),
  READY: new Set(), // Terminal immutable state
  FAILED: new Set(), // Must re-enter via requestIngestion recovery
  EXPIRED: new Set(), // Must re-enter via requestIngestion recovery
};

function assertCacheableCanonicalId(canonicalSourceId: string): CacheableSourceId {
  const parsed = CacheableSourceIdSchema.safeParse(canonicalSourceId);
  if (!parsed.success) {
    throw new MediaSourceError({
      code: 'BROADCAST_UNRESOLVED',
      message: `Cannot coordinate ingestion for "${canonicalSourceId}": an immutable broadcast, VOD, or upload identity is required (channel-only IDs are rejected).`,
      retryable: true,
    });
  }
  return parsed.data;
}

function assertValidTransition(
  currentState: SharedIngestionState,
  nextState: SharedIngestionState,
  artifactRef?: string,
): void {
  const allowed = ALLOWED_TRANSITIONS[currentState];
  if (!allowed || !allowed.has(nextState)) {
    throw new MediaSourceError({
      code: 'INVALID_STATE_TRANSITION',
      message: `Invalid ingestion state transition from "${currentState}" to "${nextState}".`,
    });
  }
  if (nextState === 'READY' && (!artifactRef || !artifactRef.trim())) {
    throw new MediaSourceError({
      code: 'INVALID_STATE_TRANSITION',
      message: 'Transitioning ingestion to READY requires a non-empty artifactRef.',
    });
  }
}

/**
 * Deterministic in-memory coordination store implementing the exact same
 * lease, fencing-token, transition-validation, retry, and recovery semantics
 * as the Redis Lua store.
 */
export class InMemoryCoordinationStore implements CoordinationStore {
  private readonly records = new Map<CacheableSourceId, IngestionCoordinationRecord>();

  async get(canonicalSourceId: CacheableSourceId): Promise<IngestionCoordinationRecord | null> {
    const rec = this.records.get(canonicalSourceId);
    return rec ? { ...rec } : null;
  }

  async requestIngestion(input: {
    canonicalSourceId: CacheableSourceId;
    requesterId: string;
    workerId: string;
    leaseMs: number;
    maxRetries: number;
    nowMs: number;
  }): Promise<RequestIngestionResult> {
    const existing = this.records.get(input.canonicalSourceId);

    // Case 1: READY with valid non-empty artifactRef -> reuse immediately
    if (existing && existing.state === 'READY' && existing.artifactRef && existing.artifactRef.trim()) {
      const updated: IngestionCoordinationRecord = {
        ...existing,
        attachedCount: existing.attachedCount + 1,
        updatedAtMs: input.nowMs,
      };
      this.records.set(input.canonicalSourceId, updated);
      return {
        action: 'REUSE_READY',
        deduplicated: true,
        fencingToken: updated.fencingToken,
        record: { ...updated },
      };
    }

    // Case 2: Active unexpired lease held by a live worker -> attach without duplicate work
    if (
      existing &&
      (existing.state === 'ACQUIRING' || existing.state === 'INGESTING') &&
      existing.leaseExpiresAtMs > input.nowMs
    ) {
      const updated: IngestionCoordinationRecord = {
        ...existing,
        attachedCount: existing.attachedCount + 1,
        updatedAtMs: input.nowMs,
      };
      this.records.set(input.canonicalSourceId, updated);
      return {
        action: 'ATTACH_EXISTING',
        deduplicated: true,
        fencingToken: updated.fencingToken,
        record: { ...updated },
      };
    }

    // Case 3: Lease expired (worker crashed) or previous attempt FAILED/EXPIRED -> bounded recovery
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
          attachedCount: existing.attachedCount + 1,
          lastError: existing.lastError ?? 'Maximum ingestion retry attempts exceeded.',
        };
        this.records.set(input.canonicalSourceId, exhausted);
        return {
          action: 'FAILED_MAX_RETRIES',
          deduplicated: true,
          fencingToken: exhausted.fencingToken,
          record: { ...exhausted },
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
        attachedCount: existing.attachedCount + 1,
      };
      this.records.set(input.canonicalSourceId, recovered);
      return {
        action: 'ACQUIRED_RECOVERY',
        deduplicated: false,
        fencingToken: recovered.fencingToken,
        record: { ...recovered },
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
      attachedCount: 1,
    };
    this.records.set(input.canonicalSourceId, created);
    return {
      action: 'ACQUIRED_NEW',
      deduplicated: false,
      fencingToken: created.fencingToken,
      record: { ...created },
    };
  }

  async transitionState(input: {
    canonicalSourceId: CacheableSourceId;
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
    if (existing.state === 'READY') {
      throw new MediaSourceError({
        code: 'INVALID_STATE_TRANSITION',
        message: `Cannot modify READY ingestion record for ${input.canonicalSourceId}.`,
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

    assertValidTransition(existing.state, input.nextState, input.artifactRef);

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
      artifactRef: input.nextState === 'READY' ? input.artifactRef : existing.artifactRef,
      lastError: input.lastError ?? existing.lastError,
      updatedAtMs: input.nowMs,
    };
    this.records.set(input.canonicalSourceId, updated);
    return { ...updated };
  }

  async renewLease(input: {
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs: number;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord> {
    const existing = this.records.get(input.canonicalSourceId);
    if (!existing || existing.state === 'READY') {
      throw new MediaSourceError({
        code: 'LEASE_EXPIRED',
        message: `Cannot renew lease: no active mutable lease for ${input.canonicalSourceId}.`,
      });
    }
    if (existing.ownerWorkerId !== input.workerId || existing.fencingToken !== input.fencingToken) {
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
    return { ...updated };
  }

  async releaseLease(input: {
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    nowMs: number;
  }): Promise<boolean> {
    const existing = this.records.get(input.canonicalSourceId);
    if (
      !existing ||
      existing.state === 'READY' ||
      existing.ownerWorkerId !== input.workerId ||
      existing.fencingToken !== input.fencingToken
    ) {
      return false;
    }
    const updated: IngestionCoordinationRecord = {
      ...existing,
      state: 'EXPIRED',
      ownerWorkerId: null,
      leaseExpiresAtMs: 0,
      updatedAtMs: input.nowMs,
    };
    this.records.set(input.canonicalSourceId, updated);
    return true;
  }

  async invalidateReadyArtifact(input: {
    canonicalSourceId: CacheableSourceId;
    expectedArtifactRef: string;
    expectedFencingToken: number;
    repairWorkerId: string;
    leaseMs: number;
    maxRetries: number;
    nowMs: number;
  }): Promise<InvalidateReadyResult> {
    const existing = this.records.get(input.canonicalSourceId);
    if (
      !existing ||
      existing.state !== 'READY' ||
      existing.artifactRef !== input.expectedArtifactRef ||
      existing.fencingToken !== input.expectedFencingToken
    ) {
      return {
        action: 'CONFLICT_ALREADY_RECOVERING',
        fencingToken: existing?.fencingToken ?? 0,
        record: existing ? { ...existing } : null,
      };
    }

    const nextToken = existing.fencingToken + 1;
    const repaired: IngestionCoordinationRecord = {
      ...existing,
      state: 'ACQUIRING',
      ownerWorkerId: input.repairWorkerId,
      fencingToken: nextToken,
      attempts: 1,
      maxRetries: input.maxRetries,
      leaseExpiresAtMs: input.nowMs + input.leaseMs,
      updatedAtMs: input.nowMs,
      artifactRef: undefined,
      lastError: `Invalidated missing/corrupt artifact (prev token ${input.expectedFencingToken})`,
    };
    this.records.set(input.canonicalSourceId, repaired);
    return {
      action: 'ACQUIRED_REPAIR',
      fencingToken: nextToken,
      record: { ...repaired },
    };
  }

  clear(): void {
    this.records.clear();
  }
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Explicit positional ARGV contract for REQUEST_INGESTION_LUA:
 *   KEYS[1] = coordination Redis key
 *   ARGV[1] = canonicalId (string)
 *   ARGV[2] = workerId (string)
 *   ARGV[3] = leaseMs (positive integer)
 *   ARGV[4] = maxRetries (positive integer)
 *   ARGV[5] = nowMs (non-negative integer)
 *   ARGV[6] = recordTtlMs (positive integer)
 *
 * Note: requesterId is deliberately excluded from the O(1) ownership lock record
 * and must not be added to ARGV without updating both Lua and this packer together.
 */
export function buildRequestIngestionLuaArgs(params: {
  canonicalSourceId: CacheableSourceId;
  workerId: string;
  leaseMs: number;
  maxRetries: number;
  nowMs: number;
  recordTtlMs: number;
}): [string, string, number, number, number, number] {
  if (!params.workerId || !params.workerId.trim()) {
    throw new MediaSourceError({
      code: 'COORDINATION_CONFLICT',
      message: 'workerId must be a non-empty string.',
    });
  }
  if (!Number.isFinite(params.leaseMs) || params.leaseMs <= 0) {
    throw new MediaSourceError({ code: 'COORDINATION_CONFLICT', message: 'leaseMs must be > 0.' });
  }
  if (!Number.isFinite(params.maxRetries) || params.maxRetries < 1) {
    throw new MediaSourceError({ code: 'COORDINATION_CONFLICT', message: 'maxRetries must be >= 1.' });
  }
  if (!Number.isFinite(params.nowMs) || params.nowMs < 0) {
    throw new MediaSourceError({ code: 'COORDINATION_CONFLICT', message: 'nowMs must be >= 0.' });
  }
  if (!Number.isFinite(params.recordTtlMs) || params.recordTtlMs <= 0) {
    throw new MediaSourceError({ code: 'COORDINATION_CONFLICT', message: 'recordTtlMs must be > 0.' });
  }
  return [
    params.canonicalSourceId,
    params.workerId,
    Math.trunc(params.leaseMs),
    Math.trunc(params.maxRetries),
    Math.trunc(params.nowMs),
    Math.trunc(params.recordTtlMs),
  ];
}

/**
 * Explicit positional ARGV contract for MUTATE_LEASE_LUA:
 *   KEYS[1] = coordination Redis key
 *   ARGV[1] = mode ('transition' | 'renew' | 'release')
 *   ARGV[2] = workerId (string)
 *   ARGV[3] = fencingToken (positive integer)
 *   ARGV[4] = nextState (string, '' when unused)
 *   ARGV[5] = leaseMs (non-negative integer)
 *   ARGV[6] = artifactRef (string, '' when unused)
 *   ARGV[7] = lastError (string, '' when unused)
 *   ARGV[8] = nowMs (non-negative integer)
 *   ARGV[9] = recordTtlMs (positive integer)
 */
export function buildMutateLeaseLuaArgs(params: {
  mode: 'transition' | 'renew' | 'release';
  workerId: string;
  fencingToken: number;
  nextState: string;
  leaseMs: number;
  artifactRef: string;
  lastError: string;
  nowMs: number;
  recordTtlMs: number;
}): [string, string, number, string, number, string, string, number, number] {
  return [
    params.mode,
    params.workerId,
    Math.trunc(params.fencingToken),
    params.nextState,
    Math.trunc(params.leaseMs),
    params.artifactRef,
    params.lastError,
    Math.trunc(params.nowMs),
    Math.trunc(params.recordTtlMs),
  ];
}

const REQUEST_INGESTION_LUA = `
local key = KEYS[1]
local canonicalId = ARGV[1]
local workerId = ARGV[2]
local leaseMs = tonumber(ARGV[3])
local maxRetries = tonumber(ARGV[4])
local nowMs = tonumber(ARGV[5])
local recordTtlMs = tonumber(ARGV[6])

assert(canonicalId and canonicalId ~= '', 'ARGV[1] canonicalId required')
assert(workerId and workerId ~= '', 'ARGV[2] workerId required')
assert(leaseMs and leaseMs > 0, 'ARGV[3] leaseMs must be positive number')
assert(maxRetries and maxRetries >= 1, 'ARGV[4] maxRetries must be >= 1')
assert(nowMs and nowMs >= 0, 'ARGV[5] nowMs must be >= 0')
assert(recordTtlMs and recordTtlMs > 0, 'ARGV[6] recordTtlMs must be positive number')

local raw = redis.call('GET', key)
local rec = nil
if raw then
  rec = cjson.decode(raw)
end

if rec and rec.state == 'READY' and rec.artifactRef and rec.artifactRef ~= '' then
  rec.attachedCount = (rec.attachedCount or 0) + 1
  rec.updatedAtMs = nowMs
  redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
  return cjson.encode({ action = 'REUSE_READY', deduplicated = true, fencingToken = rec.fencingToken, record = rec })
end

if rec and (rec.state == 'ACQUIRING' or rec.state == 'INGESTING') and rec.leaseExpiresAtMs > nowMs then
  rec.attachedCount = (rec.attachedCount or 0) + 1
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
    rec.attachedCount = (rec.attachedCount or 0) + 1
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
  rec.attachedCount = (rec.attachedCount or 0) + 1
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
  attachedCount = 1
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

assert(mode == 'transition' or mode == 'renew' or mode == 'release', 'ARGV[1] invalid mode')
assert(workerId and workerId ~= '', 'ARGV[2] workerId required')
assert(token and token >= 1, 'ARGV[3] fencingToken must be >= 1')
assert(leaseMs and leaseMs >= 0, 'ARGV[5] leaseMs must be >= 0')
assert(nowMs and nowMs >= 0, 'ARGV[8] nowMs must be >= 0')
assert(recordTtlMs and recordTtlMs > 0, 'ARGV[9] recordTtlMs must be > 0')

local raw = redis.call('GET', key)
if not raw then
  return cjson.encode({ error = 'COORDINATION_CONFLICT' })
end
local rec = cjson.decode(raw)
if rec.state == 'READY' then
  return cjson.encode({ error = 'INVALID_STATE_TRANSITION' })
end
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
  rec.state = 'EXPIRED'
  rec.ownerWorkerId = cjson.null
  rec.leaseExpiresAtMs = 0
  rec.updatedAtMs = nowMs
else
  local valid = false
  if rec.state == 'ACQUIRING' and (nextState == 'INGESTING' or nextState == 'READY' or nextState == 'FAILED') then
    valid = true
  elseif rec.state == 'INGESTING' and (nextState == 'READY' or nextState == 'FAILED') then
    valid = true
  end
  if not valid then
    return cjson.encode({ error = 'INVALID_STATE_TRANSITION' })
  end
  if nextState == 'READY' and artifactRef == '' then
    return cjson.encode({ error = 'INVALID_STATE_TRANSITION' })
  end

  local isTerminal = (nextState == 'READY' or nextState == 'FAILED' or nextState == 'EXPIRED')
  rec.state = nextState
  if isTerminal then
    rec.ownerWorkerId = cjson.null
    rec.leaseExpiresAtMs = 0
  elseif leaseMs > 0 then
    rec.leaseExpiresAtMs = nowMs + leaseMs
  end
  if nextState == 'READY' and artifactRef ~= '' then rec.artifactRef = artifactRef end
  if lastError ~= '' then rec.lastError = lastError end
  rec.updatedAtMs = nowMs
end

redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
return cjson.encode({ ok = true, record = rec })
`;

/**
 * Explicit positional ARGV contract for INVALIDATE_READY_LUA:
 *   KEYS[1] = coordination Redis key
 *   ARGV[1] = expectedArtifactRef (string)
 *   ARGV[2] = expectedFencingToken (positive integer)
 *   ARGV[3] = repairWorkerId (string)
 *   ARGV[4] = leaseMs (positive integer)
 *   ARGV[5] = maxRetries (positive integer)
 *   ARGV[6] = nowMs (non-negative integer)
 *   ARGV[7] = recordTtlMs (positive integer)
 */
export function buildInvalidateReadyLuaArgs(params: {
  expectedArtifactRef: string;
  expectedFencingToken: number;
  repairWorkerId: string;
  leaseMs: number;
  maxRetries: number;
  nowMs: number;
  recordTtlMs: number;
}): [string, number, string, number, number, number, number] {
  return [
    params.expectedArtifactRef,
    Math.trunc(params.expectedFencingToken),
    params.repairWorkerId,
    Math.trunc(params.leaseMs),
    Math.trunc(params.maxRetries),
    Math.trunc(params.nowMs),
    Math.trunc(params.recordTtlMs),
  ];
}

const INVALIDATE_READY_LUA = `
local key = KEYS[1]
local expectedArtifactRef = ARGV[1]
local expectedToken = tonumber(ARGV[2])
local repairWorkerId = ARGV[3]
local leaseMs = tonumber(ARGV[4])
local maxRetries = tonumber(ARGV[5])
local nowMs = tonumber(ARGV[6])
local recordTtlMs = tonumber(ARGV[7])

assert(expectedArtifactRef and expectedArtifactRef ~= '', 'ARGV[1] expectedArtifactRef required')
assert(expectedToken and expectedToken >= 1, 'ARGV[2] expectedToken >= 1')
assert(repairWorkerId and repairWorkerId ~= '', 'ARGV[3] repairWorkerId required')
assert(leaseMs and leaseMs > 0, 'ARGV[4] leaseMs > 0')
assert(maxRetries and maxRetries >= 1, 'ARGV[5] maxRetries >= 1')
assert(nowMs and nowMs >= 0, 'ARGV[6] nowMs >= 0')
assert(recordTtlMs and recordTtlMs > 0, 'ARGV[7] recordTtlMs > 0')

local raw = redis.call('GET', key)
if not raw then
  return cjson.encode({ action = 'CONFLICT_ALREADY_RECOVERING', fencingToken = 0, record = cjson.null })
end
local rec = cjson.decode(raw)
if rec.state ~= 'READY' or rec.artifactRef ~= expectedArtifactRef or rec.fencingToken ~= expectedToken then
  return cjson.encode({ action = 'CONFLICT_ALREADY_RECOVERING', fencingToken = rec.fencingToken or 0, record = rec })
end

local nextToken = (rec.fencingToken or 0) + 1
rec.state = 'ACQUIRING'
rec.ownerWorkerId = repairWorkerId
rec.fencingToken = nextToken
rec.attempts = 1
rec.maxRetries = maxRetries
rec.leaseExpiresAtMs = nowMs + leaseMs
rec.updatedAtMs = nowMs
rec.artifactRef = nil
rec.lastError = 'Invalidated missing/corrupt artifact (prev token ' .. tostring(expectedToken) .. ')'

redis.call('SET', key, cjson.encode(rec), 'PX', recordTtlMs)
return cjson.encode({ action = 'ACQUIRED_REPAIR', fencingToken = nextToken, record = rec })
`;

/**
 * Redis-backed atomic coordination store using single-key Lua scripts.
 *
 * Durability / TTL caveat:
 * Redis coordination records expire after `recordTtlMs` (independent of durable
 * object-storage artifact retention) and may be lost on Redis restart or eviction.
 * Therefore this primitive provides at-least-once coordination with monotonic fencing
 * while the Redis key is resident — NOT distributed exactly-once across Redis data loss.
 * Workers must check durable storage/DB before re-acquiring after a Redis key expiry.
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

  private key(canonicalSourceId: CacheableSourceId): string {
    return `${this.keyPrefix}${canonicalSourceId}`;
  }

  async get(canonicalSourceId: CacheableSourceId): Promise<IngestionCoordinationRecord | null> {
    const raw = await this.redis.get(this.key(canonicalSourceId));
    if (!raw) return null;
    return JSON.parse(raw) as IngestionCoordinationRecord;
  }

  async requestIngestion(input: {
    canonicalSourceId: CacheableSourceId;
    requesterId: string;
    workerId: string;
    leaseMs: number;
    maxRetries: number;
    nowMs: number;
  }): Promise<RequestIngestionResult> {
    const args = buildRequestIngestionLuaArgs({
      canonicalSourceId: input.canonicalSourceId,
      workerId: input.workerId,
      leaseMs: input.leaseMs,
      maxRetries: input.maxRetries,
      nowMs: input.nowMs,
      recordTtlMs: this.recordTtlMs,
    });
    const raw = (await this.redis.eval(
      REQUEST_INGESTION_LUA,
      1,
      this.key(input.canonicalSourceId),
      ...args,
    )) as string;
    return JSON.parse(raw) as RequestIngestionResult;
  }

  async transitionState(input: {
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    nextState: SharedIngestionState;
    leaseMs?: number;
    artifactRef?: string;
    lastError?: string;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord> {
    const args = buildMutateLeaseLuaArgs({
      mode: 'transition',
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      nextState: input.nextState,
      leaseMs: input.leaseMs ?? 0,
      artifactRef: input.artifactRef ?? '',
      lastError: input.lastError ?? '',
      nowMs: input.nowMs,
      recordTtlMs: this.recordTtlMs,
    });
    const raw = (await this.redis.eval(
      MUTATE_LEASE_LUA,
      1,
      this.key(input.canonicalSourceId),
      ...args,
    )) as string;
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; record?: IngestionCoordinationRecord };
    if (parsed.error === 'COORDINATION_CONFLICT') {
      throw new MediaSourceError({
        code: 'COORDINATION_CONFLICT',
        message: `No active ingestion record for ${input.canonicalSourceId}.`,
      });
    }
    if (parsed.error === 'INVALID_STATE_TRANSITION') {
      throw new MediaSourceError({
        code: 'INVALID_STATE_TRANSITION',
        message: `Invalid state transition to "${input.nextState}" for ${input.canonicalSourceId}.`,
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
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs: number;
    nowMs: number;
  }): Promise<IngestionCoordinationRecord> {
    const args = buildMutateLeaseLuaArgs({
      mode: 'renew',
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      nextState: '',
      leaseMs: input.leaseMs,
      artifactRef: '',
      lastError: '',
      nowMs: input.nowMs,
      recordTtlMs: this.recordTtlMs,
    });
    const raw = (await this.redis.eval(
      MUTATE_LEASE_LUA,
      1,
      this.key(input.canonicalSourceId),
      ...args,
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
    canonicalSourceId: CacheableSourceId;
    workerId: string;
    fencingToken: number;
    nowMs: number;
  }): Promise<boolean> {
    const args = buildMutateLeaseLuaArgs({
      mode: 'release',
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      nextState: '',
      leaseMs: 0,
      artifactRef: '',
      lastError: '',
      nowMs: input.nowMs,
      recordTtlMs: this.recordTtlMs,
    });
    const raw = (await this.redis.eval(
      MUTATE_LEASE_LUA,
      1,
      this.key(input.canonicalSourceId),
      ...args,
    )) as string;
    const parsed = JSON.parse(raw) as { ok?: boolean };
    return Boolean(parsed.ok);
  }

  async invalidateReadyArtifact(input: {
    canonicalSourceId: CacheableSourceId;
    expectedArtifactRef: string;
    expectedFencingToken: number;
    repairWorkerId: string;
    leaseMs: number;
    maxRetries: number;
    nowMs: number;
  }): Promise<InvalidateReadyResult> {
    const args = buildInvalidateReadyLuaArgs({
      expectedArtifactRef: input.expectedArtifactRef,
      expectedFencingToken: input.expectedFencingToken,
      repairWorkerId: input.repairWorkerId,
      leaseMs: input.leaseMs,
      maxRetries: input.maxRetries,
      nowMs: input.nowMs,
      recordTtlMs: this.recordTtlMs,
    });
    const raw = (await this.redis.eval(
      INVALIDATE_READY_LUA,
      1,
      this.key(input.canonicalSourceId),
      ...args,
    )) as string;
    return JSON.parse(raw) as InvalidateReadyResult;
  }
}

/**
 * Shared Ingestion Coordinator
 * Guarantees at most one active lease per immutable canonical source identity
 * while the coordination record exists, using TTL leases and monotonic fencing tokens.
 */
export class SharedIngestionCoordinator {
  constructor(private readonly store: CoordinationStore) { }

  async requestIngestion(input: RequestIngestionInput): Promise<RequestIngestionResult> {
    const canonicalSourceId = assertCacheableCanonicalId(input.canonicalSourceId);
    return this.store.requestIngestion({
      canonicalSourceId,
      requesterId: input.requesterId,
      workerId: input.workerId,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async markIngesting(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    const canonicalSourceId = assertCacheableCanonicalId(input.canonicalSourceId);
    return this.store.transitionState({
      ...input,
      canonicalSourceId,
      nextState: 'INGESTING',
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async markReady(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    artifactRef: string;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    const canonicalSourceId = assertCacheableCanonicalId(input.canonicalSourceId);
    return this.store.transitionState({
      ...input,
      canonicalSourceId,
      nextState: 'READY',
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async markFailed(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    error: string;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    const canonicalSourceId = assertCacheableCanonicalId(input.canonicalSourceId);
    return this.store.transitionState({
      canonicalSourceId,
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      nextState: 'FAILED',
      lastError: input.error,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async renewLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestionCoordinationRecord> {
    const canonicalSourceId = assertCacheableCanonicalId(input.canonicalSourceId);
    return this.store.renewLease({
      canonicalSourceId,
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async releaseLease(input: {
    canonicalSourceId: CanonicalSourceId;
    workerId: string;
    fencingToken: number;
    nowMs?: number;
  }): Promise<boolean> {
    const canonicalSourceId = assertCacheableCanonicalId(input.canonicalSourceId);
    return this.store.releaseLease({
      canonicalSourceId,
      workerId: input.workerId,
      fencingToken: input.fencingToken,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async invalidateReadyArtifact(input: {
    canonicalSourceId: CanonicalSourceId;
    expectedArtifactRef: string;
    expectedFencingToken: number;
    repairWorkerId: string;
    leaseMs?: number;
    maxRetries?: number;
    nowMs?: number;
  }): Promise<InvalidateReadyResult> {
    const canonicalSourceId = assertCacheableCanonicalId(input.canonicalSourceId);
    return this.store.invalidateReadyArtifact({
      canonicalSourceId,
      expectedArtifactRef: input.expectedArtifactRef,
      expectedFencingToken: input.expectedFencingToken,
      repairWorkerId: input.repairWorkerId,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      nowMs: input.nowMs ?? Date.now(),
    });
  }

  async getState(canonicalSourceId: CanonicalSourceId): Promise<IngestionCoordinationRecord | null> {
    const validId = assertCacheableCanonicalId(canonicalSourceId);
    return this.store.get(validId);
  }
}
