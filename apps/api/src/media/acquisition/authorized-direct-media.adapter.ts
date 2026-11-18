import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { CacheableSourceId } from '@autoedit/contracts';
import { MediaSourceError } from '../errors.js';
import type { RegisterMediaSourceInput } from '../durable-media-registry.js';
import { safeFetch, type DnsLookupFn } from '../safe-http.js';
import {
  probeAndValidateClipMp4,
  type ProbedClipMetadata,
} from '../live/highlight-clip-extractor.js';
import { FfmpegRollingSegmentBuffer } from '../live/rolling-segment-buffer.js';

export interface AuthorizedDirectMediaConfig {
  canonicalSourceId: CacheableSourceId;
  mediaUrl: string;
  title?: string;
  allowedHosts: ReadonlySet<string>;
  /** Maximum remote download size in bytes; defaults to 500 MiB. */
  maxBytes?: number;
  /** Maximum duration in seconds; defaults to 3600 (60 min). */
  maxDurationSec?: number;
  /** Per-request HTTP timeout in ms; defaults to 30_000. */
  timeoutMs?: number;
  /** Optional HLS live poll interval in ms; defaults to 1_000. */
  hlsPollIntervalMs?: number;
  /** Optional max live HLS polling runtime in ms; defaults to 300_000 (5 min). */
  hlsMaxSessionMs?: number;
  fetchImpl?: typeof fetch;
  dnsLookup?: DnsLookupFn;
  allowLocalhostForTest?: boolean;
}

export interface HlsMediaSegmentEntry {
  url: string;
  durationSec: number;
  sequence: number;
}

export function parseHlsMediaPlaylist(playlistText: string, baseUrl: string): {
  isEndList: boolean;
  targetDurationSec: number;
  mediaSequence: number;
  segments: HlsMediaSegmentEntry[];
} {
  const lines = playlistText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let isEndList = false;
  let targetDurationSec = 4;
  let mediaSequence = 0;
  let pendingDuration = 4;
  const segments: HlsMediaSegmentEntry[] = [];

  for (const line of lines) {
    if (line === '#EXT-X-ENDLIST' || line === '#EXT-X-PLAYLIST-TYPE:VOD') {
      isEndList = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const n = Number(line.split(':')[1]);
      if (Number.isFinite(n) && n > 0) targetDurationSec = n;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const n = Number(line.split(':')[1]);
      if (Number.isFinite(n) && n >= 0) mediaSequence = Math.floor(n);
    } else if (line.startsWith('#EXTINF:')) {
      const rawDur = line.slice('#EXTINF:'.length).split(',')[0];
      const n = Number(rawDur);
      if (Number.isFinite(n) && n > 0) pendingDuration = n;
    } else if (!line.startsWith('#')) {
      const resolvedUrl = new URL(line, baseUrl).toString();
      segments.push({
        url: resolvedUrl,
        durationSec: pendingDuration,
        sequence: mediaSequence + segments.length,
      });
    }
  }

  return { isEndList, targetDurationSec, mediaSequence, segments };
}

/**
 * Real, Non-Fixture Authorized Direct Media Acquisition Adapter (Step 3C.2).
 *
 * Production-ready HTTP(S) & HLS ingestion adapter for explicitly authorized media hosts:
 * - Strictly validates every initial URL, redirect hop, HLS segment URL, and DNS record
 *   via `safeFetch` (blocking SSRF, DNS rebinding, private IPs, and disallowed hosts).
 * - Streams remote VOD bytes directly to disk with hard byte ceiling (<= 500 MiB) and AbortSignal.
 * - Probes downloaded MP4s with `ffprobe` enforcing valid video/audio codecs & duration ceiling.
 * - Supports real incremental live HLS (`.m3u8`) ingestion with reconnect resilience, detecting
 *   broadcast end via `#EXT-X-ENDLIST` and feeding segments into `FfmpegRollingSegmentBuffer`.
 */
export class AuthorizedDirectMediaAdapter {
  readonly maxBytes: number;
  readonly maxDurationSec: number;

  constructor(readonly config: AuthorizedDirectMediaConfig) {
    this.maxBytes = config.maxBytes ?? 500 * 1024 * 1024;
    this.maxDurationSec = config.maxDurationSec ?? 3600;
  }

  buildMediaSourceRegistration(): RegisterMediaSourceInput {
    const isLive = this.config.canonicalSourceId.includes(':broadcast:');
    return {
      canonicalId: this.config.canonicalSourceId,
      provider: 'direct_media',
      sourceType: isLive ? 'live' : 'vod',
      identityScope: isLive ? 'IMMUTABLE_BROADCAST' : 'IMMUTABLE_VOD',
      externalId: this.config.canonicalSourceId.split(':').slice(2).join(':'),
      normalizedUrl: this.config.mediaUrl,
      availability: isLive ? 'LIVE_NOW' : 'AVAILABLE',
      metadata: {
        title: this.config.title ?? 'Authorized Direct Media',
      },
    };
  }

  /**
   * Streams an authorized remote VOD file (MP4/MOV/WebM/MKV) to a local scratch file
   * with strict SSRF/DNS/redirect validation, byte-cap enforcement, and ffprobe validation.
   */
  async acquireVodToFile(
    destPath: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ filePath: string; probed: ProbedClipMetadata }> {
    if (opts?.signal?.aborted) {
      throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Direct VOD acquisition cancelled.' });
    }

    const { response } = await safeFetch(this.config.mediaUrl, {
      method: 'GET',
      allowedHosts: this.config.allowedHosts,
      timeoutMs: this.config.timeoutMs ?? 30_000,
      maxRetries: 2,
      fetchImpl: this.config.fetchImpl,
      dnsLookup: this.config.dnsLookup,
      allowLocalhostForTest: this.config.allowLocalhostForTest,
      signal: opts?.signal,
    });

    if (!response.ok || !response.body) {
      throw new MediaSourceError({
        code: response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'SOURCE_UNAVAILABLE',
        message: `Authorized direct media download failed (HTTP ${response.status}).`,
        retryable: response.status >= 500,
      });
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > this.maxBytes) {
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: `Remote media file exceeds maximum permitted size (${Math.round(this.maxBytes / (1024 * 1024))} MB).`,
      });
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const outStream = createWriteStream(destPath);
    let totalBytes = 0;

    try {
      const reader = response.body.getReader();
      while (true) {
        if (opts?.signal?.aborted) {
          await reader.cancel().catch(() => {});
          throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Direct VOD acquisition cancelled.' });
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        totalBytes += value.byteLength;
        if (totalBytes > this.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new MediaSourceError({
            code: 'ACCESS_DENIED',
            message: `Remote media stream exceeded maximum permitted size (${Math.round(this.maxBytes / (1024 * 1024))} MB).`,
          });
        }
        await new Promise<void>((resolve, reject) => {
          outStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
      }
      await new Promise<void>((resolve, reject) => {
        outStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      outStream.destroy();
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw err;
    }

    if (totalBytes <= 0) {
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        message: 'Downloaded direct media file is empty.',
      });
    }

    let probed: ProbedClipMetadata;
    try {
      probed = await probeAndValidateClipMp4(destPath, { requireAudio: true });
    } catch (err) {
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw new MediaSourceError({
        code: 'ARTIFACT_CORRUPT',
        message: `Downloaded direct media failed FFmpeg validation: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (probed.durationSec > this.maxDurationSec) {
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw new MediaSourceError({
        code: 'ACCESS_DENIED',
        message: `Direct media duration (${Math.round(probed.durationSec)}s) exceeds free-beta ceiling (${this.maxDurationSec}s).`,
      });
    }

    return { filePath: destPath, probed };
  }

  /**
   * Real incremental live/recorded HLS (.m3u8) stream ingestion!
   *
   * Polls the authorized HLS playlist over `safeFetch`, downloads each newly published media
   * segment incrementally (handling transient disconnects/reconnects), feeds verified segments
   * into `FfmpegRollingSegmentBuffer`, invokes `onBatchIngested` after each new segment batch so
   * highlights can be detected and published BEFORE the broadcast ends, and terminates cleanly
   * once `#EXT-X-ENDLIST` arrives (or `signal` aborts).
   */
  async ingestLiveHlsIncrementally(params: {
    buffer: FfmpegRollingSegmentBuffer;
    scratchDir: string;
    onBatchIngested?: (info: {
      totalSegmentsIngested: number;
      latestBufferedSec: number;
      ended: boolean;
    }) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<{
    totalSegmentsIngested: number;
    endedNormally: boolean;
    reconnectCount: number;
  }> {
    const pollMs = this.config.hlsPollIntervalMs ?? 500;
    const maxSessionMs = this.config.hlsMaxSessionMs ?? 300_000;
    const deadlineMs = Date.now() + maxSessionMs;

    const seenUrls = new Set<string>();
    let totalSegmentsIngested = 0;
    let cumulativeDurationSec = 0;
    let totalBytesDownloaded = 0;
    let consecutiveErrors = 0;
    let reconnectCount = 0;
    let endedNormally = false;

    await fs.mkdir(params.scratchDir, { recursive: true });

    while (Date.now() < deadlineMs) {
      if (params.signal?.aborted) {
        throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Live HLS ingestion cancelled.' });
      }

      try {
        const { response, finalUrl } = await safeFetch(this.config.mediaUrl, {
          method: 'GET',
          allowedHosts: this.config.allowedHosts,
          timeoutMs: this.config.timeoutMs ?? 10_000,
          maxRetries: 1,
          fetchImpl: this.config.fetchImpl,
          dnsLookup: this.config.dnsLookup,
          allowLocalhostForTest: this.config.allowLocalhostForTest,
          signal: params.signal,
        });

        if (!response.ok) {
          throw new MediaSourceError({
            code: 'SOURCE_UNAVAILABLE',
            message: `Live HLS playlist returned HTTP ${response.status}.`,
            retryable: response.status >= 500,
          });
        }

        const playlistText = await response.text();
        if (!playlistText.includes('#EXTM3U')) {
          throw new MediaSourceError({
            code: 'ARTIFACT_CORRUPT',
            message: 'Live HLS endpoint returned invalid playlist content.',
          });
        }

        const parsed = parseHlsMediaPlaylist(playlistText, finalUrl);
        consecutiveErrors = 0;

        let newInTick = 0;
        for (const seg of parsed.segments) {
          if (seenUrls.has(seg.url)) continue;
          if (params.signal?.aborted) {
            throw new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Live HLS ingestion cancelled.' });
          }

          const { response: segRes } = await safeFetch(seg.url, {
            method: 'GET',
            allowedHosts: this.config.allowedHosts,
            timeoutMs: this.config.timeoutMs ?? 15_000,
            maxRetries: 1,
            fetchImpl: this.config.fetchImpl,
            dnsLookup: this.config.dnsLookup,
            allowLocalhostForTest: this.config.allowLocalhostForTest,
            signal: params.signal,
          });
          if (!segRes.ok) {
            throw new MediaSourceError({
              code: 'SOURCE_UNAVAILABLE',
              message: `HLS segment fetch failed (HTTP ${segRes.status}).`,
              retryable: segRes.status >= 500,
            });
          }

          const segBytes = Buffer.from(await segRes.arrayBuffer());
          totalBytesDownloaded += segBytes.length;
          if (totalBytesDownloaded > this.maxBytes) {
            throw new MediaSourceError({
              code: 'ACCESS_DENIED',
              message: 'Live HLS ingestion exceeded free-beta byte limit.',
            });
          }

          const ext = path.posix.extname(new URL(seg.url).pathname) || '.mp4';
          const segFile = path.join(params.scratchDir, `hls_seg_${totalSegmentsIngested}${ext}`);
          await fs.writeFile(segFile, segBytes);
          const registered = await params.buffer.appendIncomingSegment({
            index: totalSegmentsIngested,
            sourceFilePath: segFile,
            expectedStartSec: cumulativeDurationSec,
          });
          cumulativeDurationSec += registered.valid && registered.durationSec > 0 ? registered.durationSec : seg.durationSec;

          seenUrls.add(seg.url);
          totalSegmentsIngested++;
          newInTick++;
        }

        if (parsed.isEndList) {
          params.buffer.markEndOfStream();
          endedNormally = true;
        }

        if ((newInTick > 0 || parsed.isEndList) && params.onBatchIngested) {
          await params.onBatchIngested({
            totalSegmentsIngested,
            latestBufferedSec: params.buffer.getLatestBufferedSec(),
            ended: parsed.isEndList,
          });
        }

        if (parsed.isEndList) {
          break;
        }
      } catch (err) {
        if (
          err instanceof MediaSourceError &&
          (err.code === 'REQUEST_CANCELLED' ||
            err.code === 'SSRF_BLOCKED' ||
            err.code === 'PRIVATE_NETWORK_BLOCKED' ||
            err.code === 'ACCESS_DENIED')
        ) {
          throw err;
        }
        consecutiveErrors++;
        reconnectCount++;
        if (consecutiveErrors > 5) {
          throw new MediaSourceError({
            code: 'SOURCE_UNAVAILABLE',
            message: `Live HLS stream disconnected after ${consecutiveErrors} reconnect attempts.`,
            retryable: true,
            cause: err,
          });
        }
      }

      await new Promise<void>((resolve, reject) => {
        if (params.signal?.aborted) {
          reject(new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Live HLS ingestion cancelled.' }));
          return;
        }
        const onAbort = () => {
          clearTimeout(t);
          reject(new MediaSourceError({ code: 'REQUEST_CANCELLED', message: 'Live HLS ingestion cancelled.' }));
        };
        const t = setTimeout(() => {
          params.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, pollMs);
        params.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    return { totalSegmentsIngested, endedNormally, reconnectCount };
  }
}
