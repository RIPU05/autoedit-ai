import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CacheRenderSettings,
  HighlightDetectionSample,
  HighlightWindowCandidate,
  RollingBufferConfig,
} from '@autoedit/contracts';
import type { MediaStorageProvider } from '../../storage/storage.types.js';
import { assertAcquisitionPermitted } from '../canonical-source.js';
import { CpuFirstHeuristicDetector } from '../highlight-detector.js';
import { SharedIngestionCoordinator, type IngestionRequestAction } from '../ingestion-coordinator.js';
import {
  SharedArtifactCacheService,
  createTrustedCacheAuthContext,
  type CacheArtifactDescriptor,
  type TrustedCacheAuthContext,
} from '../shared-cache.js';
import { ControlledLocalStreamAdapter } from './controlled-stream.adapter.js';
import { FfmpegRollingSegmentBuffer } from './rolling-segment-buffer.js';
import { extractAudioSignalsFromSegments } from './audio-signal-extractor.js';
import { extractAndVerifyHighlightClip, type ProbedClipMetadata } from './highlight-clip-extractor.js';

export interface SharedBroadcastRequest {
  adapter: ControlledLocalStreamAdapter;
  requesterUserId: string;
  workerId: string;
  sourceRevision?: string;
  algorithmVersion?: string;
  bufferConfig?: Partial<RollingBufferConfig>;
  renderSettings?: CacheRenderSettings;
  scoreThreshold?: number;
  cooldownSec?: number;
  /** Optional synthetic chat/keyword signals injected in tests (never claims live platform chat). */
  syntheticSignals?: HighlightDetectionSample[];
  leaseMs?: number;
  maxRetries?: number;
  /** Optional test hook invoked just before persisting READY (for stale-worker / crash tests). */
  onBeforePublishReady?: (ctx: { fencingToken: number; workerId: string }) => Promise<void>;
  /** Optional test hook to simulate FFmpeg/storage failure before READY. */
  onAfterExtractBeforeUpload?: (clipPath: string) => Promise<void>;
}

export interface SharedBroadcastHighlightResult {
  canonicalSourceId: string;
  coordinationAction: IngestionRequestAction;
  cacheHit: boolean;
  cacheKey: string;
  downloadUrl: string;
  candidate: HighlightWindowCandidate;
  clipMeta?: ProbedClipMetadata;
  sizeBytes: number;
  processingMs: number;
}

export interface PrivateEditRequest {
  adapter: ControlledLocalStreamAdapter;
  requesterUserId: string;
  ownerUserId: string;
  customEditHash: string;
  windowStartSec: number;
  windowEndSec: number;
  videoFilter?: string;
  sourceRevision?: string;
  bufferConfig?: Partial<RollingBufferConfig>;
}

export interface SharedPipelineMetrics {
  sourceProcessingCount: number;
  analysisPassCount: number;
  ffmpegClipRenderCount: number;
  cacheHits: number;
  recoveryRuns: number;
}

interface ActiveRunState {
  promise: Promise<{
    cacheKey: string;
    candidate: HighlightWindowCandidate;
    clipMeta: ProbedClipMetadata;
    descriptor: CacheArtifactDescriptor;
  }>;
}

const DEFAULT_BASE_CLIP_RENDER: CacheRenderSettings = {
  format: 'reel',
  width: 1280,
  height: 720,
  fps: 30,
  subtitles: false,
  zooms: false,
  transitions: 'none',
  music: false,
};

/**
 * Working end-to-end shared livestream ingestion, CPU-first highlight detection,
 * FFmpeg MP4 clip generation, and private MinIO/S3 cache reuse orchestrator.
 */
export class SharedLiveProcessingService {
  readonly cache: SharedArtifactCacheService;
  readonly metrics: SharedPipelineMetrics = {
    sourceProcessingCount: 0,
    analysisPassCount: 0,
    ffmpegClipRenderCount: 0,
    cacheHits: 0,
    recoveryRuns: 0,
  };

  private readonly activeRuns = new Map<string, ActiveRunState>();
  private readonly readyCandidates = new Map<
    string,
    { candidate: HighlightWindowCandidate; descriptor: CacheArtifactDescriptor; clipMeta: ProbedClipMetadata }
  >();

  constructor(
    private readonly coordinator: SharedIngestionCoordinator,
    private readonly storage: MediaStorageProvider,
    private readonly workRootDir: string,
  ) {
    this.cache = new SharedArtifactCacheService(storage);
  }

  private buildAuth(adapter: ControlledLocalStreamAdapter, requesterUserId: string, ownerUserId?: string): TrustedCacheAuthContext {
    const source = adapter.buildVerifiedBroadcastSource();
    assertAcquisitionPermitted(source);
    return createTrustedCacheAuthContext({
      source,
      requesterUserId,
      ownerUserId,
      allowSharedCacheReuse: adapter.policy.allowSharedCacheReuse,
    });
  }

  private buildAnalysisKey(canonicalSourceId: string, sourceRevision: string, algorithmVersion: string, renderSettings: CacheRenderSettings): string {
    return `${canonicalSourceId}::${sourceRevision}::${algorithmVersion}::${JSON.stringify(renderSettings)}`;
  }

  /**
   * Coordinates shared ingestion, CPU-first audio highlight detection, FFmpeg clip generation,
   * and verified durable MinIO cache storage across concurrent clippers.
   */
  async requestSharedBroadcastHighlight(
    req: SharedBroadcastRequest,
  ): Promise<SharedBroadcastHighlightResult> {
    const startedAt = Date.now();
    const auth = this.buildAuth(req.adapter, req.requesterUserId);
    const source = auth.source;
    const sourceRevision = req.sourceRevision ?? 'v1';
    const algorithmVersion = req.algorithmVersion ?? 'v1.0-heuristic';
    const renderSettings = req.renderSettings ?? DEFAULT_BASE_CLIP_RENDER;
    const runKey = this.buildAnalysisKey(source.canonicalId, sourceRevision, algorithmVersion, renderSettings);

    // 1. Atomic coordination via Redis (or in-memory store)
    const coord = await this.coordinator.requestIngestion({
      canonicalSourceId: source.canonicalId,
      requesterId: req.requesterUserId,
      workerId: req.workerId,
      leaseMs: req.leaseMs ?? 30_000,
      maxRetries: req.maxRetries ?? 3,
    });

    // Case A: Coordination says READY -> verify durable object actually exists and is non-empty!
    if (coord.action === 'REUSE_READY') {
      const cachedInfo = this.readyCandidates.get(runKey);
      if (cachedInfo) {
        const check = await this.cache.checkCachedArtifact(auth, cachedInfo.descriptor);
        if (check.hit && (check.sizeBytes ?? 0) > 0) {
          this.metrics.cacheHits++;
          const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, cachedInfo.descriptor);
          return {
            canonicalSourceId: source.canonicalId,
            coordinationAction: 'REUSE_READY',
            cacheHit: true,
            cacheKey: check.cacheKey,
            downloadUrl,
            candidate: cachedInfo.candidate,
            clipMeta: cachedInfo.clipMeta,
            sizeBytes: check.sizeBytes ?? cachedInfo.clipMeta.sizeBytes,
            processingMs: Date.now() - startedAt,
          };
        }
        // Durable artifact missing or 0-byte corrupt -> treat as recovery case!
        this.metrics.recoveryRuns++;
        this.readyCandidates.delete(runKey);
        const recovered = await this.executeRealProcessing({
          req,
          auth,
          sourceRevision,
          algorithmVersion,
          renderSettings,
          runKey,
          fencingToken: undefined, // already READY in Redis; regenerate durable object cleanly
        });
        const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, recovered.descriptor);
        return {
          canonicalSourceId: source.canonicalId,
          coordinationAction: 'ACQUIRED_RECOVERY',
          cacheHit: false,
          cacheKey: recovered.cacheKey,
          downloadUrl,
          candidate: recovered.candidate,
          clipMeta: recovered.clipMeta,
          sizeBytes: recovered.clipMeta.sizeBytes,
          processingMs: Date.now() - startedAt,
        };
      }
    }

    // Case B: Another worker actively owns the lease -> attach without spawning duplicate FFmpeg!
    if (coord.action === 'ATTACH_EXISTING') {
      const inflight = this.activeRuns.get(runKey);
      if (inflight) {
        const outcome = await inflight.promise;
        const check = await this.cache.checkCachedArtifact(auth, outcome.descriptor);
        if (!check.hit || (check.sizeBytes ?? 0) === 0) {
          throw new Error('Attached owner finished, but verified cached artifact is missing in storage.');
        }
        this.metrics.cacheHits++;
        const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, outcome.descriptor);
        return {
          canonicalSourceId: source.canonicalId,
          coordinationAction: 'ATTACH_EXISTING',
          cacheHit: true,
          cacheKey: check.cacheKey,
          downloadUrl,
          candidate: outcome.candidate,
          clipMeta: outcome.clipMeta,
          sizeBytes: check.sizeBytes ?? outcome.clipMeta.sizeBytes,
          processingMs: Date.now() - startedAt,
        };
      }
      // Different runKey (e.g., different renderSettings/algorithmVersion) sharing same source,
      // or remote worker owns it: check if this exact clip variant is already cached.
      const cachedInfo = this.readyCandidates.get(runKey);
      if (cachedInfo) {
        const check = await this.cache.checkCachedArtifact(auth, cachedInfo.descriptor);
        if (check.hit && (check.sizeBytes ?? 0) > 0) {
          this.metrics.cacheHits++;
          const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, cachedInfo.descriptor);
          return {
            canonicalSourceId: source.canonicalId,
            coordinationAction: 'ATTACH_EXISTING',
            cacheHit: true,
            cacheKey: check.cacheKey,
            downloadUrl,
            candidate: cachedInfo.candidate,
            clipMeta: cachedInfo.clipMeta,
            sizeBytes: check.sizeBytes ?? cachedInfo.clipMeta.sizeBytes,
            processingMs: Date.now() - startedAt,
          };
        }
      }
    }

    if (coord.action === 'FAILED_MAX_RETRIES') {
      throw new Error(`Ingestion for ${source.canonicalId} exhausted maxRetries.`);
    }

    if (coord.action === 'ACQUIRED_RECOVERY') {
      this.metrics.recoveryRuns++;
    }

    // Case C: This worker owns the lease (ACQUIRED_NEW or ACQUIRED_RECOVERY) -> run real FFmpeg once!
    const workPromise = this.executeRealProcessing({
      req,
      auth,
      sourceRevision,
      algorithmVersion,
      renderSettings,
      runKey,
      fencingToken: coord.fencingToken,
    });

    this.activeRuns.set(runKey, { promise: workPromise });
    try {
      const outcome = await workPromise;
      const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, outcome.descriptor);
      return {
        canonicalSourceId: source.canonicalId,
        coordinationAction: coord.action,
        cacheHit: false,
        cacheKey: outcome.cacheKey,
        downloadUrl,
        candidate: outcome.candidate,
        clipMeta: outcome.clipMeta,
        sizeBytes: outcome.clipMeta.sizeBytes,
        processingMs: Date.now() - startedAt,
      };
    } finally {
      this.activeRuns.delete(runKey);
    }
  }

  private async executeRealProcessing(args: {
    req: SharedBroadcastRequest;
    auth: TrustedCacheAuthContext;
    sourceRevision: string;
    algorithmVersion: string;
    renderSettings: CacheRenderSettings;
    runKey: string;
    fencingToken?: number;
  }): Promise<{
    cacheKey: string;
    candidate: HighlightWindowCandidate;
    clipMeta: ProbedClipMetadata;
    descriptor: CacheArtifactDescriptor;
  }> {
    const { req, auth, sourceRevision, algorithmVersion, renderSettings, runKey, fencingToken } = args;
    const source = auth.source;
    const scratchDir = path.join(
      this.workRootDir,
      `run_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir: path.join(scratchDir, 'segments'),
      bufferConfig: req.bufferConfig,
    });

    try {
      if (fencingToken !== undefined) {
        await this.coordinator.markIngesting({
          canonicalSourceId: source.canonicalId,
          workerId: req.workerId,
          fencingToken,
          leaseMs: req.leaseMs ?? 30_000,
        });
      }

      // 1. Real FFmpeg segment ingestion into rolling buffer
      this.metrics.sourceProcessingCount++;
      const segments = await buffer.ingestFromSourceFile(req.adapter.fixturePath, {
        markEndOfStream: true,
      });

      if (fencingToken !== undefined) {
        await this.coordinator.renewLease({
          canonicalSourceId: source.canonicalId,
          workerId: req.workerId,
          fencingToken,
          leaseMs: req.leaseMs ?? 30_000,
        });
      }

      // 2. Real CPU-first audio energy + spike detection
      this.metrics.analysisPassCount++;
      const audioSignals = await extractAudioSignalsFromSegments(segments);
      const detector = new CpuFirstHeuristicDetector({
        canonicalSourceId: source.canonicalId as any,
        bufferConfig: req.bufferConfig,
        scoreThreshold: req.scoreThreshold ?? 65,
        cooldownSec: req.cooldownSec ?? 15,
      });

      for (const sample of audioSignals.samples) {
        detector.ingestSignal(sample);
      }
      if (req.syntheticSignals) {
        for (const synth of req.syntheticSignals) {
          detector.ingestSignal(synth);
        }
      }

      const candidates = detector.evaluate(buffer.getLatestBufferedSec());
      if (candidates.length === 0) {
        throw new Error(`No highlight candidate detected for ${source.canonicalId}.`);
      }

      // Select top-scoring candidate and clamp window to actual buffered duration
      const best = [...candidates].sort((a, b) => b.compositeScore - a.compositeScore)[0];
      const clampedWindow = buffer.computeWindowForEvent(best.eventTimestampSec);
      const candidate: HighlightWindowCandidate = {
        ...best,
        windowStartSec: clampedWindow.windowStartSec,
        windowEndSec: clampedWindow.windowEndSec,
        pinnedSegmentIndices: clampedWindow.pinnedSegmentIndices,
      };

      const descriptor: CacheArtifactDescriptor = {
        artifactKind: 'BASE_CLIP',
        sourceRevision,
        timeRangeSec: { start: candidate.windowStartSec, end: candidate.windowEndSec },
        algorithmVersion,
        renderSettings,
        rightsScope: 'SHARED_PERMITTED',
      };

      // Check durable cache BEFORE rendering in case Redis key had expired (TTL reset)
      // while the verified MP4 still exists in MinIO!
      const preCheck = await this.cache.checkCachedArtifact(auth, descriptor);
      if (preCheck.hit && (preCheck.sizeBytes ?? 0) > 0 && !req.onBeforePublishReady && !req.onAfterExtractBeforeUpload) {
        this.metrics.cacheHits++;
        if (fencingToken !== undefined) {
          await this.coordinator.markReady({
            canonicalSourceId: source.canonicalId,
            workerId: req.workerId,
            fencingToken,
            artifactRef: preCheck.cacheKey,
          });
        }
        const reusedMeta: ProbedClipMetadata = {
          filePath: '(cached-in-storage)',
          sizeBytes: preCheck.sizeBytes ?? 0,
          sha256: preCheck.cacheKey,
          durationSec: candidate.windowEndSec - candidate.windowStartSec,
          width: renderSettings.width,
          height: renderSettings.height,
          fps: renderSettings.fps,
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasVideo: true,
          hasAudio: true,
          encodingMode: 'stream-copy',
        };
        this.readyCandidates.set(runKey, { candidate, descriptor, clipMeta: reusedMeta });
        return { cacheKey: preCheck.cacheKey, candidate, clipMeta: reusedMeta, descriptor };
      }

      // 3. Real FFmpeg highlight MP4 extraction + ffprobe validation
      this.metrics.ffmpegClipRenderCount++;
      const outClipPath = path.join(scratchDir, 'highlight.mp4');
      const clipMeta = await extractAndVerifyHighlightClip({
        buffer,
        windowStartSec: candidate.windowStartSec,
        windowEndSec: candidate.windowEndSec,
        outputPath: outClipPath,
        preferStreamCopy: true,
        requireAudio: true,
      });

      if (req.onAfterExtractBeforeUpload) {
        await req.onAfterExtractBeforeUpload(outClipPath);
      }

      // Optional test hook to simulate lease expiration / worker stall before READY
      if (req.onBeforePublishReady && fencingToken !== undefined) {
        await req.onBeforePublishReady({ fencingToken, workerId: req.workerId });
      }

      // Check fencing token BEFORE writing/publishing if lease was lost during FFmpeg
      if (fencingToken !== undefined) {
        await this.coordinator.renewLease({
          canonicalSourceId: source.canonicalId,
          workerId: req.workerId,
          fencingToken,
          leaseMs: req.leaseMs ?? 30_000,
        });
      }

      // 4. Persist verified MP4 into private MinIO/S3 via SharedArtifactCacheService
      const mp4Bytes = await fs.readFile(outClipPath);
      const stored = await this.cache.putCachedArtifact(auth, descriptor, mp4Bytes, 'video/mp4');

      // 5. Mark coordination READY only AFTER durable artifact exists & passed probe validation!
      if (fencingToken !== undefined) {
        await this.coordinator.markReady({
          canonicalSourceId: source.canonicalId,
          workerId: req.workerId,
          fencingToken,
          artifactRef: stored.cacheKey,
        });
      }

      this.readyCandidates.set(runKey, { candidate, descriptor, clipMeta });
      return { cacheKey: stored.cacheKey, candidate, clipMeta, descriptor };
    } catch (err) {
      if (fencingToken !== undefined) {
        await this.coordinator
          .markFailed({
            canonicalSourceId: source.canonicalId,
            workerId: req.workerId,
            fencingToken,
            error: err instanceof Error ? err.message : String(err),
          })
          .catch(() => {});
      }
      throw err;
    } finally {
      await buffer.cleanupAll();
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Authorizes and issues a signed download URL for an existing cached clip without
   * spawning FFmpeg or re-downloading source bytes (used for high-fanout download reuse).
   */
  async requestAuthorizedCachedClipDownload(input: {
    adapter: ControlledLocalStreamAdapter;
    requesterUserId: string;
    descriptor: CacheArtifactDescriptor;
    ownerUserId?: string;
    verifyExistsInStorage?: boolean;
  }): Promise<{ cacheKey: string; downloadUrl: string; sizeBytes?: number }> {
    const auth = this.buildAuth(input.adapter, input.requesterUserId, input.ownerUserId);
    let sizeBytes: number | undefined;
    let cacheKey: string;

    if (input.verifyExistsInStorage !== false) {
      const check = await this.cache.checkCachedArtifact(auth, input.descriptor);
      if (!check.hit || (check.sizeBytes ?? 0) === 0) {
        throw new Error(`Cached clip missing or empty for key ${check.cacheKey}.`);
      }
      sizeBytes = check.sizeBytes;
      cacheKey = check.cacheKey;
    } else {
      const id = (await import('../shared-cache.js')).resolveAuthorizedCacheIdentity(auth, input.descriptor);
      cacheKey = id.cacheKey;
    }

    const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, input.descriptor);
    this.metrics.cacheHits++;
    return { cacheKey, downloadUrl, sizeBytes };
  }

  /**
   * Renders a private user-specific personalized edit derived from a shared broadcast.
   * Stored strictly under `PRIVATE_USER` (`cache/private/<ownerUserId>/...`), isolated from other users.
   */
  async renderPrivateUserEdit(req: PrivateEditRequest): Promise<{
    cacheKey: string;
    descriptor: CacheArtifactDescriptor;
    clipMeta: ProbedClipMetadata;
    downloadUrl: string;
  }> {
    const auth = this.buildAuth(req.adapter, req.requesterUserId, req.ownerUserId);
    const scratchDir = path.join(
      this.workRootDir,
      `priv_${req.ownerUserId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    );
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir: path.join(scratchDir, 'segments'),
      bufferConfig: req.bufferConfig,
    });

    try {
      await buffer.ingestFromSourceFile(req.adapter.fixturePath, { markEndOfStream: true });
      const outPath = path.join(scratchDir, 'private-edit.mp4');
      const clipMeta = await extractAndVerifyHighlightClip({
        buffer,
        windowStartSec: req.windowStartSec,
        windowEndSec: req.windowEndSec,
        outputPath: outPath,
        preferStreamCopy: !req.videoFilter,
        videoFilter: req.videoFilter,
        requireAudio: true,
      });

      const descriptor: CacheArtifactDescriptor = {
        artifactKind: 'BASE_CLIP',
        sourceRevision: req.sourceRevision ?? 'v1',
        timeRangeSec: { start: req.windowStartSec, end: req.windowEndSec },
        algorithmVersion: 'private-edit-v1',
        renderSettings: {
          ...DEFAULT_BASE_CLIP_RENDER,
          width: clipMeta.width,
          height: clipMeta.height,
          customEditHash: req.customEditHash,
        },
        rightsScope: 'PRIVATE_USER',
      };

      const bytes = await fs.readFile(outPath);
      const stored = await this.cache.putCachedArtifact(auth, descriptor, bytes, 'video/mp4');
      const downloadUrl = await this.cache.createAuthorizedDownloadUrl(auth, descriptor);
      return { cacheKey: stored.cacheKey, descriptor, clipMeta, downloadUrl };
    } finally {
      await buffer.cleanupAll();
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
