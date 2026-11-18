import {
  CacheableSourceIdSchema,
  HighlightDetectionSampleSchema,
  HighlightWindowCandidateSchema,
  RollingBufferConfigSchema,
  type CacheableSourceId,
  type CpuSignalKind,
  type HighlightDetectionSample,
  type HighlightWindowCandidate,
  type RollingBufferConfig,
} from '@autoedit/contracts';

export interface LiveHighlightDetector {
  readonly algorithmVersion: 'v1.0-heuristic' | 'v1.1-multimodal' | 'v2.0-custom';
  ingestSignal(sample: HighlightDetectionSample): void;
  evaluate(currentTimeSec: number): HighlightWindowCandidate[];
  getRollingBufferConfig(): RollingBufferConfig;
}

export interface BufferWindow {
  windowStartSec: number;
  windowEndSec: number;
  pinnedSegmentIndices: number[];
}

/**
 * Tracks a configurable rolling media buffer for live highlight capture.
 * Example default: 45s before event + 15s after event, divided into 6s segments.
 */
export class RollingMediaBufferTracker {
  readonly config: RollingBufferConfig;

  constructor(config?: Partial<RollingBufferConfig>) {
    this.config = RollingBufferConfigSchema.parse(config ?? {});
  }

  /** Computes the clip window and media segment indices covering an event spike. */
  computeCandidateWindow(eventTimestampSec: number, maxDurationSec?: number): BufferWindow {
    const start = Math.max(0, eventTimestampSec - this.config.preEventSec);
    const rawEnd = eventTimestampSec + this.config.postEventSec;
    const end =
      maxDurationSec !== undefined ? Math.min(maxDurationSec, Math.max(start + 1, rawEnd)) : rawEnd;

    const segDur = this.config.segmentDurationSec;
    const firstSeg = Math.floor(start / segDur);
    const lastSeg = Math.floor(Math.max(start, end - 0.001) / segDur);
    const pinnedSegmentIndices: number[] = [];
    for (let idx = firstSeg; idx <= lastSeg; idx++) {
      pinnedSegmentIndices.push(idx);
    }

    return {
      windowStartSec: start,
      windowEndSec: end,
      pinnedSegmentIndices,
    };
  }

  /** Returns the oldest segment index still retained within the rolling buffer horizon. */
  getEarliestRetainedSegmentIndex(currentTimeSec: number): number {
    const earliestSec = Math.max(0, currentTimeSec - this.config.maxRetentionSec);
    return Math.floor(earliestSec / this.config.segmentDurationSec);
  }
}

const DEFAULT_SIGNAL_WEIGHTS: Record<CpuSignalKind, number> = {
  AUDIO_ENERGY: 0.30,
  SPEECH_ACTIVITY: 0.20,
  CHAT_VELOCITY: 0.25,
  CHAT_EXCITEMENT_KEYWORDS: 0.15,
  TRANSCRIPT_CONTEXT: 0.10,
  SELECTIVE_VISUAL: 0.15,
};

export interface CpuDetectorOptions {
  canonicalSourceId: CacheableSourceId;
  bufferConfig?: Partial<RollingBufferConfig>;
  /** Minimum composite score (0..100) to emit a candidate; defaults to 65. */
  scoreThreshold?: number;
  /** Minimum spacing in seconds between distinct highlight peaks; defaults to 20s. */
  cooldownSec?: number;
  /** Time bucket width in seconds for aggregating concurrent signals; defaults to 5s. */
  aggregationWindowSec?: number;
}

/**
 * Deterministic CPU-first live highlight detector.
 *
 * - Runs completely on CPU with zero continuous vision AI cost.
 * - Dynamically normalizes across whichever signals are present (works seamlessly
 *   when a platform does not expose live chat).
 */
export class CpuFirstHeuristicDetector implements LiveHighlightDetector {
  readonly algorithmVersion = 'v1.0-heuristic' as const;
  private readonly buffer: RollingMediaBufferTracker;
  private samples: HighlightDetectionSample[] = [];
  private readonly canonicalSourceId: CacheableSourceId;
  private readonly scoreThreshold: number;
  private readonly cooldownSec: number;
  private readonly aggregationWindowSec: number;
  private readonly maxRetainedSamples: number;
  private lastEmittedEventSec = -Infinity;
  private readonly evaluatedBucketKeys = new Set<number>();

  constructor(opts: CpuDetectorOptions & { maxRetainedSamples?: number }) {
    this.canonicalSourceId = CacheableSourceIdSchema.parse(opts.canonicalSourceId);
    this.buffer = new RollingMediaBufferTracker(opts.bufferConfig);
    this.scoreThreshold = opts.scoreThreshold ?? 65;
    this.cooldownSec = opts.cooldownSec ?? 20;
    this.aggregationWindowSec = opts.aggregationWindowSec ?? 5;
    this.maxRetainedSamples = Math.max(64, opts.maxRetainedSamples ?? 2000);
  }

  getRollingBufferConfig(): RollingBufferConfig {
    return { ...this.buffer.config };
  }

  getRetainedSampleCount(): number {
    return this.samples.length;
  }

  ingestSignal(rawSample: HighlightDetectionSample): void {
    const sample = HighlightDetectionSampleSchema.parse(rawSample);
    this.samples.push(sample);
    if (this.samples.length > this.maxRetainedSamples) {
      this.samples.splice(0, this.samples.length - this.maxRetainedSamples);
    }
  }

  /** Prunes historical samples older than the rolling retention horizon to keep state bounded. */
  pruneOldSamples(currentTimeSec: number): void {
    const earliestSec = Math.max(0, currentTimeSec - this.buffer.config.maxRetentionSec);
    if (this.samples.length > 0 && this.samples[0].timestampSec < earliestSec) {
      this.samples = this.samples.filter((s) => s.timestampSec >= earliestSec);
    }
    const earliestBucket = Math.floor(earliestSec / this.aggregationWindowSec);
    for (const bk of this.evaluatedBucketKeys) {
      if (bk < earliestBucket) this.evaluatedBucketKeys.delete(bk);
    }
  }

  private scoreBucket(
    bucketKey: number,
    bucketSamples: HighlightDetectionSample[],
  ): { eventSec: number; compositeScore: number; contributingSignals: CpuSignalKind[] } {
    const peakByKind = new Map<CpuSignalKind, number>();
    let eventSec = bucketKey * this.aggregationWindowSec;
    let maxIntensity = -1;

    for (const s of bucketSamples) {
      const prev = peakByKind.get(s.signalKind) ?? 0;
      if (s.normalizedIntensity > prev) {
        peakByKind.set(s.signalKind, s.normalizedIntensity);
      }
      if (s.normalizedIntensity > maxIntensity) {
        maxIntensity = s.normalizedIntensity;
        eventSec = s.timestampSec;
      }
    }

    let weightedSum = 0;
    let weightTotal = 0;
    const contributingSignals: CpuSignalKind[] = [];
    for (const [kind, intensity] of peakByKind.entries()) {
      const w = DEFAULT_SIGNAL_WEIGHTS[kind] ?? 0.1;
      weightedSum += intensity * w;
      weightTotal += w;
      contributingSignals.push(kind);
    }

    const baseScore = weightTotal > 0 ? (weightedSum / weightTotal) * 100 : 0;
    const corroborationBonus =
      contributingSignals.length >= 2 ? Math.min(10, (contributingSignals.length - 1) * 5) : 0;
    const compositeScore = Math.min(100, Math.round((baseScore + corroborationBonus) * 100) / 100);
    return { eventSec, compositeScore, contributingSignals };
  }

  /**
   * Incremental evaluation for continuous live streams:
   * - Evaluates only new samples/buckets since previous calls.
   * - Enforces persistent cooldown across segment arrivals so one prolonged event spanning
   *   multiple segments never emits duplicate candidates.
   * - Prunes old detector samples to keep memory strictly bounded.
   */
  evaluateIncremental(currentTimeSec: number): HighlightWindowCandidate[] {
    this.pruneOldSamples(currentTimeSec);
    const earliestSec = Math.max(0, currentTimeSec - this.buffer.config.maxRetentionSec);
    const active = this.samples
      .filter((s) => s.timestampSec >= earliestSec && s.timestampSec <= currentTimeSec)
      .sort((a, b) => a.timestampSec - b.timestampSec);

    if (active.length === 0) return [];

    const buckets = new Map<number, HighlightDetectionSample[]>();
    for (const s of active) {
      const bucketKey = Math.floor(s.timestampSec / this.aggregationWindowSec);
      const list = buckets.get(bucketKey) ?? [];
      list.push(s);
      buckets.set(bucketKey, list);
    }

    const newlyDetected: HighlightWindowCandidate[] = [];
    for (const [bucketKey, bucketSamples] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      if (this.evaluatedBucketKeys.has(bucketKey)) continue;

      const { eventSec, compositeScore, contributingSignals } = this.scoreBucket(
        bucketKey,
        bucketSamples,
      );

      if (compositeScore >= this.scoreThreshold) {
        this.evaluatedBucketKeys.add(bucketKey);
        if (eventSec - this.lastEmittedEventSec >= this.cooldownSec) {
          const win = this.buffer.computeCandidateWindow(eventSec);
          newlyDetected.push(
            HighlightWindowCandidateSchema.parse({
              candidateId: `hl_${this.canonicalSourceId}_${Math.round(eventSec * 1000)}`,
              canonicalSourceId: this.canonicalSourceId,
              eventTimestampSec: eventSec,
              windowStartSec: win.windowStartSec,
              windowEndSec: win.windowEndSec,
              compositeScore,
              contributingSignals,
              pinnedSegmentIndices: win.pinnedSegmentIndices,
              algorithmVersion: this.algorithmVersion,
            }),
          );
          this.lastEmittedEventSec = eventSec;
        }
      } else if ((bucketKey + 1) * this.aggregationWindowSec <= currentTimeSec) {
        // Bucket is completely closed in time and did not cross threshold -> mark done
        this.evaluatedBucketKeys.add(bucketKey);
      }
    }

    return newlyDetected;
  }

  evaluate(currentTimeSec: number): HighlightWindowCandidate[] {
    const earliestSec = Math.max(0, currentTimeSec - this.buffer.config.maxRetentionSec);
    const active = this.samples
      .filter((s) => s.timestampSec >= earliestSec && s.timestampSec <= currentTimeSec)
      .sort((a, b) => a.timestampSec - b.timestampSec);

    if (active.length === 0) return [];

    // Bucket samples into aggregation windows
    const buckets = new Map<number, HighlightDetectionSample[]>();
    for (const s of active) {
      const bucketKey = Math.floor(s.timestampSec / this.aggregationWindowSec);
      const list = buckets.get(bucketKey) ?? [];
      list.push(s);
      buckets.set(bucketKey, list);
    }

    const candidates: HighlightWindowCandidate[] = [];
    let lastCandidateTime = -Infinity;

    for (const [bucketKey, bucketSamples] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const { eventSec, compositeScore, contributingSignals } = this.scoreBucket(
        bucketKey,
        bucketSamples,
      );

      if (compositeScore >= this.scoreThreshold && eventSec - lastCandidateTime >= this.cooldownSec) {
        const win = this.buffer.computeCandidateWindow(eventSec);
        candidates.push(
          HighlightWindowCandidateSchema.parse({
            candidateId: `hl_${this.canonicalSourceId}_${Math.round(eventSec * 1000)}`,
            canonicalSourceId: this.canonicalSourceId,
            eventTimestampSec: eventSec,
            windowStartSec: win.windowStartSec,
            windowEndSec: win.windowEndSec,
            compositeScore,
            contributingSignals,
            pinnedSegmentIndices: win.pinnedSegmentIndices,
            algorithmVersion: this.algorithmVersion,
          }),
        );
        lastCandidateTime = eventSec;
      }
    }

    return candidates;
  }
}
