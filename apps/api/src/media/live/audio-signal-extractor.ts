import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import type { HighlightDetectionSample } from '@autoedit/contracts';
import type { BufferedMediaSegment } from './rolling-segment-buffer.js';

export interface AudioEnergyBucket {
  timestampSec: number;
  rmsDb: number;
  peakDb: number;
  deltaOverBaselineDb: number;
}

export interface AudioSignalExtractionResult {
  buckets: AudioEnergyBucket[];
  baselineRmsDb: number;
  samples: HighlightDetectionSample[];
}

const SAMPLE_RATE = 16_000;

function decodePcmS16Le(filePath: string, timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath || 'ffmpeg';
    const child = spawn(
      bin,
      [
        '-v',
        'error',
        '-i',
        filePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Audio PCM extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Audio PCM extraction failed (${code}): ${stderr.trim().slice(-200)}`));
    });
  });
}

function median(values: number[]): number {
  if (values.length === 0) return -40;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Extracts real CPU-only audio energy & short-term volume spikes from buffered media segments
 * via FFmpeg PCM decoding (16kHz mono s16le) and converts them into HighlightDetectionSample[].
 */
export async function extractAudioSignalsFromSegments(
  segments: BufferedMediaSegment[],
  opts?: {
    /** Window size in seconds per energy measurement; defaults to 1.0s. */
    windowSec?: number;
    /** Dynamic range in dB above baseline that maps to intensity 1.0; defaults to 18 dB. */
    spikeRangeDb?: number;
    /** Minimum dB above baseline to also count as sustained speech/vocal activity; defaults to 10 dB. */
    activityThresholdDb?: number;
  },
): Promise<AudioSignalExtractionResult> {
  const windowSec = opts?.windowSec ?? 1.0;
  const spikeRangeDb = opts?.spikeRangeDb ?? 18;
  const activityThresholdDb = opts?.activityThresholdDb ?? 10;
  const samplesPerWindow = Math.max(1, Math.floor(SAMPLE_RATE * windowSec));

  const rawBuckets: { timestampSec: number; rmsDb: number; peakDb: number }[] = [];

  for (const seg of segments) {
    if (!seg.valid) continue;
    const pcm = await decodePcmS16Le(seg.filePath);
    const totalSamples = Math.floor(pcm.length / 2);

    for (let offset = 0; offset + samplesPerWindow <= totalSamples; offset += samplesPerWindow) {
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < samplesPerWindow; i++) {
        const sample = pcm.readInt16LE((offset + i) * 2) / 32768;
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
        sumSq += sample * sample;
      }
      const rms = Math.sqrt(sumSq / samplesPerWindow);
      const rmsDb = rms > 1e-5 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
      const peakDb = peak > 1e-5 ? Math.max(-90, 20 * Math.log10(peak)) : -90;

      const timestampSec = Math.round((seg.startSec + (offset / SAMPLE_RATE) + windowSec * 0.5) * 100) / 100;
      rawBuckets.push({ timestampSec, rmsDb, peakDb });
    }
  }

  const baselineRmsDb = median(rawBuckets.map((b) => b.rmsDb));
  const buckets: AudioEnergyBucket[] = [];
  const samples: HighlightDetectionSample[] = [];

  for (const b of rawBuckets) {
    const delta = b.rmsDb - baselineRmsDb;
    buckets.push({
      timestampSec: b.timestampSec,
      rmsDb: Math.round(b.rmsDb * 100) / 100,
      peakDb: Math.round(b.peakDb * 100) / 100,
      deltaOverBaselineDb: Math.round(delta * 100) / 100,
    });

    // Normalize relative spike above median baseline into [0, 1]
    const normalizedEnergy = Math.max(0, Math.min(1, delta / spikeRangeDb));
    samples.push({
      timestampSec: b.timestampSec,
      signalKind: 'AUDIO_ENERGY',
      normalizedIntensity: Math.round(normalizedEnergy * 1000) / 1000,
      rawValue: Math.round(b.rmsDb * 100) / 100,
      keywords: [],
      metadata: { deltaOverBaselineDb: Math.round(delta * 100) / 100, peakDb: Math.round(b.peakDb * 100) / 100 },
    });

    // Emit sustained activity when audio rises meaningfully above baseline
    if (delta >= activityThresholdDb) {
      const activityScore = Math.max(0, Math.min(1, (delta - activityThresholdDb * 0.5) / spikeRangeDb));
      samples.push({
        timestampSec: b.timestampSec,
        signalKind: 'SPEECH_ACTIVITY',
        normalizedIntensity: Math.round(activityScore * 1000) / 1000,
        rawValue: Math.round(delta * 100) / 100,
        keywords: [],
      });
    }
  }

  return {
    buckets,
    baselineRmsDb: Math.round(baselineRmsDb * 100) / 100,
    samples,
  };
}
