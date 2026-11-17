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

function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath || 'ffmpeg';
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim().slice(-400)}`));
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
