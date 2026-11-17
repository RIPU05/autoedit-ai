import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface VerificationOptions {
  sourcePath?: string;
  outputPath?: string;
  expectedSourceHash?: string;
  format?: 'reel' | 'short' | 'landscape';
  minDurationSec?: number;
  maxDurationSec?: number;
}

export interface VerificationResult {
  ok: boolean;
  source: {
    path: string;
    sizeBytes: number;
    sha256: string;
    durationSec: number;
    width: number;
    height: number;
    videoCodec: string;
    audioCodec: string;
  };
  output: {
    path: string;
    sizeBytes: number;
    sha256: string;
    durationSec: number;
    width: number;
    height: number;
    videoCodec: string;
    audioCodec: string;
  };
  checks: {
    sourceIntegrityPreserved: boolean;
    outputNonEmpty: boolean;
    validCodecs: boolean;
    expectedResolution: boolean;
    observableTrimming: boolean;
  };
  errors: string[];
}

export function sha256(file: string): string {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

export async function ffprobeAsync(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      args[key] = val !== undefined ? val : 'true';
    }
  }
  return args;
}

export async function verifyMediaOutput(opts: VerificationOptions = {}): Promise<VerificationResult> {
  const args = parseArgs();
  const candidateSources = [
    path.resolve(process.cwd(), 'apps/api/tmp/e2e-source-sample.mp4'),
    path.resolve(process.cwd(), 'tmp/e2e-source-sample.mp4'),
    path.resolve(__dirname, '../tmp/e2e-source-sample.mp4'),
  ];
  const defaultSource = candidateSources.find((p) => fs.existsSync(p)) || candidateSources[0];

  const sourcePath =
    opts.sourcePath ||
    args.source ||
    args.sourcePath ||
    process.env.E2E_SOURCE_PATH ||
    defaultSource;

  const outputPath =
    opts.outputPath ||
    args.output ||
    args.outputPath ||
    process.env.E2E_OUTPUT_PATH ||
    'C:\\autoedit-local-work\\e2e-downloaded-reel.mp4';

  const expectedSourceHash =
    opts.expectedSourceHash ||
    args.expectedSourceHash ||
    process.env.E2E_EXPECTED_SOURCE_HASH;

  const targetFormat = opts.format || (args.format as 'reel' | 'short' | 'landscape') || 'reel';

  const errors: string[] = [];

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source video not found: ${sourcePath}`);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Rendered output not found: ${outputPath}`);
  }

  const sourceStat = fs.statSync(sourcePath);
  const outputStat = fs.statSync(outputPath);
  const sourceHash = sha256(sourcePath);
  const outputHash = sha256(outputPath);

  const sourceMeta = await ffprobeAsync(sourcePath);
  const outputMeta = await ffprobeAsync(outputPath);

  const sourceVideo = sourceMeta.streams.find((s: any) => s.codec_type === 'video');
  const sourceAudio = sourceMeta.streams.find((s: any) => s.codec_type === 'audio');
  const outputVideo = outputMeta.streams.find((s: any) => s.codec_type === 'video');
  const outputAudio = outputMeta.streams.find((s: any) => s.codec_type === 'audio');

  const sourceDuration = Number(sourceMeta.format?.duration ?? 0);
  const outputDuration = Number(outputMeta.format?.duration ?? 0);

  // Check 1: Source integrity
  let sourceIntegrityPreserved = true;
  if (expectedSourceHash && sourceHash !== expectedSourceHash.toUpperCase()) {
    sourceIntegrityPreserved = false;
    errors.push(`Source hash mismatch: expected ${expectedSourceHash}, got ${sourceHash}`);
  }

  // Check 2: Output non-empty
  const outputNonEmpty = outputStat.size > 1000;
  if (!outputNonEmpty) {
    errors.push(`Rendered output file too small: ${outputStat.size} bytes`);
  }

  // Check 3: Valid Codecs
  const validCodecs = outputVideo?.codec_name === 'h264' && outputAudio?.codec_name === 'aac';
  if (!validCodecs) {
    errors.push(`Invalid codecs: video=${outputVideo?.codec_name}, audio=${outputAudio?.codec_name}`);
  }

  // Check 4: Expected resolution
  const expectedWidth = targetFormat === 'landscape' ? 1280 : 1080;
  const expectedHeight = targetFormat === 'landscape' ? 720 : 1920;
  const expectedResolution = outputVideo?.width === expectedWidth && outputVideo?.height === expectedHeight;
  if (!expectedResolution) {
    errors.push(
      `Unexpected resolution: ${outputVideo?.width}x${outputVideo?.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }

  // Check 5: Observable trimming
  // The output should be trimmed shorter than source when silences are removed
  const observableTrimming = outputDuration > 0 && outputDuration < sourceDuration;
  if (!observableTrimming) {
    errors.push(`No trimming observed: outputDuration=${outputDuration}s, sourceDuration=${sourceDuration}s`);
  }

  const ok = errors.length === 0;

  return {
    ok,
    source: {
      path: sourcePath,
      sizeBytes: sourceStat.size,
      sha256: sourceHash,
      durationSec: sourceDuration,
      width: sourceVideo?.width ?? 0,
      height: sourceVideo?.height ?? 0,
      videoCodec: sourceVideo?.codec_name ?? 'none',
      audioCodec: sourceAudio?.codec_name ?? 'none',
    },
    output: {
      path: outputPath,
      sizeBytes: outputStat.size,
      sha256: outputHash,
      durationSec: outputDuration,
      width: outputVideo?.width ?? 0,
      height: outputVideo?.height ?? 0,
      videoCodec: outputVideo?.codec_name ?? 'none',
      audioCodec: outputAudio?.codec_name ?? 'none',
    },
    checks: {
      sourceIntegrityPreserved,
      outputNonEmpty,
      validCodecs,
      expectedResolution,
      observableTrimming,
    },
    errors,
  };
}

async function main() {
  console.log('=== Step 2D: Media Asset & Trimming Verification ===');
  console.log('(Note: This script verifies media assets only. Run "npm run test:e2e" for full browser automation)\n');

  try {
    const result = await verifyMediaOutput();
    console.log(`Source Video: ${result.source.path}`);
    console.log(`  Size: ${result.source.sizeBytes} bytes, Duration: ${result.source.durationSec}s`);
    console.log(`  Format: ${result.source.width}x${result.source.height}, Codec: ${result.source.videoCodec}/${result.source.audioCodec}`);
    console.log(`  SHA-256: ${result.source.sha256}`);

    console.log(`\nRendered Video: ${result.output.path}`);
    console.log(`  Size: ${result.output.sizeBytes} bytes, Duration: ${result.output.durationSec}s`);
    console.log(`  Format: ${result.output.width}x${result.output.height}, Codec: ${result.output.videoCodec}/${result.output.audioCodec}`);
    console.log(`  SHA-256: ${result.output.sha256}`);

    console.log('\n--- Verification Checks ---');
    console.log(`[CHECK] Source Integrity: ${result.checks.sourceIntegrityPreserved ? 'PASS' : 'FAIL'}`);
    console.log(`[CHECK] Output Non-Empty: ${result.checks.outputNonEmpty ? 'PASS' : 'FAIL'}`);
    console.log(`[CHECK] Valid Codecs (H.264/AAC): ${result.checks.validCodecs ? 'PASS' : 'FAIL'}`);
    console.log(`[CHECK] Vertical Resolution (1080x1920): ${result.checks.expectedResolution ? 'PASS' : 'FAIL'}`);
    console.log(`[CHECK] Observable Silence Trimming (${result.output.durationSec}s < ${result.source.durationSec}s): ${result.checks.observableTrimming ? 'PASS' : 'FAIL'}`);

    if (!result.ok) {
      console.error('\nVerification Errors:');
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exit(1);
    }

    console.log('\n✓ Asset verification PASSED: Media characteristics, resolution, and trimming confirmed.');
  } catch (err: any) {
    console.error('Verification failed:', err.message);
    process.exit(1);
  }
}

main();
