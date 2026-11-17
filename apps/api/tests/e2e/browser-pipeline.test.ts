import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, createWriteStream, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { ensureSpeechFixture } from '../fixtures/generate-videos.js';
import { verifyMediaOutput, sha256 } from '../../scripts/verify-step2d-e2e.js';

const RUN_E2E = process.env.RUN_BROWSER_E2E === '1';
const WEB_BASE = process.env.WEB_BASE_URL || 'http://localhost:3000';
const API_BASE = process.env.API_BASE_URL || 'http://localhost:4000';

async function downloadFile(url: string, dest: string): Promise<string> {
  const file = createWriteStream(dest);
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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

describe.skipIf(!RUN_E2E)('Real Browser End-to-End Pipeline (Step 2D.1)', () => {
  let browser: Browser;
  let workDir: string;
  let sourceFixturePath: string;
  let initialSourceHash: string;
  let createdProjectId: string;
  let testUserEmail: string;
  let testUserPassword: string;

  beforeAll(async () => {
    // 1. Prepare isolated temporary workspace
    workDir = path.join(os.tmpdir(), `autoedit-e2e-${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });

    // 2. Prepare synthetic speech MP4 fixture
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
    const page = await context.newPage();

    // 1. Open Login Page
    await page.goto(`${WEB_BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
    expect(page.url()).toContain('/login');

    // 2. Register Disposable User
    const switchBtn = page.getByRole('button', { name: /New here\? Create an account/i });
    await switchBtn.click();
    await page.waitForTimeout(300);

    testUserEmail = `e2e_user_${Date.now()}@local.test`;
    testUserPassword = 'LocalE2EPassword123!';

    await page.fill('input[placeholder="Name"]', 'E2E Disposable User');
    await page.fill('input[type="email"]', testUserEmail);
    await page.fill('input[type="password"]', testUserPassword);

    const createBtn = page.getByRole('button', { name: 'Create account', exact: true });
    await createBtn.click();

    // 3. Confirm Dashboard Redirect
    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    expect(page.url()).toContain('/dashboard');

    // 4. Upload Synthetic Test Video via UI
    const fileInput = page.locator('input[type="file"][accept="video/*"]');
    await fileInput.setInputFiles(sourceFixturePath);

    // 5. Confirm Project Creation and Redirect
    await page.waitForURL('**/projects/**', { timeout: 60_000 });
    const projectUrl = page.url();
    createdProjectId = projectUrl.split('/projects/')[1].split(/[?#]/)[0];
    expect(createdProjectId).toBeTruthy();

    // 6. Wait for Analysis Worker (Whisper transcription & initial timeline)
    await page.waitForSelector('text=Edit timeline', { timeout: 120_000 });

    // 7. Verify Real Whisper Transcription & Summary in UI
    const summaryEl = page.locator('h2:has-text("Summary") + p');
    const summaryText = await summaryEl.textContent();
    expect(summaryText).toBeTruthy();
    expect(summaryText!.toLowerCase()).toContain('auto');

    // 8. Verify Video Preview Component
    const videoTag = page.locator('video');
    await videoTag.first().waitFor({ state: 'visible', timeout: 10_000 });
    expect(await videoTag.count()).toBeGreaterThan(0);

    // 9. Apply Supported Prompt Edit
    const promptInput = page.locator('textarea[placeholder*="describe it"]');
    await promptInput.fill('Cut all silence and keep speech');

    const applyBtn = page.getByRole('button', { name: 'Apply', exact: true });
    await applyBtn.click();

    // 10. Verify New Version / Edit Notes
    await page.waitForSelector('text=✓', { timeout: 30_000 });
    const editNote = await page.locator('text=✓').textContent();
    expect(editNote).toContain('silence');

    // 11. Trigger Reel Render & Export
    const renderBtn = page.getByRole('button', { name: /Approve & render/i });
    await renderBtn.click();

    // 12. Wait for Render Completion and Download Link
    await page.waitForSelector('a:has-text("Download")', { timeout: 150_000 });
    const downloadLink = page.locator('a:has-text("Download")').first();
    const downloadHref = await downloadLink.getAttribute('href');
    expect(downloadHref).toBeTruthy();

    // 13. Download Rendered MP4
    const downloadDest = path.join(workDir, 'downloaded-reel.mp4');
    await downloadFile(downloadHref!, downloadDest);
    expect(existsSync(downloadDest)).toBe(true);
    expect(statSync(downloadDest).size).toBeGreaterThan(1000);

    // 14. Validate Final Video via FFprobe
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

    // 15. Source File Integrity Verification
    const postTestHash = sha256(sourceFixturePath);
    expect(postTestHash).toBe(initialSourceHash);

    await context.close();
  }, 360_000);

  it('verifies security: unauthenticated project access redirects to login', async () => {
    const incognito = await browser.newContext();
    const incognitoPage = await incognito.newPage();

    await incognitoPage.goto(`${WEB_BASE}/projects/${createdProjectId}`, { timeout: 20_000 });
    await incognitoPage.waitForURL('**/login**', { timeout: 20_000 });

    expect(incognitoPage.url()).toContain('/login');
    await incognito.close();
  });

  it('verifies validation: invalid non-video upload is rejected in UI', async () => {
    const authContext = await browser.newContext();
    const authPage = await authContext.newPage();

    // Sign in with the created test user
    await authPage.goto(`${WEB_BASE}/login`);
    await authPage.fill('input[type="email"]', testUserEmail);
    await authPage.fill('input[type="password"]', testUserPassword);
    await authPage.getByRole('button', { name: 'Sign in' }).click();
    await authPage.waitForURL('**/dashboard');

    const invalidFile = path.join(workDir, 'invalid-media.txt');
    await fs.writeFile(invalidFile, 'This is text content, not an MP4 video.');

    const fileInput = authPage.locator('input[type="file"]');
    await fileInput.setInputFiles(invalidFile);
    await authPage.waitForTimeout(500);

    const errorMsg = await authPage.locator('text=Please choose a video file.').textContent();
    expect(errorMsg).toContain('Please choose a video file.');

    await authContext.close();
  });

  it('verifies degraded Whisper offline mode: worker falls back and browser does not wait indefinitely', async () => {
    // 1. Temporarily stop Whisper container
    try {
      execSync('docker stop autoedit-local-whisper', { stdio: 'ignore' });
    } catch {
      // Docker command error handled
    }

    try {
      const authContext = await browser.newContext();
      const authPage = await authContext.newPage();

      await authPage.goto(`${WEB_BASE}/login`);
      await authPage.fill('input[type="email"]', testUserEmail);
      await authPage.fill('input[type="password"]', testUserPassword);
      await authPage.getByRole('button', { name: 'Sign in' }).click();
      await authPage.waitForURL('**/dashboard');

      // Upload second project while Whisper is offline
      const fileInput = authPage.locator('input[type="file"][accept="video/*"]');
      await fileInput.setInputFiles(sourceFixturePath);

      await authPage.waitForURL('**/projects/**', { timeout: 60_000 });

      // In degraded mode, the worker catches Whisper failure, uses fallback silence timeline,
      // and completes with status ANALYZED. The browser must see "Edit timeline" within timeout.
      await authPage.waitForSelector('text=Edit timeline', { timeout: 120_000 });
      expect(await authPage.locator('text=Edit timeline').isVisible()).toBe(true);

      await authContext.close();
    } finally {
      // 2. Always restore Whisper container
      try {
        execSync('docker start autoedit-local-whisper', { stdio: 'ignore' });
      } catch {
        // Docker command error handled
      }
    }
  }, 180_000);
});
