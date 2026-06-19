import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

export interface Scenario {
  name: string;
  seconds: number;
}

export const SCENARIOS: Scenario[] = [
  { name: '30s-clip', seconds: 30 },
  { name: '5min-talk', seconds: 5 * 60 },
  { name: '30min-podcast', seconds: 30 * 60 },
  { name: '1h-podcast', seconds: 60 * 60 },
];

/**
 * Generate a synthetic video with a test pattern + a tone that pulses (so there
 * are detectable "silences" between beeps). Cheap to produce at any duration.
 */
export async function generateFixture(seconds: number, outDir: string): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `fixture_${seconds}s.mp4`);
  try {
    await fs.access(out);
    return out; // cached
  } catch {
    /* generate below */
  }
  await run(ffmpegPath as string, [
    '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=30:duration=${seconds}`,
    // tone that beeps every 5s (silence in between → exercises silencedetect)
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-af', 'volume=0.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', out,
  ]);
  return out;
}
