import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type { VideoMeta, SilenceSegment } from '../services/claude.service.js';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

/** Probe technical metadata for the source video. */
export function probe(filePath: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const v = data.streams.find((s) => s.codec_type === 'video');
      const [num, den] = (v?.r_frame_rate ?? '30/1').split('/').map(Number);
      resolve({
        durationSec: data.format.duration ?? 0,
        width: v?.width ?? 0,
        height: v?.height ?? 0,
        fps: den ? num / den : 30,
      });
    });
  });
}

/** True when the media has at least one audio stream. */
export function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve(false);
      resolve(data.streams.some((s) => s.codec_type === 'audio'));
    });
  });
}

/**
 * Detect silent segments using FFmpeg's silencedetect filter.
 * Returns gaps where audio stays below `thresholdDb` for at least `minSilenceSec`.
 */
export function detectSilences(
  filePath: string,
  thresholdDb = -30,
  minSilenceSec = 0.6,
): Promise<SilenceSegment[]> {
  return new Promise((resolve, reject) => {
    const silences: SilenceSegment[] = [];
    let pendingStart: number | null = null;

    ffmpeg(filePath)
      .audioFilters(`silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`)
      .format('null')
      .on('stderr', (line: string) => {
        const startMatch = line.match(/silence_start:\s*([\d.]+)/);
        const endMatch = line.match(/silence_end:\s*([\d.]+)/);
        if (startMatch) pendingStart = parseFloat(startMatch[1]);
        if (endMatch && pendingStart !== null) {
          silences.push({ start: pendingStart, end: parseFloat(endMatch[1]) });
          pendingStart = null;
        }
      })
      .on('end', () => resolve(silences))
      .on('error', reject)
      .saveToFile('/dev/null');
  });
}

/** Extract a mono 16kHz WAV for transcription. */
export function extractAudio(filePath: string, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .save(outPath);
  });
}
