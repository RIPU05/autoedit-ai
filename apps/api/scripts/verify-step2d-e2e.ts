import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';

ffmpeg.setFfprobePath(ffprobeStatic.path);

const SOURCE_VIDEO = fs.existsSync(path.resolve('apps/api/tmp/e2e-source-sample.mp4'))
  ? path.resolve('apps/api/tmp/e2e-source-sample.mp4')
  : path.resolve('tmp/e2e-source-sample.mp4');
const RENDERED_OUTPUT = 'C:\\autoedit-local-work\\e2e-downloaded-reel.mp4';
const EXPECTED_SOURCE_HASH = '01ABEB057B280E394BE24E63427651B53D26A64C779C24AE42C68461742318AB';

function sha256(file: string): string {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

async function ffprobeAsync(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

async function main() {
  console.log('=== Step 2D: End-to-End Asset Verification ===');

  if (!fs.existsSync(SOURCE_VIDEO)) {
    throw new Error(`Source video not found: ${SOURCE_VIDEO}`);
  }
  const currentSourceHash = sha256(SOURCE_VIDEO);
  console.log(`Source SHA-256: ${currentSourceHash}`);
  if (currentSourceHash !== EXPECTED_SOURCE_HASH) {
    throw new Error(`Source hash altered! Expected: ${EXPECTED_SOURCE_HASH}, Got: ${currentSourceHash}`);
  }
  console.log('✓ Source file integrity verified: SHA-256 unchanged');

  if (!fs.existsSync(RENDERED_OUTPUT)) {
    throw new Error(`Rendered output not found: ${RENDERED_OUTPUT}`);
  }
  const outputStat = fs.statSync(RENDERED_OUTPUT);
  const outputHash = sha256(RENDERED_OUTPUT);
  console.log(`Rendered Output: ${RENDERED_OUTPUT}`);
  console.log(`Size: ${outputStat.size} bytes`);
  console.log(`SHA-256: ${outputHash}`);

  const metadata = await ffprobeAsync(RENDERED_OUTPUT);
  const videoStream = metadata.streams.find((s: any) => s.codec_type === 'video');
  const audioStream = metadata.streams.find((s: any) => s.codec_type === 'audio');

  console.log('\n--- Rendered Stream Characteristics ---');
  console.log(`Container Duration: ${metadata.format.duration}s`);
  console.log(`Video Codec: ${videoStream?.codec_name}`);
  console.log(`Dimensions: ${videoStream?.width}x${videoStream?.height}`);
  console.log(`Aspect Ratio: ${videoStream?.width === 1080 && videoStream?.height === 1920 ? '9:16 (Vertical Reel)' : 'other'}`);
  console.log(`Audio Codec: ${audioStream?.codec_name} (${audioStream?.sample_rate} Hz)`);

  if (videoStream?.width !== 1080 || videoStream?.height !== 1920) {
    throw new Error(`Unexpected video dimensions: ${videoStream?.width}x${videoStream?.height}, expected 1080x1920`);
  }

  console.log('\n✓ Step 2D Real Browser E2E Pipeline Verification is COMPLETE and VALIDATED.');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
