import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type { FfmpegRollingSegmentBuffer } from './rolling-segment-buffer.js';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface ProbedClipMetadata {
  filePath: string;
  sizeBytes: number;
  sha256: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  encodingMode: 'stream-copy' | 'reencode-fallback' | 'reencode-requested';
}

export interface ExtractHighlightClipInput {
  buffer: FfmpegRollingSegmentBuffer;
  windowStartSec: number;
  windowEndSec: number;
  outputPath: string;
  /** Prefer fast stream copy when safe, falling back to re-encode if trim precision/codec requires it. */
  preferStreamCopy?: boolean;
  /** Require an audio stream in output validation; defaults to true. */
  requireAudio?: boolean;
  /** Optional custom video filter (forces re-encode, e.g. for private user vertical crop). */
  videoFilter?: string;
  /** Timeout for FFmpeg extraction in ms; defaults to 60_000. */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel running FFmpeg immediately (e.g., on lease loss or request timeout). */
  signal?: AbortSignal;
}

function runFfmpegExtract(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('FFmpeg clip extraction aborted before start.'));
      return;
    }

    const bin = ffmpegPath || 'ffmpeg';
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore if already exited
      }
      reject(new Error('FFmpeg clip extraction aborted (lease lost or request cancelled).'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`FFmpeg clip extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg clip extraction failed (code ${code}): ${stderr.trim().slice(-400)}`));
    });
  });
}

/**
 * Probes a generated MP4 file via ffprobe and strictly validates codecs, streams,
 * non-empty size, and duration correspondence against expected bounds.
 * Never trusts file extension alone.
 */
export async function probeAndValidateClipMp4(
  filePath: string,
  opts?: {
    expectedDurationSec?: number;
    durationToleranceSec?: number;
    requireAudio?: boolean;
    encodingMode?: ProbedClipMetadata['encodingMode'];
  },
): Promise<ProbedClipMetadata> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Clip validation failed: file "${filePath}" is empty or missing.`);
  }

  const probeData = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(new Error(`ffprobe failed on "${filePath}": ${err.message}`));
      else resolve(data);
    });
  });

  const videoStream = probeData.streams.find((s) => s.codec_type === 'video');
  const audioStream = probeData.streams.find((s) => s.codec_type === 'audio');

  const durationSec = Number(probeData.format.duration ?? videoStream?.duration ?? 0);
  const width = Number(videoStream?.width ?? 0);
  const height = Number(videoStream?.height ?? 0);
  const [num, den] = (videoStream?.r_frame_rate ?? '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;
  const videoCodec = videoStream?.codec_name ?? '';
  const audioCodec = audioStream?.codec_name ?? null;

  if (!videoStream || !videoCodec || width <= 0 || height <= 0) {
    throw new Error(`Clip validation failed: missing or invalid video stream (${videoCodec} ${width}x${height}).`);
  }
  if ((opts?.requireAudio ?? true) && (!audioStream || !audioCodec)) {
    throw new Error('Clip validation failed: required audio stream is missing.');
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0.1) {
    throw new Error(`Clip validation failed: invalid duration (${durationSec}s).`);
  }

  if (opts?.expectedDurationSec !== undefined) {
    const tolerance = opts.durationToleranceSec ?? Math.max(2.0, opts.expectedDurationSec * 0.25);
    if (Math.abs(durationSec - opts.expectedDurationSec) > tolerance) {
      throw new Error(
        `Clip validation failed: probed duration ${durationSec.toFixed(2)}s deviates from expected ${opts.expectedDurationSec.toFixed(2)}s (tolerance ±${tolerance.toFixed(2)}s).`,
      );
    }
  }

  const bytes = await fs.readFile(filePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  return {
    filePath,
    sizeBytes: stat.size,
    sha256,
    durationSec: Math.round(durationSec * 1000) / 1000,
    width,
    height,
    fps: Math.round(fps * 100) / 100,
    videoCodec,
    audioCodec,
    hasVideo: true,
    hasAudio: Boolean(audioStream),
    encodingMode: opts?.encodingMode ?? 'stream-copy',
  };
}

/**
 * Writes candidate MP4 bytes to a temporary file, probes and validates via ffprobe,
 * computes real content SHA-256, and removes the temporary file.
 */
export async function probeAndValidateClipMp4FromBuffer(
  bytes: Buffer,
  workDir: string,
  opts?: {
    expectedDurationSec?: number;
    durationToleranceSec?: number;
    requireAudio?: boolean;
    encodingMode?: ProbedClipMetadata['encodingMode'];
  },
): Promise<ProbedClipMetadata> {
  if (!bytes || bytes.length === 0) {
    throw new Error('Clip validation failed: buffer is empty.');
  }
  await fs.mkdir(workDir, { recursive: true });
  const tmpPath = path.join(
    workDir,
    `probe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`,
  );
  try {
    await fs.writeFile(tmpPath, bytes);
    const meta = await probeAndValidateClipMp4(tmpPath, opts);
    return { ...meta, filePath: '(verified-from-storage)' };
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Extracts a real, playable highlight MP4 from buffered segments in FfmpegRollingSegmentBuffer.
 *
 * - Pins required segments for the duration of extraction and unpins on completion/failure.
 * - Verifies post-event footage availability before finalizing.
 * - Prefers stream-copy when safe, falling back to H.264/AAC re-encoding when precision
 *   or codec compatibility requires it.
 * - Deeply validates output via ffprobe before returning.
 */
export async function extractAndVerifyHighlightClip(
  input: ExtractHighlightClipInput,
): Promise<ProbedClipMetadata> {
  if (input.signal?.aborted) {
    throw new Error('FFmpeg clip extraction aborted before start.');
  }
  const timeoutMs = input.timeoutMs ?? 60_000;
  const maxAvailable = input.buffer.getLatestBufferedSec();
  if (maxAvailable <= 0) {
    throw new Error('Rolling segment buffer has no valid buffered segments.');
  }

  const startSec = Math.max(0, input.windowStartSec);
  const clampedEndSec = Math.min(maxAvailable, input.windowEndSec);
  if (clampedEndSec <= startSec) {
    throw new Error(`Invalid clip window [${startSec}s, ${clampedEndSec}s].`);
  }

  if (!input.buffer.isWindowReady(input.windowEndSec)) {
    throw new Error(
      `Post-event footage not yet available: requested end ${input.windowEndSec}s, latest buffered ${maxAvailable}s.`,
    );
  }

  const segments = input.buffer.getSegmentsForTimeRange(startSec, clampedEndSec);
  if (segments.length === 0) {
    throw new Error(`No valid buffered segments cover [${startSec}s, ${clampedEndSec}s].`);
  }

  const leaseId = `clip_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  input.buffer.pinSegments(
    segments.map((s) => s.index),
    leaseId,
  );

  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  const concatListPath = `${input.outputPath}.${leaseId}.concat.txt`;
  const relativeOffsetSec = Math.max(0, startSec - segments[0].startSec);
  const targetDurationSec = Math.max(0.5, clampedEndSec - startSec);

  try {
    // Write FFmpeg concat demuxer manifest (using forward slashes for Windows compatibility)
    const manifest = segments
      .map((s) => `file '${s.filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fs.writeFile(concatListPath, manifest, 'utf-8');

    const preferCopy = input.preferStreamCopy !== false && !input.videoFilter;

    if (preferCopy) {
      try {
        await runFfmpegExtract(
          [
            '-y',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            concatListPath,
            '-ss',
            relativeOffsetSec.toFixed(3),
            '-t',
            targetDurationSec.toFixed(3),
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            input.outputPath,
          ],
          timeoutMs,
          input.signal,
        );
        if (input.signal?.aborted) {
          throw new Error('FFmpeg clip extraction aborted.');
        }
        return await probeAndValidateClipMp4(input.outputPath, {
          expectedDurationSec: targetDurationSec,
          durationToleranceSec: Math.max(2.0, targetDurationSec * 0.25),
          requireAudio: input.requireAudio ?? true,
          encodingMode: 'stream-copy',
        });
      } catch (copyErr) {
        await fs.rm(input.outputPath, { force: true }).catch(() => {});
        if (input.signal?.aborted) {
          throw copyErr;
        }
        // Stream-copy failed or drifted outside tolerance -> fall back cleanly to frame-accurate re-encode
      }
    }

    if (input.signal?.aborted) {
      throw new Error('FFmpeg clip extraction aborted before re-encode.');
    }

    const reencodeArgs = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-ss',
      relativeOffsetSec.toFixed(3),
      '-t',
      targetDurationSec.toFixed(3),
      ...(input.videoFilter ? ['-vf', input.videoFilter] : []),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      input.outputPath,
    ];

    await runFfmpegExtract(reencodeArgs, timeoutMs, input.signal);

    if (input.signal?.aborted) {
      await fs.rm(input.outputPath, { force: true }).catch(() => {});
      throw new Error('FFmpeg clip extraction aborted after re-encode.');
    }

    return await probeAndValidateClipMp4(input.outputPath, {
      expectedDurationSec: targetDurationSec,
      durationToleranceSec: Math.max(1.5, targetDurationSec * 0.2),
      requireAudio: input.requireAudio ?? true,
      encodingMode: preferCopy ? 'reencode-fallback' : 'reencode-requested',
    });
  } finally {
    input.buffer.unpinLease(leaseId);
    await fs.rm(concatListPath, { force: true }).catch(() => {});
  }
}
