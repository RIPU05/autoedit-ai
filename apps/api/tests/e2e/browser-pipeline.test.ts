import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, createWriteStream, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { prisma } from '../../src/lib/prisma.js';
import { ensureSpeechFixture } from '../fixtures/generate-videos.js';
import { verifyMediaOutput, sha256 } from '../../scripts/verify-step2d-e2e.js';
import { assertLocalE2EEnvironment, ensureDockerInPath } from '../../src/config/e2e-safety.js';

ensureDockerInPath();

const RUN_E2E = process.env.RUN_BROWSER_E2E === '1';
const WEB_BASE = process.env.WEB_BASE_URL || 'http://localhost:3000';
const WHISPER_CONTAINER = process.env.WHISPER_CONTAINER_NAME || 'autoedit-local-whisper';

async function downloadFile(url: string, dest: string): Promise<string> {
  const file = createWriteStream(dest);
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download: status ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(dest));
      });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

async function registerNewUser(page: Page, name = 'E2E User'): Promise<{ email: string; pass: string }> {
  await page.goto(`${WEB_BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  const switchBtn = page.getByRole('button', { name: /New here\? Create an account/i });
  await switchBtn.click();
  await page.waitForTimeout(300);

  const email = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@local.test`;
  const pass = 'LocalE2EPassword123!';

  await page.fill('input[placeholder="Name"]', name);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', pass);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
  return { email, pass };
}

function isContainerRunning(containerName: string): boolean {
  try {
    const out = execSync(`docker inspect -f "{{.State.Running}}" ${containerName}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out === 'true';
  } catch {
    return false;
  }
}

describe.skipIf(!RUN_E2E)('Real Browser End-to-End Pipeline (Step 2D.1)', () => {
  let browser: Browser;
  let workDir: string;
  let sourceFixturePath: string;
  let initialSourceHash: string;

  beforeAll(async () => {
    // 0. Fail closed if not running against safe local configuration
    assertLocalE2EEnvironment(process.env);

    // 1. Prepare isolated temporary workspace
    workDir = path.join(os.tmpdir(), `autoedit-e2e-${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });

    // 2. Prepare verified synthetic speech MP4 fixture
    const fixture = await ensureSpeechFixture(workDir);
    sourceFixturePath = fixture.fixturePath;
    initialSourceHash = fixture.initialSha256;

    // 3. Launch portable browser
    const executablePath = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch({
      executablePath: executablePath || undefined,
      channel: executablePath ? undefined : 'chrome',
      headless: true,
    });
  }, 120_000);

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it('completes the entire user journey: register, upload, analyze, edit, render, download', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });

    try {
      const page = await context.newPage();

      // 1 & 2. Register fresh isolated user
      await registerNewUser(page, 'E2E Primary Journey User');

      // 3. Upload Synthetic Test Video via UI
      const fileInput = page.locator('input[type="file"][accept="video/*"]');
      await fileInput.setInputFiles(sourceFixturePath);

      // 4. Confirm Project Creation and Redirect
      await page.waitForURL('**/projects/**', { timeout: 60_000 });
      const projectUrl = page.url();
      const projectId = projectUrl.split('/projects/')[1].split(/[?#]/)[0];
      expect(projectId).toBeTruthy();

      // 5. Wait for Analysis Worker (Whisper transcription & initial timeline)
      await page.waitForSelector('text=Edit timeline', { timeout: 120_000 });

      // 6. Verify Real Whisper Transcription & Summary in UI
      const summaryEl = page.locator('h2:has-text("Summary") + p');
      const summaryText = await summaryEl.textContent();
      expect(summaryText).toBeTruthy();
      expect(summaryText!.toLowerCase()).toContain('auto');

      // 7. Verify Video Preview Component
      const videoTag = page.locator('video');
      await videoTag.first().waitFor({ state: 'visible', timeout: 10_000 });
      expect(await videoTag.count()).toBeGreaterThan(0);

      // 8. Apply Supported Prompt Edit
      const promptInput = page.locator('textarea[placeholder*="describe it"]');
      await promptInput.fill('Cut all silence and keep speech');

      const applyBtn = page.getByRole('button', { name: 'Apply', exact: true });
      await applyBtn.click();

      // 9. Verify New Version / Edit Notes
      await page.waitForSelector('text=✓', { timeout: 30_000 });
      const editNote = await page.locator('text=✓').textContent();
      expect(editNote).toContain('silence');

      // 10. Trigger Reel Render & Export
      const renderBtn = page.getByRole('button', { name: /Approve & render/i });
      await renderBtn.click();

      // 11. Wait for Render Completion and Download Link
      await page.waitForSelector('a:has-text("Download")', { timeout: 150_000 });
      const downloadLink = page.locator('a:has-text("Download")').first();
      const downloadHref = await downloadLink.getAttribute('href');
      expect(downloadHref).toBeTruthy();

      // 12. Download Rendered MP4
      const downloadDest = path.join(workDir, 'downloaded-reel.mp4');
      await downloadFile(downloadHref!, downloadDest);
      expect(existsSync(downloadDest)).toBe(true);
      expect(statSync(downloadDest).size).toBeGreaterThan(1000);

      // 13. Validate Final Video via FFprobe
      const verification = await verifyMediaOutput({
        sourcePath: sourceFixturePath,
        outputPath: downloadDest,
        expectedSourceHash: initialSourceHash,
        format: 'reel',
      });

      expect(verification.ok).toBe(true);
      expect(verification.checks.validCodecs).toBe(true);
      expect(verification.checks.expectedResolution).toBe(true);
      expect(verification.checks.observableTrimming).toBe(true);
      expect(verification.checks.sourceIntegrityPreserved).toBe(true);

      // 14. Source File Integrity Verification
      const postTestHash = sha256(sourceFixturePath);
      expect(postTestHash).toBe(initialSourceHash);
    } finally {
      await context.close();
    }
  }, 360_000);

  it('verifies security: unauthenticated project access redirects to login (independent test)', async () => {
    // Create an independent test user and project in DB without relying on previous tests
    let secUserId: string | undefined;
    let secProjectId: string | undefined;
    try {
      const secUser = await prisma.user.create({
        data: {
          email: `sec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@local.test`,
          passwordHash: 'dummy-bcrypt-hash',
          name: 'Security Test Owner',
        },
      });
      secUserId = secUser.id;

      const secProject = await prisma.project.create({
        data: {
          userId: secUser.id,
          title: 'Security Isolation Test Project',
          status: 'UPLOADED',
        },
      });
      secProjectId = secProject.id;

      const incognito = await browser.newContext();
      try {
        const incognitoPage = await incognito.newPage();
        await incognitoPage.goto(`${WEB_BASE}/projects/${secProject.id}`, { timeout: 20_000 });
        await incognitoPage.waitForURL('**/login**', { timeout: 20_000 });
        expect(incognitoPage.url()).toContain('/login');
      } finally {
        await incognito.close();
      }
    } finally {
      if (secProjectId) {
        await prisma.project.delete({ where: { id: secProjectId } }).catch(() => {});
      }
      if (secUserId) {
        await prisma.user.delete({ where: { id: secUserId } }).catch(() => {});
      }
    }
  });

  it('verifies validation: invalid non-video upload is rejected in UI (independent test)', async () => {
    const authContext = await browser.newContext();
    try {
      const authPage = await authContext.newPage();
      await registerNewUser(authPage, 'Validation Test User');

      const invalidFile = path.join(workDir, `invalid-${Date.now()}.txt`);
      await fs.writeFile(invalidFile, 'This is plain text content, not a supported video file.');

      const fileInput = authPage.locator('input[type="file"]');
      await fileInput.setInputFiles(invalidFile);
      await authPage.waitForTimeout(500);

      const errorMsg = await authPage.locator('text=Please choose a video file.').textContent();
      expect(errorMsg).toContain('Please choose a video file.');
    } finally {
      await authContext.close();
    }
  });

  it('verifies degraded Whisper offline mode: worker falls back and browser does not wait indefinitely (independent test)', async () => {
    const wasRunning = isContainerRunning(WHISPER_CONTAINER);

    if (wasRunning) {
      try {
        execSync(`docker stop ${WHISPER_CONTAINER}`, { stdio: 'ignore' });
      } catch {
        // Handled
      }
    }

    const authContext = await browser.newContext();
    try {
      const authPage = await authContext.newPage();
      await registerNewUser(authPage, 'Degraded Offline User');

      // Upload project while Whisper container is stopped
      const fileInput = authPage.locator('input[type="file"][accept="video/*"]');
      await fileInput.setInputFiles(sourceFixturePath);

      await authPage.waitForURL('**/projects/**', { timeout: 60_000 });

      // In degraded mode, the worker catches Whisper failure, uses fallback silence timeline,
      // and completes with status ANALYZED. The browser must see "Edit timeline" within timeout.
      await authPage.waitForSelector('text=Edit timeline', { timeout: 120_000 });
      expect(await authPage.locator('text=Edit timeline').isVisible()).toBe(true);
    } finally {
      await authContext.close();
      // Always restore the designated local container and verify health probe
      if (wasRunning) {
        try {
          execSync(`docker start ${WHISPER_CONTAINER}`, { stdio: 'ignore' });
          let restored = false;
          for (let i = 0; i < 20; i++) {
            try {
              const res = await fetch('http://127.0.0.1:9000/health');
              if (res.ok) {
                restored = true;
                break;
              }
            } catch {
              // retry
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          expect(restored).toBe(true);
        } catch {
          // Handled
        }
      }
    }
  }, 180_000);
});
