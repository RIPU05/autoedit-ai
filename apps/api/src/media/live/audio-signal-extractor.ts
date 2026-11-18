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

function decodePcmS16Le(filePath: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Audio PCM extraction cancelled before start'));
    }
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
    let settled = false;

    const finish = (err?: Error, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(buf ?? Buffer.alloc(0));
    };

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(new Error('Audio PCM extraction cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(new Error(`Audio PCM extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish(undefined, Buffer.concat(chunks));
      else finish(new Error(`Audio PCM extraction failed (${code}): ${stderr.trim().slice(-200)}`));
    });
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -40;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function median(values: number[]): number {
  if (values.length === 0) return -40;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface IncrementalAudioTrackerOptions {
  /** Window size in seconds per energy measurement; defaults to 1.0s. */
  windowSec?: number;
  /** Dynamic range in dB above baseline that maps to intensity 1.0; defaults to 18 dB. */
  spikeRangeDb?: number;
  /** Minimum dB above baseline to also count as sustained vocal/speech activity; defaults to 10 dB. */
  activityThresholdDb?: number;
  /** Maximum number of recent RMS buckets retained for online baseline estimation; defaults to 120. */
  maxHistoryBuckets?: number;
}

/**
 * Stateful, bounded-memory incremental CPU-only audio signal extractor for continuous streams.
 *
 * - Decodes ONLY the single newly arrived segment (never re-analyzes historical segments).
 * - Maintains a bounded rolling baseline (35th-percentile of recent RMS dBFS buckets, so
 *   bursts of loud highlights do not bias the quiet baseline upward).
 * - Tracks `segmentsAnalyzedCount` so callers/tests can verify strictly 1 analysis pass per segment.
 */
export class IncrementalAudioSignalTracker {
  private readonly windowSec: number;
  private readonly spikeRangeDb: number;
  private readonly activityThresholdDb: number;
  private readonly maxHistoryBuckets: number;
  private readonly rmsHistory: number[] = [];
  private readonly analyzedSegmentIndices = new Set<number>();

  segmentsAnalyzedCount = 0;

  constructor(opts: IncrementalAudioTrackerOptions = {}) {
    this.windowSec = opts.windowSec ?? 1.0;
    this.spikeRangeDb = opts.spikeRangeDb ?? 18;
    this.activityThresholdDb = opts.activityThresholdDb ?? 10;
    this.maxHistoryBuckets = Math.max(8, opts.maxHistoryBuckets ?? 120);
  }

  getHistorySize(): number {
    return this.rmsHistory.length;
  }

  hasAnalyzedSegment(index: number): boolean {
    return this.analyzedSegmentIndices.has(index);
  }

  async processSegment(
    segment: BufferedMediaSegment,
    opts?: { signal?: AbortSignal },
  ): Promise<AudioSignalExtractionResult> {
    if (!segment.valid || this.analyzedSegmentIndices.has(segment.index)) {
      return {
        buckets: [],
        baselineRmsDb: this.rmsHistory.length > 0 ? Math.round(percentile(this.rmsHistory, 0.35) * 100) / 100 : -40,
        samples: [],
      };
    }

    const samplesPerWindow = Math.max(1, Math.floor(SAMPLE_RATE * this.windowSec));
    const pcm = await decodePcmS16Le(segment.filePath, 30_000, opts?.signal);
    const totalSamples = Math.floor(pcm.length / 2);

    const rawBuckets: { timestampSec: number; rmsDb: number; peakDb: number }[] = [];
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
      const timestampSec =
        Math.round((segment.startSec + offset / SAMPLE_RATE + this.windowSec * 0.5) * 100) / 100;
      rawBuckets.push({ timestampSec, rmsDb, peakDb });
    }

    // Update bounded rolling RMS history before computing online baseline
    for (const b of rawBuckets) {
      this.rmsHistory.push(b.rmsDb);
    }
    if (this.rmsHistory.length > this.maxHistoryBuckets) {
      this.rmsHistory.splice(0, this.rmsHistory.length - this.maxHistoryBuckets);
    }

    this.analyzedSegmentIndices.add(segment.index);
    if (this.analyzedSegmentIndices.size > this.maxHistoryBuckets * 4) {
      const oldest = this.analyzedSegmentIndices.values().next().value;
      if (oldest !== undefined) this.analyzedSegmentIndices.delete(oldest);
    }
    this.segmentsAnalyzedCount++;

    // 35th-percentile online baseline resists upward drift even when an early highlight spike
    // occupies a large fraction of the first 2 segments!
    const baselineRmsDb = percentile(this.rmsHistory, 0.35);
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

      const normalizedEnergy = Math.max(0, Math.min(1, delta / this.spikeRangeDb));
      samples.push({
        timestampSec: b.timestampSec,
        signalKind: 'AUDIO_ENERGY',
        normalizedIntensity: Math.round(normalizedEnergy * 1000) / 1000,
        rawValue: Math.round(b.rmsDb * 100) / 100,
        keywords: [],
        metadata: {
          deltaOverBaselineDb: Math.round(delta * 100) / 100,
          peakDb: Math.round(b.peakDb * 100) / 100,
          segmentIndex: segment.index,
        },
      });

      if (delta >= this.activityThresholdDb) {
        const activityScore = Math.max(
          0,
          Math.min(1, (delta - this.activityThresholdDb * 0.5) / this.spikeRangeDb),
        );
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
