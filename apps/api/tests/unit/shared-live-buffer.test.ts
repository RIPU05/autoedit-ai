import { describe, expect, it, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ensureControlledLiveFixture,
  ControlledLocalStreamAdapter,
  FfmpegRollingSegmentBuffer,
  extractAudioSignalsFromSegments,
  extractAndVerifyHighlightClip,
  probeAndValidateClipMp4,
  CpuFirstHeuristicDetector,
  resolveMediaSourceFromUrl,
  MediaSourceError,
} from '../../src/media/index.js';

describe('Step 3B.5: Controlled Stream Fixture, Real FFmpeg Rolling Buffer & CPU Audio Highlight Detection', () => {
  const tmpRoot = path.resolve(process.cwd(), 'tmp', `step3b5-unit-${Date.now()}`);
  const fixturePath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('1. generates deterministic real H.264/AAC fixture and enforces controlled adapter opt-in without weakening SSRF', async () => {
    const fixture = await ensureControlledLiveFixture(fixturePath, {
      durationSec: 30,
      spikeStartSec: 16,
      spikeEndSec: 19,
    });
    expect(fixture.sizeBytes).toBeGreaterThan(20_000);
    expect(fixture.durationSec).toBeGreaterThanOrEqual(29);
    expect(fixture.width).toBe(1280);
    expect(fixture.height).toBe(720);

    // Disabled adapter fails closed
    expect(
      () =>
        new ControlledLocalStreamAdapter({
          fixturePath,
          policy: {
            enabled: false,
            provider: 'twitch',
            channelName: 'demo_streamer',
            broadcastId: 'session_disabled',
            rightsStatus: 'PERMITTED_PUBLIC',
            allowSharedCacheReuse: true,
          },
        }),
    ).toThrow(MediaSourceError);

    // Normal external URL API STILL blocks local paths and loopback URLs (SSRF intact!)
    expect(() => resolveMediaSourceFromUrl(`file:///${fixturePath.replace(/\\/g, '/')}`)).toThrow(MediaSourceError);
    expect(() => resolveMediaSourceFromUrl('http://127.0.0.1:4000/fixture.mp4')).toThrow(MediaSourceError);
  }, 60_000);

  it('2. segments real video into rolling buffer, pins active segments, evicts unpinned, and survives corrupt segments', async () => {
    await ensureControlledLiveFixture(fixturePath);
    const workDir = path.join(tmpRoot, 'buffer-test');
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir,
      bufferConfig: {
        segmentDurationSec: 5,
        maxRetentionSec: 60,
        preEventSec: 6,
        postEventSec: 4,
      },
    });

    try {
      const segments = await buffer.ingestFromSourceFile(fixturePath, { markEndOfStream: false });
      expect(segments.length).toBeGreaterThanOrEqual(5);
      expect(buffer.getLatestBufferedSec()).toBeGreaterThanOrEqual(29);

      // Post-event readiness check: waiting for footage at 35s returns false while stream is live
      expect(buffer.isWindowReady(25)).toBe(true);
      expect(buffer.isWindowReady(35)).toBe(false);
      buffer.markEndOfStream();
      expect(buffer.isWindowReady(35)).toBe(true);

      // Event near start of stream clamps cleanly to 0s
      const earlyWindow = buffer.computeWindowForEvent(3);
      expect(earlyWindow.windowStartSec).toBe(0);
      expect(earlyWindow.windowEndSec).toBe(7);

      // Inject a corrupt 0-byte segment: worker records corruptSegmentsSkipped without crashing
      const corruptPath = path.join(workDir, 'seg_corrupt.mp4');
      await fs.writeFile(corruptPath, Buffer.from('not-a-valid-mp4'));
      const corruptSeg = await buffer.registerSegmentFile(999, corruptPath, 30);
      expect(corruptSeg.valid).toBe(false);
      expect(buffer.getStats().corruptSegmentsSkipped).toBe(1);

      // Pin segment 0, then advance retention clock past expiry: segment 0 survives, unpinned segments evict!
      buffer.pinSegments([0], 'active_clip_lease');
      const evicted = await buffer.evictExpired(500);
      expect(evicted.length).toBeGreaterThan(0);
      expect(buffer.getValidSegments().map((s) => s.index)).toContain(0);
      expect(buffer.getValidSegments().length).toBe(1);

      // Unpin and evict remaining
      buffer.unpinLease('active_clip_lease');
      await buffer.evictExpired(500);
      expect(buffer.getValidSegments()).toHaveLength(0);
    } finally {
      await buffer.cleanupAll();
    }

    // Scratch directory completely cleaned up
    await expect(fs.stat(workDir)).rejects.toThrow();
  }, 60_000);

  it('3. detects the real 16-19s audio spike with 0 false positives and supports synthetic chat signal fusion', async () => {
    await ensureControlledLiveFixture(fixturePath);
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir: path.join(tmpRoot, 'signal-test'),
      bufferConfig: {
        segmentDurationSec: 5,
        preEventSec: 6,
        postEventSec: 4,
      },
    });

    try {
      const segments = await buffer.ingestFromSourceFile(fixturePath, { markEndOfStream: true });
      const audioRes = await extractAudioSignalsFromSegments(segments);

      expect(audioRes.buckets.length).toBeGreaterThanOrEqual(25);
      // Verify quiet baseline vs loud spike dBFS separation
      expect(audioRes.baselineRmsDb).toBeLessThan(-20);
      const peakBucket = [...audioRes.buckets].sort((a, b) => b.rmsDb - a.rmsDb)[0];
      expect(peakBucket.timestampSec).toBeGreaterThanOrEqual(15.5);
      expect(peakBucket.timestampSec).toBeLessThanOrEqual(19.5);
      expect(peakBucket.deltaOverBaselineDb).toBeGreaterThan(15);

      // Feed real audio signals into CpuFirstHeuristicDetector (NO chat required)
      const detector = new CpuFirstHeuristicDetector({
        canonicalSourceId: 'twitch:broadcast:demo_streamer:sig_001',
        bufferConfig: { preEventSec: 6, postEventSec: 4, segmentDurationSec: 5 },
        scoreThreshold: 65,
        cooldownSec: 15,
      });
      for (const s of audioRes.samples) {
        detector.ingestSignal(s);
      }

      const candidates = detector.evaluate(buffer.getLatestBufferedSec());
      // Exactly 1 true positive around 16-19s, 0 false positives in quiet [0-15s] and [20-30s]
      expect(candidates).toHaveLength(1);
      expect(candidates[0].eventTimestampSec).toBeGreaterThanOrEqual(15.5);
      expect(candidates[0].eventTimestampSec).toBeLessThanOrEqual(19.5);
      expect(candidates[0].windowStartSec).toBeGreaterThanOrEqual(9.5);
      expect(candidates[0].windowEndSec).toBeLessThanOrEqual(24);

      // Synthetic injected chat spike corroborates the same highlight cleanly
      detector.ingestSignal({
        timestampSec: 17.5,
        signalKind: 'CHAT_VELOCITY',
        normalizedIntensity: 0.95,
        keywords: ['POG', 'CLIP IT'],
      });
      const withChat = detector.evaluate(buffer.getLatestBufferedSec());
      expect(withChat).toHaveLength(1);
      expect(withChat[0].contributingSignals).toContain('CHAT_VELOCITY');
      expect(withChat[0].compositeScore).toBeGreaterThanOrEqual(candidates[0].compositeScore);
    } finally {
      await buffer.cleanupAll();
    }
  }, 60_000);

  it('4. extracts a real playable highlight MP4, probes codecs/duration, and rejects corrupt MP4 outputs', async () => {
    await ensureControlledLiveFixture(fixturePath);
    const workDir = path.join(tmpRoot, 'extract-test');
    const buffer = new FfmpegRollingSegmentBuffer({
      workDir: path.join(workDir, 'segs'),
      bufferConfig: { segmentDurationSec: 5, preEventSec: 6, postEventSec: 4 },
    });

    try {
      await buffer.ingestFromSourceFile(fixturePath, { markEndOfStream: true });
      const outMp4 = path.join(workDir, 'clip.mp4');

      const clip = await extractAndVerifyHighlightClip({
        buffer,
        windowStartSec: 11,
        windowEndSec: 21,
        outputPath: outMp4,
        preferStreamCopy: true,
        requireAudio: true,
      });

      expect(clip.sizeBytes).toBeGreaterThan(10_000);
      expect(clip.hasVideo).toBe(true);
      expect(clip.hasAudio).toBe(true);
      expect(clip.videoCodec).toBe('h264');
      expect(clip.audioCodec).toBe('aac');
      expect(clip.width).toBe(1280);
      expect(clip.height).toBe(720);
      expect(clip.durationSec).toBeGreaterThanOrEqual(8);
      expect(clip.durationSec).toBeLessThanOrEqual(12.5);
      expect(clip.sha256).toMatch(/^[a-f0-9]{64}$/);

      // Corrupt MP4 (valid .mp4 extension, invalid bytes) is strictly rejected!
      const corruptMp4 = path.join(workDir, 'corrupt.mp4');
      await fs.writeFile(corruptMp4, Buffer.from('corrupt-mp4-header-bytes'));
      await expect(probeAndValidateClipMp4(corruptMp4)).rejects.toThrow(/ffprobe failed/);
    } finally {
      await buffer.cleanupAll();
    }
  }, 60_000);
});
