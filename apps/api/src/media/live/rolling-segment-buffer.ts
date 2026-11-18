import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import type { RollingBufferConfig } from '@autoedit/contracts';
import { RollingMediaBufferTracker, type BufferWindow } from '../highlight-detector.js';
import { probe } from '../../ffmpeg/probe.js';

export interface BufferedMediaSegment {
  index: number;
  filePath: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  sizeBytes: number;
  sha256: string;
  valid: boolean;
  error?: string;
}

export interface RollingSegmentBufferOptions {
  workDir: string;
  bufferConfig?: Partial<RollingBufferConfig>;
  /** Maximum total disk usage for retained segments in bytes; defaults to 256 MiB. */
  maxDiskBytes?: number;
  /** Maximum stream duration accepted into buffer in seconds; defaults to 3600s. */
  maxStreamDurationSec?: number;
  /** Timeout for FFmpeg segmentation in ms; defaults to 60_000. */
  ffmpegTimeoutMs?: number;
}

function runFfmpegSegment(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('FFmpeg segmentation aborted before start'));
    }
    const bin = ffmpegPath || 'ffmpeg';
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(new Error('FFmpeg segmentation cancelled (lease lost or request aborted)'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`FFmpeg segmentation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`FFmpeg segmentation failed (code ${code}): ${stderr.trim().slice(-400)}`));
    });
  });
}

/**
 * Real FFmpeg-backed rolling segment buffer.
 *
 * Slices incoming media into deterministic ordered segments on local scratch disk,
 * verifies each segment with ffprobe, pins segments needed by active clip jobs,
 * evicts unpinned expired or over-quota segments, and cleans all scratch files on exit.
 */
export interface WindowReadinessStatus {
  windowStartSec: number;
  windowEndSec: number;
  preEventAvailable: boolean;
  postEventAvailable: boolean;
  hasCoveringSegments: boolean;
  hasMissingGap: boolean;
  canFinalize: boolean;
  pinnedSegmentIndices: number[];
  earliestBufferedSec: number;
  latestBufferedSec: number;
  streamEnded: boolean;
}

export interface IncomingSegmentInput {
  index: number;
  sourceFilePath: string;
  expectedStartSec: number;
  /** Copy incoming file into buffer workDir so producer cleanup cannot delete retained segments; defaults to true. */
  copyToWorkDir?: boolean;
}

export class FfmpegRollingSegmentBuffer {
  readonly tracker: RollingMediaBufferTracker;
  readonly workDir: string;
  readonly maxDiskBytes: number;
  readonly maxStreamDurationSec: number;
  private readonly ffmpegTimeoutMs: number;

  private readonly segments = new Map<number, BufferedMediaSegment>();
  private readonly pins = new Map<number, Set<string>>();
  private streamEnded = false;
  private evictedCount = 0;
  private corruptSegmentsSkipped = 0;
  private peakDiskBytes = 0;
  private highestIndexSeen = -1;
  private gapsDetected = 0;
  private lateSegmentsReceived = 0;

  constructor(opts: RollingSegmentBufferOptions) {
    this.tracker = new RollingMediaBufferTracker(opts.bufferConfig);
    this.workDir = path.resolve(opts.workDir);
    this.maxDiskBytes = opts.maxDiskBytes ?? 256 * 1024 * 1024;
    this.maxStreamDurationSec = opts.maxStreamDurationSec ?? 3600;
    this.ffmpegTimeoutMs = opts.ffmpegTimeoutMs ?? 60_000;
  }

  get config(): RollingBufferConfig {
    return this.tracker.config;
  }

  /**
   * Slices a real source video file into ordered FFmpeg segments (`seg_000000.mp4`, ...)
   * and ingests each segment sequentially into the rolling buffer, simulating live arrival.
   */
  async ingestFromSourceFile(
    sourcePath: string,
    opts?: {
      onSegmentIngested?: (segment: BufferedMediaSegment) => Promise<void> | void;
      markEndOfStream?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<BufferedMediaSegment[]> {
    if (opts?.signal?.aborted) {
      throw new Error('Ingestion aborted before start');
    }
    await fs.mkdir(this.workDir, { recursive: true });

    const sourceMeta = await probe(sourcePath);
    if (sourceMeta.durationSec > this.maxStreamDurationSec) {
      throw new Error(
        `Source duration (${sourceMeta.durationSec}s) exceeds buffer limit (${this.maxStreamDurationSec}s).`,
      );
    }

    const segDur = this.tracker.config.segmentDurationSec;
    const pattern = path.join(this.workDir, 'seg_%06d.mp4');

    // Stream-copy segmentation preserves original H.264/AAC encoding & A/V sync
    await runFfmpegSegment(
      [
        '-y',
        '-i',
        sourcePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        String(segDur),
        '-reset_timestamps',
        '1',
        pattern,
      ],
      this.ffmpegTimeoutMs,
      opts?.signal,
    );

    const files = (await fs.readdir(this.workDir))
      .filter((f) => /^seg_\d{6}\.mp4$/.test(f))
      .sort();

    const ingested: BufferedMediaSegment[] = [];
    let cursorSec = 0;

    for (let i = 0; i < files.length; i++) {
      const fullPath = path.join(this.workDir, files[i]);
      const seg = await this.registerSegmentFile(i, fullPath, cursorSec);
      if (seg.valid) {
        cursorSec = seg.endSec;
        ingested.push(seg);
        if (opts?.onSegmentIngested) {
          await opts.onSegmentIngested(seg);
        }
      }
      await this.evictExpired(cursorSec);
    }

    if (opts?.markEndOfStream !== false) {
      this.streamEnded = true;
    }

    return ingested;
  }

  /**
   * Registers and validates a single segment file (used both during stream replay and
   * for injecting synthetic/corrupt segments in resilience tests).
   * Corrupt or incomplete segments are recorded as `valid: false` without crashing the worker.
   */
  async registerSegmentFile(
    index: number,
    filePath: string,
    startSec: number,
  ): Promise<BufferedMediaSegment> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size === 0) {
        throw new Error('Segment file is empty (0 bytes)');
      }
      const meta = await probe(filePath);
      if (!Number.isFinite(meta.durationSec) || meta.durationSec <= 0 || meta.width <= 0 || meta.height <= 0) {
        throw new Error(`Invalid segment probe metadata: duration=${meta.durationSec}, ${meta.width}x${meta.height}`);
      }
      const bytes = await fs.readFile(filePath);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

      const segment: BufferedMediaSegment = {
        index,
        filePath,
        startSec,
        endSec: startSec + meta.durationSec,
        durationSec: meta.durationSec,
        sizeBytes: stat.size,
        sha256,
        valid: true,
      };
      this.segments.set(index, segment);
      return segment;
    } catch (err) {
      this.corruptSegmentsSkipped++;
      const bad: BufferedMediaSegment = {
        index,
        filePath,
        startSec,
        endSec: startSec,
        durationSec: 0,
        sizeBytes: 0,
        sha256: '',
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.segments.set(index, bad);
      return bad;
    }
  }

  /**
   * Registers a pre-verified segment hydrated from durable object storage (whose bytes
   * have already passed SHA-256 integrity verification against the source manifest).
   */
  registerVerifiedSegment(segment: BufferedMediaSegment): void {
    this.segments.set(segment.index, segment);
    this.peakDiskBytes = Math.max(this.peakDiskBytes, this.getTotalDiskBytes());
  }

  /**
   * Appends a single live incoming segment as it arrives over time.
   *
   * - Copies into buffer workDir (unless copyToWorkDir === false) so producer staging cleanup
   *   never deletes retained or pinned footage.
   * - Validates via ffprobe + SHA-256; corrupt segments are skipped safely without crashing.
   * - Tracks sequence gaps and late/out-of-order segment arrivals.
   * - Evicts expired or over-quota unpinned segments while preserving pinned highlight windows.
   */
  async appendIncomingSegment(input: IncomingSegmentInput): Promise<BufferedMediaSegment> {
    await fs.mkdir(this.workDir, { recursive: true });

    if (this.highestIndexSeen >= 0) {
      if (input.index > this.highestIndexSeen + 1) {
        this.gapsDetected += input.index - this.highestIndexSeen - 1;
      } else if (input.index < this.highestIndexSeen) {
        this.lateSegmentsReceived++;
      }
    }
    if (input.index > this.highestIndexSeen) {
      this.highestIndexSeen = input.index;
    }

    let targetPath = input.sourceFilePath;
    if (input.copyToWorkDir !== false) {
      targetPath = path.join(this.workDir, `seg_${String(input.index).padStart(6, '0')}.mp4`);
      if (path.resolve(input.sourceFilePath) !== path.resolve(targetPath)) {
        await fs.copyFile(input.sourceFilePath, targetPath);
      }
    }

    const seg = await this.registerSegmentFile(input.index, targetPath, input.expectedStartSec);
    if (!seg.valid) {
      // Remove invalid copy immediately so corrupt bytes never occupy buffer quota
      if (input.copyToWorkDir !== false) {
        await fs.rm(targetPath, { force: true }).catch(() => {});
      }
    }

    this.peakDiskBytes = Math.max(this.peakDiskBytes, this.getTotalDiskBytes());
    await this.evictExpired(this.getLatestBufferedSec());
    return seg;
  }

  /** Returns the earliest and latest valid buffered timestamps currently retained. */
  getBufferedTimeRange(): {
    earliestSec: number;
    latestSec: number;
    validSegmentCount: number;
  } {
    const valid = this.getValidSegments();
    if (valid.length === 0) {
      return { earliestSec: 0, latestSec: 0, validSegmentCount: 0 };
    }
    let earliestSec = Infinity;
    let latestSec = 0;
    for (const s of valid) {
      if (s.startSec < earliestSec) earliestSec = s.startSec;
      if (s.endSec > latestSec) latestSec = s.endSec;
    }
    return {
      earliestSec: Number.isFinite(earliestSec) ? earliestSec : 0,
      latestSec,
      validSegmentCount: valid.length,
    };
  }

  /**
   * Clear readiness API for continuous live highlight extraction:
   * reports whether pre-event footage is buffered, post-event footage has arrived,
   * whether any interior segment gap exists, and whether the candidate can be finalized now
   * (without waiting for the livestream to end).
   */
  checkCandidateWindowReadiness(
    eventTimestampSec: number,
    opts?: {
      preEventSec?: number;
      postEventSec?: number;
      /** When true, delays finalization if an interior gap exists while stream is still live. */
      waitForGapsWhileLive?: boolean;
    },
  ): WindowReadinessStatus {
    const preSec = opts?.preEventSec ?? this.tracker.config.preEventSec;
    const postSec = opts?.postEventSec ?? this.tracker.config.postEventSec;
    const range = this.getBufferedTimeRange();
    const rawStart = Math.max(0, eventTimestampSec - preSec);
    const rawEnd = eventTimestampSec + postSec;
    const windowEndSec =
      this.streamEnded && range.latestSec > 0
        ? Math.min(range.latestSec, Math.max(rawStart + 0.5, rawEnd))
        : rawEnd;

    const covering = this.getSegmentsForTimeRange(rawStart, windowEndSec);
    const hasCoveringSegments = covering.length > 0;

    // Pre-event footage is available if earliest retained segment reaches <= windowStartSec (+0.5s tolerance)
    // or if the event occurred near stream start and we have the earliest valid segment.
    const preEventAvailable =
      hasCoveringSegments &&
      (covering[0].startSec <= rawStart + 0.75 || (rawStart === 0 && covering[0].index === 0));

    // Post-event footage is available as soon as live buffer reaches windowEndSec OR stream has ended
    const postEventAvailable =
      hasCoveringSegments &&
      (range.latestSec >= rawEnd - 0.1 || (this.streamEnded && range.latestSec > eventTimestampSec));

    let hasMissingGap = false;
    const gapToleranceSec = Math.max(1.0, this.tracker.config.segmentDurationSec * 0.75);
    for (let i = 1; i < covering.length; i++) {
      if (covering[i].startSec - covering[i - 1].endSec > gapToleranceSec) {
        hasMissingGap = true;
        break;
      }
    }

    const canFinalize =
      hasCoveringSegments &&
      preEventAvailable &&
      postEventAvailable &&
      (!opts?.waitForGapsWhileLive || !hasMissingGap || this.streamEnded);

    return {
      windowStartSec: rawStart,
      windowEndSec,
      preEventAvailable,
      postEventAvailable,
      hasCoveringSegments,
      hasMissingGap,
      canFinalize,
      pinnedSegmentIndices: covering.map((s) => s.index),
      earliestBufferedSec: range.earliestSec,
      latestBufferedSec: range.latestSec,
      streamEnded: this.streamEnded,
    };
  }

  /** Computes the clip window and exact segment indices covering an event spike. */
  computeWindowForEvent(eventTimestampSec: number): BufferWindow {
    const latestEnd = this.getLatestBufferedSec();
    const maxBound = this.streamEnded && latestEnd > 0 ? latestEnd : undefined;
    return this.tracker.computeCandidateWindow(eventTimestampSec, maxBound);
  }

  /** True once post-event footage has arrived (or stream has ended). */
  isWindowReady(windowEndSec: number): boolean {
    if (this.streamEnded) return this.getValidSegments().length > 0;
    return this.getLatestBufferedSec() >= windowEndSec;
  }

  markEndOfStream(): void {
    this.streamEnded = true;
  }

  getLatestBufferedSec(): number {
    let maxEnd = 0;
    for (const seg of this.segments.values()) {
      if (seg.valid && seg.endSec > maxEnd) maxEnd = seg.endSec;
    }
    return maxEnd;
  }

  getValidSegments(): BufferedMediaSegment[] {
    return [...this.segments.values()]
      .filter((s) => s.valid)
      .sort((a, b) => a.index - b.index);
  }

  /** Returns all valid segments overlapping [windowStartSec, windowEndSec]. */
  getSegmentsForTimeRange(windowStartSec: number, windowEndSec: number): BufferedMediaSegment[] {
    return this.getValidSegments().filter(
      (s) => s.endSec > windowStartSec && s.startSec < windowEndSec,
    );
  }

  pinSegments(indices: number[], leaseId: string): void {
    for (const idx of indices) {
      let set = this.pins.get(idx);
      if (!set) {
        set = new Set<string>();
        this.pins.set(idx, set);
      }
      set.add(leaseId);
    }
  }

  unpinLease(leaseId: string): void {
    for (const [idx, set] of this.pins.entries()) {
      set.delete(leaseId);
      if (set.size === 0) {
        this.pins.delete(idx);
      }
    }
  }

  isPinned(index: number): boolean {
    const set = this.pins.get(index);
    return Boolean(set && set.size > 0);
  }

  getTotalDiskBytes(): number {
    let total = 0;
    for (const seg of this.segments.values()) {
      total += seg.sizeBytes;
    }
    return total;
  }

  /**
   * Safely deletes unpinned segments outside the retention horizon or exceeding maxDiskBytes.
   * Never deletes segments pinned by an active clip-generation lease.
   */
  async evictExpired(currentTimeSec: number): Promise<number[]> {
    const cutoffSec = currentTimeSec - this.tracker.config.maxRetentionSec;
    const evicted: number[] = [];

    const ordered = [...this.segments.values()].sort((a, b) => a.index - b.index);

    // 1. Time-based retention eviction (skip pinned segments)
    for (const seg of ordered) {
      if (this.isPinned(seg.index)) continue;
      if (seg.endSec < cutoffSec || !seg.valid) {
        await fs.rm(seg.filePath, { force: true }).catch(() => {});
        this.segments.delete(seg.index);
        evicted.push(seg.index);
        this.evictedCount++;
      }
    }

    // 2. Disk-space quota eviction (oldest unpinned segments first)
    if (this.getTotalDiskBytes() > this.maxDiskBytes) {
      const remaining = [...this.segments.values()].sort((a, b) => a.index - b.index);
      for (const seg of remaining) {
        if (this.getTotalDiskBytes() <= this.maxDiskBytes) break;
        if (this.isPinned(seg.index)) continue;
        await fs.rm(seg.filePath, { force: true }).catch(() => {});
        this.segments.delete(seg.index);
        evicted.push(seg.index);
        this.evictedCount++;
      }
    }

    return evicted;
  }

  getStats(): {
    retainedSegments: number;
    pinnedSegments: number;
    evictedCount: number;
    corruptSegmentsSkipped: number;
    totalDiskBytes: number;
    peakDiskBytes: number;
    earliestBufferedSec: number;
    latestBufferedSec: number;
    gapsDetected: number;
    lateSegmentsReceived: number;
    streamEnded: boolean;
  } {
    const range = this.getBufferedTimeRange();
    return {
      retainedSegments: range.validSegmentCount,
      pinnedSegments: this.pins.size,
      evictedCount: this.evictedCount,
      corruptSegmentsSkipped: this.corruptSegmentsSkipped,
      totalDiskBytes: this.getTotalDiskBytes(),
      peakDiskBytes: this.peakDiskBytes,
      earliestBufferedSec: range.earliestSec,
      latestBufferedSec: range.latestSec,
      gapsDetected: this.gapsDetected,
      lateSegmentsReceived: this.lateSegmentsReceived,
      streamEnded: this.streamEnded,
    };
  }

  /** Removes all temporary segment files and the buffer scratch directory safely. */
  async cleanupAll(): Promise<void> {
    this.segments.clear();
    this.pins.clear();
    await fs.rm(this.workDir, { recursive: true, force: true }).catch(() => {});
  }
}
