import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { SCENARIOS, generateFixture } from '../fixtures/generate-videos.js';
import { probe, detectSilences } from '../../src/ffmpeg/probe.js';
import { renderEdit, buildKeepSegments, type EditPlan } from '../../src/ffmpeg/pipeline.js';

/**
 * Real FFmpeg pipeline validation across the four scenarios.
 *
 *   Upload(fixture) → Probe → Silence-detect → (mock analyze) → Timeline → Render
 *
 * Gated behind RUN_E2E=1 because generating + rendering a 1h video is slow.
 * The transcription + Claude stages are represented by a mocked timeline so the
 * test stays hermetic (no network); swap in the live services for full E2E.
 *
 *   RUN_E2E=1 npm test
 */
const RUN = process.env.RUN_E2E === '1';
const workRoot = path.join(os.tmpdir(), 'autoedit-e2e');

describe.skipIf(!RUN)('pipeline scenarios', () => {
  beforeAll(async () => {
    await fs.mkdir(workRoot, { recursive: true });
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: probe + silence + render`, async () => {
      const dir = path.join(workRoot, scenario.name);
      const fixture = await generateFixture(scenario.seconds, dir);

      // PROBE
      const meta = await probe(fixture);
      expect(meta.durationSec).toBeGreaterThan(scenario.seconds * 0.9);
      expect(meta.width).toBe(1280);

      // SILENCE DETECT
      const silences = await detectSilences(fixture);
      expect(Array.isArray(silences)).toBe(true);

      // MOCK ANALYZE → TIMELINE (keep first ~3 short spans for a quick render)
      const keep = buildKeepSegments(meta.durationSec, silences).slice(0, 3);
      const usable = keep.length ? keep : [{ start: 0, end: Math.min(10, meta.durationSec) }];

      // RENDER (short output so the 1h case still finishes quickly)
      const plan: EditPlan = {
        source: fixture,
        keep: usable.map((k) => ({ start: k.start, end: Math.min(k.end, k.start + 4) })),
        captions: [{ start: 0, end: 2, text: 'test caption' }],
        transition: 'none',
        format: 'reel',
      };
      let lastPct = 0;
      const out = await renderEdit(plan, path.join(dir, 'render'), (p) => (lastPct = p));
      const stat = await fs.stat(out);

      expect(stat.size).toBeGreaterThan(1000);
      expect(lastPct).toBe(100);
    });
  }
});
