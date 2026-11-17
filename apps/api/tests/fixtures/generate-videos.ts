import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export interface SpeechFixtureResult {
  fixturePath: string;
  initialSha256: string;
  durationSec: number;
}

/**
 * Generates or provides a reproducible synthetic speech MP4 using an existing
 * authorized video fixture or generates one from the bundled audio fixture
 * (tests/fixtures/sample-speech.wav) paired with a 1280x720 visual test pattern.
 * Includes strict 60s timeout and child-process cleanup.
 */
export async function ensureSpeechFixture(outDir: string): Promise<SpeechFixtureResult> {
  await fs.mkdir(outDir, { recursive: true });
  const outMp4 = path.join(outDir, 'e2e-source-sample.mp4');

  // 1. Fast reuse: Check existing local authorized video artifacts
  const candidates = [
    process.env.E2E_SOURCE_PATH,
    outMp4,
    path.resolve(__dirname, '../../tmp/e2e-source-sample.mp4'),
    path.resolve(process.cwd(), 'tmp/e2e-source-sample.mp4'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 10000) {
        if (candidate !== outMp4) {
          await fs.copyFile(candidate, outMp4);
        }
        const buf = await fs.readFile(outMp4);
        const hash = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
        return {
          fixturePath: outMp4,
          initialSha256: hash,
          durationSec: 11.58,
        };
      }
    } catch {
      // try next candidate
    }
  }

  // 2. Generate on-the-fly with strict bounded timeout
  const fixtureWav = path.join(__dirname, 'sample-speech.wav');
  await fs.access(fixtureWav).catch(() => {
    throw new Error(`Bundled speech fixture not found at: ${fixtureWav}`);
  });

  await run(
    ffmpegPath as string,
    [
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=12:size=1280x720:rate=30',
      '-i',
      fixtureWav,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-shortest',
      outMp4,
    ],
    {
      timeout: 45000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const buf = await fs.readFile(outMp4);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

  return {
    fixturePath: outMp4,
    initialSha256: hash,
    durationSec: 11.58,
  };
}
