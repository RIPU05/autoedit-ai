import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { promises as fs } from 'node:fs';
import path from 'node:path';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

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
    progress(Math.round(((i + 1) / plan.keep.length) * 50)); // first half = cutting
  }

  // 2. concat
  const concatList = path.join(workDir, 'concat.txt');
  await fs.writeFile(concatList, clipPaths.map((p) => `file '${p}'`).join('\n'));
  const concatOut = path.join(workDir, 'concat.mp4');
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(concatList)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .on('end', () => resolve())
      .on('error', reject)
      .save(concatOut);
  });
  progress(70);

  // 3. subtitles + music
  const srt = await writeSrt(plan.captions, workDir);
  const finalOut = path.join(workDir, `final_${plan.format}.mp4`);

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(concatOut);
    // burn-in subtitles (escape path for the subtitles filter)
    const subPath = srt.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    let videoFilter =
      `subtitles='${subPath}':force_style='FontName=Arial,FontSize=20,Outline=2,Shadow=1,Alignment=2'`;

    if (plan.musicPath) {
      cmd
        .input(plan.musicPath)
        .complexFilter([
          `[0:v]${videoFilter}[v]`,
          `[1:a]volume=${plan.musicVolume ?? 0.15}[bg]`,
          `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        ])
        .outputOptions(['-map [v]', '-map [a]', '-shortest']);
    } else {
      cmd.videoFilters(videoFilter);
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
