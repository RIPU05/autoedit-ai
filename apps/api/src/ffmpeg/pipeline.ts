import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { promises as fs } from 'node:fs';
import path from 'node:path';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

// ─── Edit plan types (stored as EditTimeline.operations / .effects in DB) ─────

export interface KeepSegment {
  start: number;
  end: number;
  // optional kenburns/zoom on this segment: scale factor at end (1 = none)
  zoom?: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export type OutputFormat = 'reel' | 'short' | 'landscape';

export interface EditPlan {
  source: string; // local path to source video
  keep: KeepSegment[]; // ordered segments to keep (silence already trimmed out)
  captions: CaptionCue[];
  transition?: 'fade' | 'none'; // between kept segments
  musicPath?: string; // local path to bg music
  musicVolume?: number; // 0..1
  format: OutputFormat;
}

const CROSSFADE_SEC = 0.25;

const ASPECT: Record<OutputFormat, { w: number; h: number }> = {
  reel: { w: 1080, h: 1920 },
  short: { w: 1080, h: 1920 },
  landscape: { w: 1920, h: 1080 },
};

/** Build an SRT file from caption cues for burned-in subtitles. */
async function writeSrt(captions: CaptionCue[], dir: string): Promise<string> {
  const fmt = (s: number) => {
    const ms = Math.floor((s % 1) * 1000);
    const total = Math.floor(s);
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
  };
  const body = captions
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`)
    .join('\n');
  const file = path.join(dir, 'captions.srt');
  await fs.writeFile(file, body, 'utf8');
  return file;
}

function captionsForRenderedTimeline(captions: CaptionCue[], keep: KeepSegment[], overlapSec: number) {
  const mapped: CaptionCue[] = [];
  let outputStart = 0;

  for (const seg of keep) {
    const segDuration = Math.max(0.1, seg.end - seg.start);
    for (const caption of captions) {
      const start = Math.max(caption.start, seg.start);
      const end = Math.min(caption.end, seg.end);
      if (end <= start) continue;
      mapped.push({
        start: outputStart + (start - seg.start),
        end: outputStart + (end - seg.start),
        text: caption.text,
      });
    }
    outputStart += Math.max(0.1, segDuration - overlapSec);
  }

  return mapped.filter((caption) => caption.end - caption.start > 0.05);
}

function concatFileLine(filePath: string) {
  return `file '${path.resolve(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

async function hardConcat(clipPaths: string[], workDir: string, outputName = 'concat.mp4') {
  const concatList = path.resolve(workDir, `${outputName}.txt`);
  await fs.writeFile(concatList, clipPaths.map(concatFileLine).join('\n'));
  const concatOut = path.resolve(workDir, outputName);
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(concatList)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .on('end', () => resolve())
      .on('error', reject)
      .save(concatOut);
  });
  return concatOut;
}

async function crossfadeConcat(clipPaths: string[], durations: number[], workDir: string) {
  if (clipPaths.length < 2) throw new Error('crossfade requires multiple clips');
  if (durations.some((duration) => duration < CROSSFADE_SEC * 3)) {
    throw new Error('clips too short for crossfade');
  }

  const out = path.join(workDir, 'concat_xfade.mp4');
  const cmd = ffmpeg();
  for (const clipPath of clipPaths) cmd.input(clipPath);

  const filters: string[] = [];
  let videoIn = '[0:v]';
  let audioIn = '[0:a]';
  let accumulated = durations[0];

  for (let i = 1; i < clipPaths.length; i++) {
    const videoOut = i === clipPaths.length - 1 ? '[v]' : `[v${i}]`;
    const audioOut = i === clipPaths.length - 1 ? '[a]' : `[a${i}]`;
    const offset = Math.max(0, accumulated - CROSSFADE_SEC);
    filters.push(`${videoIn}[${i}:v]xfade=transition=fade:duration=${CROSSFADE_SEC}:offset=${offset.toFixed(3)}${videoOut}`);
    filters.push(`${audioIn}[${i}:a]acrossfade=d=${CROSSFADE_SEC}:c1=tri:c2=tri${audioOut}`);
    videoIn = videoOut;
    audioIn = audioOut;
    accumulated += durations[i] - CROSSFADE_SEC;
  }

  await new Promise<void>((resolve, reject) => {
    cmd
      .complexFilter(filters)
      .outputOptions(['-map [v]', '-map [a]', '-c:v libx264', '-preset veryfast', '-crf 20', '-c:a aac', '-ar 48000'])
      .on('end', () => resolve())
      .on('error', reject)
      .save(out);
  });
  return out;
}

async function hasAudioStream(filePath: string) {
  return new Promise<boolean>((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve(false);
      resolve(data.streams.some((stream) => stream.codec_type === 'audio'));
    });
  });
}

async function mediaDurationSec(filePath: string) {
  return new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

async function prepareMusicBed(musicPath: string, volume: number, durationSec: number, workDir: string) {
  const out = path.join(workDir, 'music_bed.m4a');
  await new Promise<void>((resolve, reject) => {
    ffmpeg(musicPath)
      .inputOptions(['-stream_loop -1'])
      .duration(durationSec)
      .audioFilters(`volume=${volume}`)
      .outputOptions(['-c:a aac', '-ar 48000', '-ac 2'])
      .on('end', () => resolve())
      .on('error', reject)
      .save(out);
  });
  return out;
}

/**
 * Render the edit. Strategy:
 *  1. Cut each kept segment to its own normalized clip (re-encoded so concat is clean),
 *     applying per-segment zoom and fitting to the target aspect ratio.
 *  2. Concat the clips (with optional crossfades).
 *  3. Burn in subtitles and mix background music.
 *
 * progress(0..100) is called as work advances so the worker can persist Render.progress.
 */
export async function renderEdit(
  plan: EditPlan,
  workDir: string,
  progress: (pct: number) => void,
): Promise<string> {
  await fs.mkdir(workDir, { recursive: true });
  const { w, h } = ASPECT[plan.format];
  const clipPaths: string[] = [];
  const clipDurations: number[] = [];

  // 1. cut + normalize each kept segment
  for (let i = 0; i < plan.keep.length; i++) {
    const seg = plan.keep[i];
    const out = path.join(workDir, `clip_${i}.mp4`);
    const dur = Math.max(0.1, seg.end - seg.start);

    // scale to cover, crop to exact aspect, optional slow zoom (Ken Burns)
    const zoom = seg.zoom && seg.zoom > 1 ? seg.zoom : 1;
    const fps = 30;
    const zoomExpr =
      zoom > 1
        ? `,zoompan=z='min(zoom+0.0015,${zoom})':d=${Math.round(dur * fps)}:s=${w}x${h}:fps=${fps}`
        : '';
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}${zoomExpr},setsar=1`;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(plan.source)
        .setStartTime(seg.start)
        .setDuration(dur)
        .videoFilters(vf)
        .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 20', '-c:a aac', '-ar 48000'])
        .on('end', () => resolve())
        .on('error', reject)
        .save(out);
    });
    clipPaths.push(out);
    clipDurations.push(dur);
    progress(Math.round(((i + 1) / plan.keep.length) * 50)); // first half = cutting
  }

  // 2. concat
  let concatOut: string;
  let appliedCrossfade = false;
  if (plan.transition === 'fade') {
    try {
      concatOut = await crossfadeConcat(clipPaths, clipDurations, workDir);
      appliedCrossfade = true;
      console.log(JSON.stringify({ level: 'info', msg: 'render.crossfade.applied', clips: clipPaths.length, durationSec: CROSSFADE_SEC }));
    } catch (err) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'render.crossfade.skipped', reason: err instanceof Error ? err.message : String(err) }));
      concatOut = await hardConcat(clipPaths, workDir);
    }
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'render.crossfade.skipped', reason: 'disabled' }));
    concatOut = await hardConcat(clipPaths, workDir);
  }
  progress(70);

  // 3. subtitles + music
  const renderedCaptions = captionsForRenderedTimeline(plan.captions, plan.keep, appliedCrossfade ? CROSSFADE_SEC : 0);
  const srt = renderedCaptions.length > 0 ? await writeSrt(renderedCaptions, workDir) : undefined;
  const finalOut = path.join(workDir, `final_${plan.format}.mp4`);
  const concatHasAudio = await hasAudioStream(concatOut);
  let musicBed: string | undefined;

  if (plan.musicPath) {
    try {
      const durationSec = await mediaDurationSec(concatOut);
      musicBed = await prepareMusicBed(plan.musicPath, plan.musicVolume ?? 0.1, durationSec, workDir);
    } catch (err) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'render.music.skipped', reason: err instanceof Error ? err.message : String(err) }));
    }
  }

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(concatOut);
    // burn-in subtitles (escape path for the subtitles filter)
    const subPath = srt?.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const videoFilter = subPath
      ? `subtitles='${subPath}':force_style='FontName=Arial,FontSize=20,Outline=2,Shadow=1,Alignment=2'`
      : undefined;

    if (musicBed) {
      cmd.input(musicBed);
      if (concatHasAudio) {
        const filters = [`[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]`];
        if (videoFilter) filters.unshift(`[0:v]${videoFilter}[v]`);
        cmd
          .complexFilter(filters)
          .outputOptions([videoFilter ? '-map [v]' : '-map 0:v', '-map [a]', '-shortest']);
      } else {
        const filters = ['[1:a]anull[a]'];
        if (videoFilter) filters.unshift(`[0:v]${videoFilter}[v]`);
        cmd
          .complexFilter(filters)
          .outputOptions([videoFilter ? '-map [v]' : '-map 0:v', '-map [a]', '-shortest']);
      }
      console.log(JSON.stringify({ level: 'info', msg: 'render.music.applied', volume: plan.musicVolume ?? 0.1 }));
    } else {
      if (videoFilter) cmd.videoFilters(videoFilter);
      console.log(JSON.stringify({ level: 'info', msg: 'render.music.skipped', reason: 'disabled or unavailable' }));
    }

    cmd
      .outputOptions(['-c:v libx264', '-preset medium', '-crf 20', '-c:a aac', '-movflags +faststart'])
      .on('progress', (p) => {
        if (p.percent) progress(70 + Math.min(29, Math.round(p.percent * 0.29)));
      })
      .on('end', () => resolve())
      .on('error', reject)
      .save(finalOut);
  });

  progress(100);
  return finalOut;
}

/**
 * Derive an EditPlan from the analysis + approved timeline.
 * Removes silences by keeping only the spoken spans, sorted, and clamps to highlights
 * when the user asked for a short-form output.
 */
export function buildKeepSegments(
  durationSec: number,
  silences: { start: number; end: number }[],
  opts: { highlightsOnly?: { start: number; end: number }[]; maxDurationSec?: number } = {},
): KeepSegment[] {
  if (opts.highlightsOnly?.length) {
    return opts.highlightsOnly.map((h) => ({ start: h.start, end: h.end, zoom: 1.08 }));
  }
  // invert silences -> spoken spans
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const keep: KeepSegment[] = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor) keep.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < durationSec) keep.push({ start: cursor, end: durationSec });
  return keep.filter((k) => k.end - k.start > 0.3);
}
