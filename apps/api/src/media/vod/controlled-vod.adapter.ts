import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MediaSourceProvider } from '@autoedit/contracts';
import type { RedisLikeClient } from '../ingestion-coordinator.js';
import type { RegisterMediaSourceInput } from '../durable-media-registry.js';
import { MediaSourceError } from '../errors.js';
import {
  probeAndValidateClipMp4,
  type ProbedClipMetadata,
} from '../live/highlight-clip-extractor.js';

export type ControlledVodArchetype =
  | 'youtube_video'
  | 'youtube_completed_live_vod'
  | 'twitch_vod'
  | 'kick_vod'
  | 'direct_media_recording'
  | 'private_user_upload';

export interface ControlledVodAdapterConfig {
  /** Must be explicitly true; disabled by default so test local adapters never run accidentally. */
  enabled: boolean;
  archetype: ControlledVodArchetype;
  /** Immutable external VOD or upload ID (e.g. 'dQw4w9WgXcQ', '219837465', 'asset_01'). */
  vodId: string;
  /** Optional channel name for Twitch/Kick/YouTube VODs. */
  channelName?: string;
  /** Optional link to an already-registered live MediaSource ID (for completed livestream VODs). */
  associatedLiveSourceId?: string;
  /** Source revision tag (e.g. 'v1', 'v2'). */
  sourceRevision?: string;
  /** Required when archetype === 'private_user_upload'. */
  ownerUserId?: string;
  /** Path to authorized local fixture MP4 file. */
  fixturePath: string;
  title?: string;
}

export interface VodResourcePolicy {
  /** Maximum imported VOD duration in seconds; defaults to 3600s (60 min for initial 100 free users). */
  maxVodDurationSec: number;
  /** Maximum accepted source file size in bytes; defaults to 500 MiB. */
  maxSourceFileBytes: number;
  /** Maximum concurrent CPU-heavy FFmpeg/Whisper jobs per worker; defaults to 2. */
  maxConcurrentCpuJobs: number;
  /** Per-user concurrent uncached CPU job fairness cap; defaults to 1. */
  perUserMaxConcurrentJobs: number;
  /** Maximum new uncached clip generations per user per day; defaults to 20. */
  maxClipsPerUserPerDay: number;
  /** Worker FFmpeg/import timeout in ms; defaults to 120_000. */
  workerTimeoutMs: number;
  /** Default shared artifact cache retention TTL in ms; defaults to 7 days. */
  cacheRetentionMs: number;
}

export const DEFAULT_FREE_BETA_VOD_POLICY: VodResourcePolicy = {
  maxVodDurationSec: 3600,
  maxSourceFileBytes: 500 * 1024 * 1024,
  maxConcurrentCpuJobs: 2,
  perUserMaxConcurrentJobs: 1,
  maxClipsPerUserPerDay: 20,
  workerTimeoutMs: 120_000,
  cacheRetentionMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Enforces practical free-beta resource limits (CPU concurrency semaphore, per-user
 * queue fairness, daily per-user clip quota, duration/file-size ceilings) using only
 * local memory and optional Redis—no paid billing or Kubernetes required.
 */
export class VodResourceGuard {
  readonly policy: VodResourcePolicy;
  private activeCpuJobs = 0;
  private readonly activeByUser = new Map<string, number>();
  private readonly waitQueue: Array<() => void> = [];
  private readonly localDailyQuota = new Map<string, number>();

  constructor(
    policy?: Partial<VodResourcePolicy>,
    private readonly redis?: RedisLikeClient,
    private readonly quotaPrefix = 'autoedit:quota:vod:',
  ) {
    this.policy = { ...DEFAULT_FREE_BETA_VOD_POLICY, ...(policy ?? {}) };
  }

  getActiveCpuJobs(): number {
    return this.activeCpuJobs;
  }

  /** Checks source file size and probed duration against configured hard limits. */
  assertMediaBounds(meta: { sizeBytes: number; durationSec: number }): void {
    if (meta.sizeBytes <= 0) {
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        message: 'VOD source file is empty (0 bytes).',
      });
    }
    if (meta.sizeBytes > this.policy.maxSourceFileBytes) {
      throw new MediaSourceError({
        code: 'UNSUPPORTED_ACQUISITION',
        message: `VOD file size (${meta.sizeBytes} bytes) exceeds limit (${this.policy.maxSourceFileBytes} bytes).`,
      });
    }
    if (meta.durationSec > this.policy.maxVodDurationSec) {
      throw new MediaSourceError({
        code: 'UNSUPPORTED_ACQUISITION',
        message: `VOD duration (${meta.durationSec.toFixed(1)}s) exceeds limit (${this.policy.maxVodDurationSec}s).`,
      });
    }
  }

  /**
   * Checks and increments per-user daily clip generation quota (applied only to new
   * uncached clip renders, never blocking popular cached clip reuse!).
   */
  async consumeDailyClipQuota(userId: string, now = new Date()): Promise<{ used: number; limit: number }> {
    const dayKey = now.toISOString().slice(0, 10);
    const fullKey = `${this.quotaPrefix}clips:${userId}:${dayKey}`;
    const limit = this.policy.maxClipsPerUserPerDay;

    if (this.redis) {
      const currentRaw = await this.redis.get(fullKey);
      const current = currentRaw ? Number(currentRaw) : 0;
      if (current >= limit) {
        throw new MediaSourceError({
          code: 'ACCESS_DENIED',
          message: `Daily free-tier clip generation limit reached (${limit}/day for user ${userId}).`,
        });
      }
      const next = current + 1;
      await this.redis.eval(
        `local v = redis.call('INCR', KEYS[1]); if v == 1 then redis.call('EXPIRE', KEYS[1], 86400) end; return v`,
        1,
        fullKey,
      );
      return { used: next, limit };
    }

    const current = this.localDailyQuota.get(fullKey) ?? 0;
    if (current >= limit) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: `Daily free-tier clip generation limit reached (${limit}/day for user ${userId}).`,
      });
    }
    this.localDailyQuota.set(fullKey, current + 1);
    return { used: current + 1, limit };
  }

  /**
   * Acquires a bounded CPU execution slot respecting both global `maxConcurrentCpuJobs`
   * and per-user fairness (`perUserMaxConcurrentJobs`).
   */
  async withCpuSlot<T>(userId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (
      this.activeCpuJobs >= this.policy.maxConcurrentCpuJobs ||
      (this.activeByUser.get(userId) ?? 0) >= this.policy.perUserMaxConcurrentJobs
    ) {
      if (signal?.aborted) {
        throw new MediaSourceError({
          code: 'REQUEST_CANCELLED',
          message: 'Cancelled while waiting for CPU job slot.',
        });
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const idx = this.waitQueue.indexOf(wake);
          if (idx >= 0) this.waitQueue.splice(idx, 1);
          reject(
            new MediaSourceError({
              code: 'REQUEST_CANCELLED',
              message: 'Cancelled while waiting for CPU job slot.',
            }),
          );
        };
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waitQueue.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    this.activeCpuJobs++;
    this.activeByUser.set(userId, (this.activeByUser.get(userId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      this.activeCpuJobs--;
      const nextUserCount = (this.activeByUser.get(userId) ?? 1) - 1;
      if (nextUserCount <= 0) this.activeByUser.delete(userId);
      else this.activeByUser.set(userId, nextUserCount);
      // Wake all waiters so fairness re-evaluates cleanly for another waiting user
      const waiters = this.waitQueue.splice(0, this.waitQueue.length);
      for (const wake of waiters) wake();
    }
  }
}

export interface AcquiredVodPayload {
  bytes: Buffer;
  probed: ProbedClipMetadata;
  mediaFingerprint: string;
}

/**
 * Opt-in controlled VOD acquisition adapter representing all universal backend VOD
 * capabilities (YouTube video, YouTube completed livestream VOD, Twitch VOD, Kick VOD,
 * authorized direct-media recording, and private user upload) using real local test media.
 *
 * SECURITY BOUNDARY:
 * - Never performs unauthorized downloads from YouTube, Twitch, or Kick.
 * - Never relaxes SSRF protections on external HTTP routes.
 * - Disabled unless explicitly opted in (`enabled: true`).
 */
export class ControlledVodAcquisitionAdapter {
  readonly config: ControlledVodAdapterConfig;
  readonly fixturePath: string;

  constructor(config: ControlledVodAdapterConfig) {
    if (!config.enabled) {
      throw new MediaSourceError({
        code: 'UNSUPPORTED_ACQUISITION',
        message: `ControlledVodAcquisitionAdapter is disabled for archetype "${config.archetype}". Real third-party downloading is not enabled in this milestone.`,
      });
    }
    if (!config.vodId?.trim()) {
      throw new MediaSourceError({
        code: 'MALFORMED_URL',
        message: 'Immutable vodId is required.',
      });
    }
    this.config = config;
    this.fixturePath = path.resolve(config.fixturePath);
  }

  /**
   * Builds a deterministic, server-authoritative RegisterMediaSourceInput matching our
   * universal canonical identity grammar across all 6 supported VOD/upload archetypes.
   */
  buildMediaSourceRegistration(): RegisterMediaSourceInput {
    const id = this.config.vodId.trim();
    const channel = this.config.channelName?.trim().toLowerCase();
    const rev = this.config.sourceRevision ?? 'v1';

    let provider: MediaSourceProvider;
    let canonicalId: string;
    let sourceType: 'vod' | 'uploaded' = 'vod';
    let identityScope: 'IMMUTABLE_VOD' | 'IMMUTABLE_UPLOAD' = 'IMMUTABLE_VOD';
    let channelId: string | undefined;
    let normalizedUrl: string | undefined;

    switch (this.config.archetype) {
      case 'youtube_video':
      case 'youtube_completed_live_vod':
        provider = 'youtube';
        canonicalId = `youtube:vod:${id}`;
        channelId = channel ? `youtube:channel:${channel}` : undefined;
        normalizedUrl = `https://www.youtube.com/watch?v=${id}`;
        break;
      case 'twitch_vod':
        provider = 'twitch';
        canonicalId = `twitch:vod:${id}`;
        channelId = channel ? `twitch:channel:${channel}` : undefined;
        normalizedUrl = `https://www.twitch.tv/videos/${id}`;
        break;
      case 'kick_vod':
        provider = 'kick';
        canonicalId = `kick:vod:${id}`;
        channelId = channel ? `kick:channel:${channel}` : undefined;
        normalizedUrl = channel
          ? `https://kick.com/${channel}/videos/${id}`
          : `https://kick.com/video/${id}`;
        break;
      case 'direct_media_recording':
        provider = 'direct_media';
        canonicalId = `direct_media:vod:${id}`;
        normalizedUrl = `https://media.example.com/recordings/${id}.mp4`;
        break;
      case 'private_user_upload':
        provider = 'upload';
        canonicalId = `upload:uploaded:${id}`;
        sourceType = 'uploaded';
        identityScope = 'IMMUTABLE_UPLOAD';
        break;
    }

    return {
      canonicalId,
      provider,
      sourceType,
      identityScope,
      externalId: id,
      channelId,
      vodId: sourceType === 'vod' ? id : undefined,
      associatedLiveSourceId: this.config.associatedLiveSourceId,
      sourceRevision: rev,
      normalizedUrl,
      availability: 'AVAILABLE',
      ownerUserId: this.config.ownerUserId,
      metadata: {
        archetype: this.config.archetype,
        title: this.config.title ?? `Controlled VOD (${this.config.archetype}/${id})`,
        channelName: channel,
        isLive: false,
      },
    };
  }

  /**
   * Acquires real media bytes from the authorized local fixture, probes & validates
   * codecs/duration/streams via ffprobe, checks resource bounds, and returns the
   * verified MP4 payload + SHA-256 media fingerprint.
   */
  async acquireAndValidate(guard?: VodResourceGuard): Promise<AcquiredVodPayload> {
    const stat = await fs.stat(this.fixturePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) {
      throw new MediaSourceError({
        code: 'SOURCE_UNAVAILABLE',
        message: `Controlled VOD media file is missing or empty at "${this.fixturePath}".`,
      });
    }

    if (guard) {
      guard.assertMediaBounds({ sizeBytes: stat.size, durationSec: 0 });
    }

    const probed = await probeAndValidateClipMp4(this.fixturePath, {
      requireAudio: true,
      encodingMode: 'stream-copy',
    });

    if (guard) {
      guard.assertMediaBounds({ sizeBytes: probed.sizeBytes, durationSec: probed.durationSec });
    }

    const bytes = await fs.readFile(this.fixturePath);
    return {
      bytes,
      probed: { ...probed, filePath: '(acquired-vod-source)' },
      mediaFingerprint: probed.sha256,
    };
  }
}
