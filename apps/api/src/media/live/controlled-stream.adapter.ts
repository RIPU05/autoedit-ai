import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  UniversalMediaSourceSchema,
  type BroadcastIdentity,
  type ChannelIdentity,
  type RightsAccessStatus,
  type UniversalMediaSource,
} from '@autoedit/contracts';
import { MediaSourceError } from '../errors.js';
import { probe } from '../../ffmpeg/probe.js';

export interface ControlledFixtureOptions {
  /** Total fixture duration in seconds; defaults to 30s. */
  durationSec?: number;
  /** Start of high-energy audio spike in seconds; defaults to 16s. */
  spikeStartSec?: number;
  /** End of high-energy audio spike in seconds; defaults to 19s. */
  spikeEndSec?: number;
  /** Timeout for fixture generation in ms; defaults to 60_000. */
  timeoutMs?: number;
}

export interface ControlledFixtureEventSpec {
  id: string;
  startSec: number;
  endSec: number;
  /** Signal character: 'loud_spike' | 'mid_burst' | 'modulated_pattern'. */
  pattern?: 'loud_spike' | 'mid_burst' | 'modulated_pattern';
}

export interface ControlledMultiEventFixtureOptions {
  /** Total fixture duration in seconds; defaults to 60s. */
  durationSec?: number;
  /** Distinct highlight events; defaults to 3 events (early 4-6s, mid 26-29s, late 46-49s). */
  events?: ControlledFixtureEventSpec[];
  /** Timeout for fixture generation in ms; defaults to 90_000. */
  timeoutMs?: number;
}

export const DEFAULT_MULTI_EVENT_SPECS: ControlledFixtureEventSpec[] = [
  { id: 'early_event', startSec: 4, endSec: 6, pattern: 'loud_spike' },
  { id: 'midstream_event', startSec: 26, endSec: 29, pattern: 'mid_burst' },
  { id: 'late_pattern_event', startSec: 46, endSec: 49, pattern: 'modulated_pattern' },
];

export interface ControlledTestBroadcastPolicy {
  /** Must be explicitly true; disabled by default so test local adapters cannot run accidentally. */
  enabled: boolean;
  provider: 'twitch' | 'kick' | 'youtube';
  channelName: string;
  /** Verified immutable broadcast session ID (e.g. 'sim_session_001'). */
  broadcastId: string;
  rightsStatus: RightsAccessStatus;
  allowSharedCacheReuse: boolean;
}

function runFfmpeg(args: string[], timeoutMs = 60_000, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('FFmpeg cancelled before start'));
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
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(new Error('FFmpeg cancelled via AbortSignal'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`FFmpeg exited with code ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}

/**
 * Deterministically generates a real, playable H.264/AAC MP4 fixture with:
 * - 1280x720 @ 30fps testsrc2 video (keyframe every 1s for clean segment cuts)
 * - Quiet baseline audio (~ -32 dBFS)
 * - One high-energy audio event spike (~ -4 dBFS) during [spikeStartSec, spikeEndSec]
 *
 * Reuses an existing valid fixture at `outputPath` if already generated and intact.
 */
export async function ensureControlledLiveFixture(
  outputPath: string,
  opts: ControlledFixtureOptions = {},
): Promise<{
  filePath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  spikeStartSec: number;
  spikeEndSec: number;
}> {
  const durationSec = opts.durationSec ?? 30;
  const spikeStartSec = opts.spikeStartSec ?? 16;
  const spikeEndSec = opts.spikeEndSec ?? 19;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Reuse if already valid on disk
  try {
    const stat = await fs.stat(outputPath);
    if (stat.size > 10_000) {
      const meta = await probe(outputPath);
      if (Math.abs(meta.durationSec - durationSec) < 1.5 && meta.width > 0 && meta.height > 0) {
        return {
          filePath: outputPath,
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          sizeBytes: stat.size,
          spikeStartSec,
          spikeEndSec,
        };
      }
    }
  } catch {
    // Generate below
  }

  // Build deterministic audio expression:
  // Quiet 220Hz baseline (amplitude 0.025 ~ -32 dBFS) + loud 880Hz+1320Hz spike (amplitude 0.72 ~ -4 dBFS)
  // strictly between spikeStartSec and spikeEndSec.
  const audioExpr = `0.025*sin(2*PI*220*t)+between(t,${spikeStartSec},${spikeEndSec})*(0.45*sin(2*PI*880*t)+0.35*sin(2*PI*1320*t))`;
  const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;

  try {
    await runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=1280x720:rate=30:duration=${durationSec}`,
        '-f',
        'lavfi',
        '-i',
        `aevalsrc='${audioExpr}':s=44100:d=${durationSec}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '30',
        '-keyint_min',
        '30',
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        tmpPath,
      ],
      timeoutMs,
    );

    await fs.rename(tmpPath, outputPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  const stat = await fs.stat(outputPath);
  const meta = await probe(outputPath);
  return {
    filePath: outputPath,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    sizeBytes: stat.size,
    spikeStartSec,
    spikeEndSec,
  };
}

/**
 * Controlled local test-media acquisition adapter.
 *
 * SECURITY BOUNDARY:
 * - Exists strictly as an explicit opt-in test adapter for authorized local fixtures.
 * - Does NOT relax SSRF protections in `url-safety.ts` or `resolveMediaSourceFromUrl()`.
 * - Never accepts arbitrary user-supplied filesystem paths through external HTTP URL APIs.
 * - Uses an explicit test-only policy fixture; production requires persistent rights verification.
 */
export class ControlledLocalStreamAdapter {
  readonly policy: ControlledTestBroadcastPolicy;
  readonly fixturePath: string;

  constructor(opts: { fixturePath: string; policy: ControlledTestBroadcastPolicy }) {
    if (!opts.policy.enabled) {
      throw new MediaSourceError({
        code: 'UNSUPPORTED_ACQUISITION',
        message: 'ControlledLocalStreamAdapter is disabled unless explicitly enabled for controlled testing.',
      });
    }
    this.fixturePath = path.resolve(opts.fixturePath);
    this.policy = opts.policy;
  }

  /**
   * Produces a verified IMMUTABLE_BROADCAST UniversalMediaSource representing
   * this controlled simulated live session.
   */
  buildVerifiedBroadcastSource(): UniversalMediaSource {
    const channel = this.policy.channelName.trim().toLowerCase();
    const broadcastId = this.policy.broadcastId.trim();
    const provider = this.policy.provider;

    const canonicalId = (
      provider === 'youtube'
        ? `youtube:broadcast:${broadcastId}`
        : `${provider}:broadcast:${channel}:${broadcastId}`
    ) as BroadcastIdentity;

    const channelId = `${provider}:channel:${channel}` as ChannelIdentity;

    return UniversalMediaSourceSchema.parse({
      canonicalId,
      identityScope: 'IMMUTABLE_BROADCAST',
      provider,
      sourceType: 'live',
      externalId: provider === 'youtube' ? broadcastId : channel,
      channelId,
      broadcastId,
      availability: 'LIVE_NOW',
      acquisitionCapability: 'PERMITTED_STREAM',
      rightsStatus: this.policy.rightsStatus,
      ingestionStatus: 'PENDING',
      metadata: {
        hasAudio: true,
        isLive: true,
        channelName: channel,
        title: `Controlled Live Fixture (${channel}/${broadcastId})`,
      },
    });
  }
}

/**
 * Deterministically generates a 60-second (configurable) H.264/AAC MP4 fixture containing
 * THREE distinct highlight events separated by quiet baseline intervals:
 * 1. Early event near stream start (default 4–6s)
 * 2. Midstream loud event (default 26–29s)
 * 3. Later modulated burst event (default 46–49s)
 *
 * Uses `-g 30` (1-second keyframes) so incremental time-paced segment slicing stays frame-clean.
 */
export async function ensureControlledMultiEventLiveFixture(
  outputPath: string,
  opts: ControlledMultiEventFixtureOptions = {},
): Promise<{
  filePath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  events: ControlledFixtureEventSpec[];
}> {
  const durationSec = opts.durationSec ?? 60;
  const events = opts.events ?? DEFAULT_MULTI_EVENT_SPECS;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Reuse if already valid on disk
  try {
    const stat = await fs.stat(outputPath);
    if (stat.size > 20_000) {
      const meta = await probe(outputPath);
      if (Math.abs(meta.durationSec - durationSec) < 1.5 && meta.width > 0 && meta.height > 0) {
        return {
          filePath: outputPath,
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          sizeBytes: stat.size,
          events,
        };
      }
    }
  } catch {
    // Generate below
  }

  const eventTerms = events.map((ev) => {
    if (ev.pattern === 'mid_burst') {
      return `between(t,${ev.startSec},${ev.endSec})*(0.42*sin(2*PI*660*t)+0.32*sin(2*PI*1320*t)+0.22*sin(2*PI*1760*t))`;
    }
    if (ev.pattern === 'modulated_pattern') {
      // Distinct modulated harmonic pattern (high energy envelope with rhythmic modulation)
      return `between(t,${ev.startSec},${ev.endSec})*((0.65+0.30*sin(2*PI*3*t))*(0.45*sin(2*PI*550*t)+0.35*sin(2*PI*1100*t)))`;
    }
    // Default 'loud_spike'
    return `between(t,${ev.startSec},${ev.endSec})*(0.45*sin(2*PI*880*t)+0.35*sin(2*PI*1320*t))`;
  });

  const audioExpr = [`0.025*sin(2*PI*220*t)`, ...eventTerms].join('+');
  const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;

  try {
    await runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=1280x720:rate=30:duration=${durationSec}`,
        '-f',
        'lavfi',
        '-i',
        `aevalsrc='${audioExpr}':s=44100:d=${durationSec}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '30',
        '-keyint_min',
        '30',
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        tmpPath,
      ],
      timeoutMs,
    );

    await fs.rename(tmpPath, outputPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  const stat = await fs.stat(outputPath);
  const meta = await probe(outputPath);
  return {
    filePath: outputPath,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    sizeBytes: stat.size,
    events,
  };
}

export interface EmittedStreamSegment {
  index: number;
  filePath: string;
  startSec: number;
  expectedDurationSec: number;
  emittedAtMs: number;
  isCorruptInjected?: boolean;
}

export interface RealTimeStreamOptions {
  /** Length of each emitted media segment in seconds; defaults to 4s. */
  segmentDurationSec?: number;
  /** Wall-clock pacing delay between emitted segments in ms; defaults to 250ms. */
  segmentPaceMs?: number;
  /** Maximum bounded in-flight segment queue size before applying backpressure; defaults to 4. */
  maxQueueSize?: number;
  /** Optional starting segment index (for interrupted stream resume/recovery tests). */
  startFromSegmentIndex?: number;
  /** Optional cap on total segments to emit. */
  maxSegments?: number;
  /** Deterministic test fault: emit corrupt bytes at this segment index. */
  injectCorruptAtIndex?: number;
  /** Deterministic test fault: omit/skip this segment index (simulates network gap). */
  injectMissingAtIndex?: number;
  /** Deterministic test fault: swap emission order of `[i, i+1]` (simulates late segment). */
  reorderSwapIndex?: number;
  /** Deterministic test fault: fail stream with error when reaching this segment index. */
  failAtSegmentIndex?: number;
}

export interface RealTimeStreamHandlers {
  onStart?: (info: { canonicalSourceId: string; totalExpectedSegments: number; segmentDurationSec: number }) => Promise<void> | void;
  onSegment: (segment: EmittedStreamSegment) => Promise<void>;
  onEnd?: (info: { totalEmitted: number; totalDurationSec: number }) => Promise<void> | void;
  onError?: (err: Error) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface RealTimeStreamRunStats {
  totalExpectedSegments: number;
  emittedSegments: number;
  backpressureWaits: number;
  startedAtMs: number;
  endedAtMs: number;
  cancelled: boolean;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal?.aborted ? Promise.reject(new Error('Stream cancelled')) : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stream cancelled'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Stream cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Opt-in controlled real-time stream adapter that emits REAL H.264/AAC MP4 media segments
 * incrementally over time with bounded queue backpressure and cancellation.
 *
 * CRITICAL PROPERTY:
 * Never pre-segments the full file upfront. Segment `i` is sliced on demand via FFmpeg
 * input-seeking (`-ss <startSec> -t <segmentDurationSec> -c copy`) right before delivery,
 * so segment `i+1` does not exist on disk while segment `i` is being ingested and analyzed.
 */
export class ControlledRealTimeStreamAdapter extends ControlledLocalStreamAdapter {
  readonly streamOptions: Required<
    Pick<RealTimeStreamOptions, 'segmentDurationSec' | 'segmentPaceMs' | 'maxQueueSize'>
  > &
    Omit<RealTimeStreamOptions, 'segmentDurationSec' | 'segmentPaceMs' | 'maxQueueSize'>;

  constructor(opts: {
    fixturePath: string;
    policy: ControlledTestBroadcastPolicy;
    streamOptions?: RealTimeStreamOptions;
  }) {
    super({ fixturePath: opts.fixturePath, policy: opts.policy });
    const so = opts.streamOptions ?? {};
    this.streamOptions = {
      ...so,
      segmentDurationSec: so.segmentDurationSec ?? 4,
      segmentPaceMs: so.segmentPaceMs ?? 250,
      maxQueueSize: Math.max(1, so.maxQueueSize ?? 4),
    };
  }

  /**
   * Streams real media segments into `handlers.onSegment` at a paced cadence with bounded
   * queue backpressure. Cleans up its temporary producer staging directory on exit.
   */
  async streamSegments(
    producerWorkDir: string,
    handlers: RealTimeStreamHandlers,
  ): Promise<RealTimeStreamRunStats> {
    const startedAtMs = Date.now();
    const source = this.buildVerifiedBroadcastSource();
    const segDur = this.streamOptions.segmentDurationSec;
    const paceMs = this.streamOptions.segmentPaceMs;
    const maxQueue = this.streamOptions.maxQueueSize;
    const signal = handlers.signal;

    const fixtureMeta = await probe(this.fixturePath);
    const totalFixtureSegments = Math.max(1, Math.ceil(fixtureMeta.durationSec / segDur));
    const startIdx = Math.max(0, this.streamOptions.startFromSegmentIndex ?? 0);
    const endIdxExclusive =
      this.streamOptions.maxSegments !== undefined
        ? Math.min(totalFixtureSegments, startIdx + this.streamOptions.maxSegments)
        : totalFixtureSegments;

    // Build deterministic emission index schedule (optionally swapping one pair to test late segments)
    const schedule: number[] = [];
    for (let i = startIdx; i < endIdxExclusive; i++) {
      if (this.streamOptions.injectMissingAtIndex === i) continue;
      schedule.push(i);
    }
    if (this.streamOptions.reorderSwapIndex !== undefined) {
      const pos = schedule.indexOf(this.streamOptions.reorderSwapIndex);
      if (pos >= 0 && pos + 1 < schedule.length) {
        const tmp = schedule[pos];
        schedule[pos] = schedule[pos + 1];
        schedule[pos + 1] = tmp;
      }
    }

    await fs.mkdir(producerWorkDir, { recursive: true });

    const queue: EmittedStreamSegment[] = [];
    let producerDone = false;
    let fatalErr: Error | null = null;
    let emittedSegments = 0;
    let backpressureWaits = 0;
    let wakeConsumer: (() => void) | null = null;
    let wakeProducer: (() => void) | null = null;

    const notifyConsumer = () => {
      if (wakeConsumer) {
        const fn = wakeConsumer;
        wakeConsumer = null;
        fn();
      }
    };
    const notifyProducer = () => {
      if (wakeProducer) {
        const fn = wakeProducer;
        wakeProducer = null;
        fn();
      }
    };

    const onAbort = () => {
      notifyConsumer();
      notifyProducer();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await handlers.onStart?.({
        canonicalSourceId: source.canonicalId,
        totalExpectedSegments: schedule.length,
        segmentDurationSec: segDur,
      });

      const producerTask = (async () => {
        try {
          for (let step = 0; step < schedule.length; step++) {
            if (signal?.aborted) break;

            const segIndex = schedule[step];
            if (this.streamOptions.failAtSegmentIndex === segIndex) {
              throw new Error(`Simulated live feed interruption at segment ${segIndex}`);
            }

            // Bounded queue backpressure: pause producing if consumer queue is full
            while (queue.length >= maxQueue && !signal?.aborted && !fatalErr) {
              backpressureWaits++;
              await new Promise<void>((resolve) => {
                wakeProducer = resolve;
              });
            }
            if (signal?.aborted || fatalErr) break;

            if (step > 0 && paceMs > 0) {
              await sleepWithAbort(paceMs, signal);
            }
            if (signal?.aborted || fatalErr) break;

            const startSec = segIndex * segDur;
            const remainingSec = Math.max(0.5, fixtureMeta.durationSec - startSec);
            const sliceDur = Math.min(segDur, remainingSec);
            const segPath = path.join(
              producerWorkDir,
              `live_seg_${String(segIndex).padStart(6, '0')}.mp4`,
            );

            let isCorruptInjected = false;
            if (this.streamOptions.injectCorruptAtIndex === segIndex) {
              await fs.writeFile(segPath, Buffer.from('CORRUPT_LIVE_SEGMENT_BYTES_INVALID_MP4'));
              isCorruptInjected = true;
            } else {
              // Incremental single-segment slice via FFmpeg input-seeking (NEVER pre-segments whole file!)
              await runFfmpeg(
                [
                  '-y',
                  '-ss',
                  startSec.toFixed(3),
                  '-i',
                  this.fixturePath,
                  '-t',
                  sliceDur.toFixed(3),
                  '-map',
                  '0:v:0',
                  '-map',
                  '0:a:0?',
                  '-c',
                  'copy',
                  '-avoid_negative_ts',
                  'make_zero',
                  '-movflags',
                  '+faststart',
                  segPath,
                ],
                30_000,
                signal,
              );
            }

            queue.push({
              index: segIndex,
              filePath: segPath,
              startSec,
              expectedDurationSec: sliceDur,
              emittedAtMs: Date.now(),
              isCorruptInjected,
            });
            emittedSegments++;
            notifyConsumer();
          }
        } catch (err) {
          if (!signal?.aborted) {
            fatalErr = err instanceof Error ? err : new Error(String(err));
          }
        } finally {
          producerDone = true;
          notifyConsumer();
        }
      })();

      const consumerTask = (async () => {
        while (true) {
          if (signal?.aborted) break;
          if (queue.length === 0) {
            if (producerDone || fatalErr) break;
            await new Promise<void>((resolve) => {
              wakeConsumer = resolve;
            });
            continue;
          }
          const item = queue.shift()!;
          notifyProducer();
          try {
            await handlers.onSegment(item);
          } catch (err) {
            fatalErr = err instanceof Error ? err : new Error(String(err));
            notifyProducer();
            break;
          }
        }
      })();

      await Promise.all([producerTask, consumerTask]);

      if (fatalErr) {
        await handlers.onError?.(fatalErr);
        throw fatalErr;
      }

      if (!signal?.aborted) {
        await handlers.onEnd?.({
          totalEmitted: emittedSegments,
          totalDurationSec: fixtureMeta.durationSec,
        });
      }

      return {
        totalExpectedSegments: schedule.length,
        emittedSegments,
        backpressureWaits,
        startedAtMs,
        endedAtMs: Date.now(),
        cancelled: Boolean(signal?.aborted),
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await fs.rm(producerWorkDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
