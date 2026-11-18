import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/utils/auth.js';
import { getStorageProvider } from '../../src/storage/index.js';
import { ensureControlledLiveFixture, probeAndValidateClipMp4 } from '../../src/media/index.js';
import { assertLocalE2EEnvironment } from '../../src/config/e2e-safety.js';

const RUN_E2E = process.env.RUN_BROWSER_E2E === '1';
const WEB_BASE = process.env.WEB_BASE_URL || 'http://localhost:3000';
const MINIO_BUCKET =
  process.env.S3_BUCKET && process.env.S3_BUCKET !== 'autoedit-test-bucket'
    ? process.env.S3_BUCKET
    : 'autoedit-local';

async function registerAndLogin(page: Page, name: string): Promise<{ email: string; userId: string }> {
  const email = `e2e_3c1_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@local.test`;
  const pass = 'LocalE2EPassword123!';
  const passwordHash = await hashPassword(pass);

  const user = await prisma.user.create({
    data: { email, name, passwordHash },
  });

  await page.goto(`${WEB_BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', pass);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });

  return { email, userId: user.id };
}

describe.skipIf(!RUN_E2E)('Step 3C.1: Universal Media Input, Job Progress & Highlight Workspace Browser E2E', () => {
  let browser: Browser;
  let workDir: string;
  let fixture30sPath: string;
  const createdUserIds = new Set<string>();
  const createdStorageKeys = new Set<string>();
  const createdSourceCanonicalIds = new Set<string>();

  beforeAll(async () => {
    assertLocalE2EEnvironment(process.env);
    workDir = path.join(os.tmpdir(), `autoedit-3c1-e2e-${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });

    fixture30sPath = path.resolve(process.cwd(), 'tmp', 'step3b5-controlled-live-fixture.mp4');
    await ensureControlledLiveFixture(fixture30sPath, {
      durationSec: 30,
      spikeStartSec: 16,
      spikeEndSec: 19,
    });

    const executablePath = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch({
      executablePath: executablePath || undefined,
      channel: executablePath ? undefined : 'chrome',
      headless: true,
    });
  }, 120_000);

  afterAll(async () => {
    if (browser) await browser.close();
    const storage = getStorageProvider();
    if (createdSourceCanonicalIds.size > 0) {
      await prisma.mediaSource
        .deleteMany({ where: { canonicalId: { in: [...createdSourceCanonicalIds] } } })
        .catch(() => {});
    }
    if (createdUserIds.size > 0) {
      await prisma.user
        .deleteMany({ where: { id: { in: [...createdUserIds] } } })
        .catch(() => {});
    }
    for (const key of createdStorageKeys) {
      await storage.deleteObject({ key }).catch(() => {});
    }
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it('Scenarios 1, 13, 14, 15, 16: redirects unauthenticated users from /media, displays universal input, and shows honest unsupported status for YouTube, Twitch & Kick URLs without fake processing', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();

      // Scenario 16: Unauthenticated user visiting /media redirects to /login
      await page.goto(`${WEB_BASE}/media`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForURL('**/login**', { timeout: 20_000 });
      expect(page.url()).toContain('/login');

      // Scenario 1: Authenticated user opens Universal Media Input on /dashboard & /media
      const { userId } = await registerAndLogin(page, 'Universal URL User');
      createdUserIds.add(userId);

      await expect(page.getByTestId('universal-media-workspace').isVisible()).resolves.toBe(true);
      await expect(page.getByTestId('free-beta-limits').isVisible()).resolves.toBe(true);

      await page.goto(`${WEB_BASE}/media`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.getByTestId('universal-url-input').waitFor({ state: 'visible', timeout: 15_000 });

      // Scenarios 13, 14, 15 & Step 3C.2: Recognized but unsupported YouTube, Twitch (VOD + Clip), and Kick URLs
      const providerUrls = [
        { label: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expectedStatus: 'UNSUPPORTED_ACQUISITION' },
        { label: 'youtube', url: 'https://www.youtube.com/@mkbhd/live', expectedStatus: 'BROADCAST_UNRESOLVED' },
        { label: 'twitch', url: 'https://www.twitch.tv/videos/1234567890', expectedStatus: 'UNSUPPORTED_ACQUISITION' },
        { label: 'twitch', url: 'https://clips.twitch.tv/IncredulousFunnyClipSlug', expectedStatus: 'UNSUPPORTED_ACQUISITION' },
        { label: 'kick', url: 'https://kick.com/video/11111111-2222-3333-4444-555555555555', expectedStatus: 'UNSUPPORTED_ACQUISITION' },
      ];

      for (const item of providerUrls) {
        await page.getByTestId('universal-url-input').fill(item.url);
        await page.getByTestId('resolve-source-btn').click();

        const capCard = page.getByTestId('source-capability-card');
        await capCard.waitFor({ state: 'visible', timeout: 25_000 });
        expect(await capCard.getAttribute('data-capability-status')).toBe(item.expectedStatus);
        const text = (await capCard.textContent()) ?? '';
        expect(text.toLowerCase()).toContain(item.label);
        expect(text).toContain("automatic processing isn't available");
        // No fake processing submit button shown for unsupported external URLs!
        expect(await page.getByTestId('submit-media-job-btn').count()).toBe(0);
      }

      // Security check: local/private-network URL blocked cleanly before submission
      await page.getByTestId('universal-url-input').fill('http://127.0.0.1:4000/health');
      await page.getByTestId('resolve-source-btn').click();
      await page.getByTestId('media-input-error').waitFor({ state: 'visible', timeout: 10_000 });
      expect(await page.getByTestId('media-input-error').textContent()).toContain('Local and private-network');
    } finally {
      await context.close();
    }
  }, 120_000);

  it('Scenarios 2–10 & 18: recognizes uploaded asset, deduplicates double-submit, resumes after refresh, reaches READY with highlights, refreshes signed URL, opens private project in editor, and downloads valid private MP4', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    try {
      const page = await context.newPage();
      const { userId } = await registerAndLogin(page, 'Highlight Workflow User');
      createdUserIds.add(userId);

      // Seed a real uploaded video asset for this authenticated user in local MinIO + PostgreSQL
      const storage = getStorageProvider();
      const uploadKey = `uploads/e2e_3c1_${Date.now()}/${userId}/demo-highlight.mp4`;
      const videoBytes = await fs.readFile(fixture30sPath);
      await storage.putObject({ key: uploadKey, body: videoBytes, contentType: 'video/mp4' });
      createdStorageKeys.add(uploadKey);

      const asset = await prisma.asset.create({
        data: {
          kind: 'SOURCE_VIDEO',
          s3Key: uploadKey,
          bucket: MINIO_BUCKET,
          mimeType: 'video/mp4',
          sizeBytes: BigInt(videoBytes.length),
          durationSec: 30,
          width: 1280,
          height: 720,
        },
      });
      const uploadProject = await prisma.project.create({
        data: {
          userId,
          title: 'Authorized Gameplay Upload 30s',
          status: 'UPLOADED',
          sourceAssetId: asset.id,
        },
      });
      createdSourceCanonicalIds.add(`upload:uploaded:${asset.id}`);

      // Navigate to /media and pick the uploaded asset
      await page.goto(`${WEB_BASE}/media`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.getByRole('tab', { name: /Existing Upload/i }).click();
      await page.getByTestId('existing-upload-select').selectOption(uploadProject.id);
      await page.getByTestId('resolve-upload-btn').click();

      // Scenario 2: Valid uploaded asset is recognized as READY_TO_PROCESS
      const capCard = page.getByTestId('source-capability-card');
      await capCard.waitFor({ state: 'visible', timeout: 15_000 });
      expect(await capCard.getAttribute('data-capability-status')).toBe('READY_TO_PROCESS');

      // Scenario 10: Double-click submit does NOT create duplicate MediaProcessingJob rows!
      const submitBtn = page.getByTestId('submit-media-job-btn');
      await submitBtn.dblclick();

      // Scenario 4: Job status card appears with real backend status
      const statusCard = page.getByTestId('media-job-status-card');
      await statusCard.waitFor({ state: 'visible', timeout: 20_000 });
      const jobId = await statusCard.getAttribute('data-job-id');
      expect(jobId).toBeTruthy();

      const userJobCount = await prisma.mediaProcessingJob.count({
        where: { userId },
      });
      expect(userJobCount).toBe(1);

      // Security: verify signed download URLs are NOT persisted in sessionStorage or localStorage
      const storedSession = await page.evaluate(() => JSON.stringify(window.sessionStorage));
      expect(storedSession).toContain(jobId!);
      expect(storedSession).not.toContain('X-Amz-Signature');
      expect(storedSession).not.toContain('s3Key');

      // Scenario 9: Browser refresh resumes the exact same job cleanly!
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
      await page.getByTestId('media-job-status-card').waitFor({ state: 'visible', timeout: 20_000 });
      expect(await page.getByTestId('media-job-status-card').getAttribute('data-job-id')).toBe(jobId);

      // Scenario 3 & 5: Wait for real BullMQ media-process worker to reach READY and render highlights
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="media-job-status-card"]')?.getAttribute('data-job-status') ===
          'READY',
        undefined,
        { timeout: 120_000 },
      );

      const hlCards = page.getByTestId('highlight-card');
      await hlCards.first().waitFor({ state: 'visible', timeout: 20_000 });
      expect(await hlCards.count()).toBeGreaterThanOrEqual(1);

      // Ensure ZERO raw storage keys leak into the rendered DOM
      const pageHtml = await page.content();
      expect(pageHtml).not.toContain(uploadKey);
      expect(pageHtml).not.toContain('"s3Key"');
      expect(pageHtml).not.toContain('"objectKey"');

      // Scenario 18: Refresh signed download URLs via authenticated API (expired URL recovery)
      const initialHref = await page.getByTestId('download-highlight-mp4-link').first().getAttribute('href');
      expect(initialHref).toBeTruthy();
      await page.waitForTimeout(1100);
      await page.getByTestId('refresh-highlight-links-btn').click();
      await page.waitForTimeout(600);
      const refreshedHref = await page.getByTestId('download-highlight-mp4-link').first().getAttribute('href');
      expect(refreshedHref).toBeTruthy();
      const headResp = await fetch(refreshedHref!);
      expect(headResp.status).toBe(200);

      // Scenario 6 & 7: Click "Edit in Private Project" -> loads existing editor + SourceHighlightsEditorPanel
      await page.getByTestId('edit-highlight-project-btn').first().click();
      await page.waitForURL('**/projects/**', { timeout: 30_000 });
      await page.getByTestId('source-highlights-editor-panel').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForSelector('text=Edit timeline', { timeout: 20_000 });

      // All 4 editing mode tabs present (Auto, Prompt, Reference, Manual)
      expect(await page.getByTestId('edit-mode-auto').isVisible()).toBe(true);
      expect(await page.getByTestId('edit-mode-prompt').isVisible()).toBe(true);
      expect(await page.getByTestId('edit-mode-reference').isVisible()).toBe(true);
      expect(await page.getByTestId('edit-mode-manual').isVisible()).toBe(true);

      // Scenario 8 (Step 3C.1.1): Apply private Prompt edit -> async HTTP 202 private render -> survives refresh -> READY -> signed URL refresh -> download & validate with ffprobe!
      await page.getByTestId('edit-mode-prompt').click();
      await page.getByTestId('private-edit-version-name').fill('E2E Prompt Hype Cut');
      await page.getByTestId('private-edit-prompt').fill('Tighten around peak moment');
      const editRespPromise = page.waitForResponse(
        (r) => r.url().includes('/api/media/projects/') && r.url().endsWith('/edits'),
        { timeout: 20_000 },
      );
      // Double-click to verify idempotent single version & single private render submission!
      await page.getByTestId('private-edit-render-btn').dblclick();
      const editResp = await editRespPromise;
      const editBodyText = await editResp.text();
      expect([200, 202], `POST /edits failed: ${editBodyText}`).toContain(editResp.status());

      // Async private render status card appears immediately
      const renderCard = page.getByTestId('private-render-status-card');
      await renderCard.waitFor({ state: 'visible', timeout: 20_000 });
      const renderJobId = await renderCard.getAttribute('data-render-job-id');
      expect(renderJobId).toBeTruthy();

      // Verify zero signed URLs or storage keys persisted in sessionStorage for private render!
      const projectSessionStorage = await page.evaluate(() => JSON.stringify(window.sessionStorage));
      expect(projectSessionStorage).not.toContain('X-Amz-Signature');
      expect(projectSessionStorage).not.toContain('private/users/');

      // Scenario 10 (Step 3C.1.1): Refresh browser while/after private render runs -> resumes cleanly!
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
      await page.getByTestId('private-render-status-card').waitFor({ state: 'visible', timeout: 20_000 });
      expect(await page.getByTestId('private-render-status-card').getAttribute('data-render-job-id')).toBe(
        renderJobId,
      );

      // Wait for real private-render BullMQ worker to reach READY
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="private-render-status-card"]')
            ?.getAttribute('data-render-status') === 'READY',
        undefined,
        { timeout: 120_000 },
      );

      const downloadLink = page.getByTestId('private-edit-download-link');
      await downloadLink.waitFor({ state: 'visible', timeout: 20_000 });
      const firstMp4Url = await downloadLink.getAttribute('href');
      expect(firstMp4Url).toBeTruthy();

      // Scenario 16 (Step 3C.1.1): Refresh signed download URL via button without re-rendering
      await page.waitForTimeout(1100);
      await page.getByTestId('refresh-private-render-link-btn').click();
      await page.waitForTimeout(600);
      const privateMp4Url = await downloadLink.getAttribute('href');
      expect(privateMp4Url).toBeTruthy();

      const resp = await fetch(privateMp4Url!);
      expect(resp.status).toBe(200);
      const mp4Buf = Buffer.from(await resp.arrayBuffer());
      const outPath = path.join(workDir, 'private-edit-download.mp4');
      await fs.writeFile(outPath, mp4Buf);
      expect(existsSync(outPath)).toBe(true);
      expect(statSync(outPath).size).toBeGreaterThan(2048);

      const meta = await probeAndValidateClipMp4(outPath);
      expect(meta.durationSec).toBeGreaterThan(0.5);
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 240_000);

  it('Scenarios 11, 12, 17, 19: handles user cancellation without affecting other clippers, failed job display, cross-user denial, and mobile layout usability', async () => {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } }); // Mobile viewport!
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      const userA = await registerAndLogin(pageA, 'User A Cancel/Fail');
      const userB = await registerAndLogin(pageB, 'User B Cross/Mobile');
      createdUserIds.add(userA.userId);
      createdUserIds.add(userB.userId);

      // Seed a MediaSource + SharedMediaWork + 2 active subscribers (User A & User B) for cancellation test
      const canonicalId = `youtube:vod:e2e3c1_${Date.now()}`;
      createdSourceCanonicalIds.add(canonicalId);
      const ms = await prisma.mediaSource.create({
        data: {
          canonicalId,
          identityScope: 'IMMUTABLE_VOD',
          provider: 'YOUTUBE',
          sourceType: 'VOD',
          externalId: `e2e3c1_${Date.now()}`,
          availability: 'AVAILABLE',
          acquisitionCapability: 'PERMITTED_STREAM',
          rightsStatus: 'PERMITTED_PUBLIC',
          rightsScope: 'SHARED_PERMITTED',
          rightsProvenance: 'TEST_CONTROLLED_GRANT',
        },
      });
      const sharedWorkKey = `mwk_e2e_cancel_${Date.now()}`;
      await prisma.sharedMediaWork.create({
        data: {
          sharedWorkKey,
          mediaSourceId: ms.id,
          canonicalSourceId: canonicalId,
          sourceType: 'VOD',
          status: 'ENQUEUED',
          generation: 1,
          stage: 'queued',
          progressPercent: 0,
        },
      });

      const jobA = await prisma.mediaProcessingJob.create({
        data: {
          userId: userA.userId,
          mediaSourceId: ms.id,
          idempotencyKey: `e2e_cancel_a_${Date.now()}`,
          sharedWorkKey,
          sourceType: 'VOD',
          status: 'QUEUED',
          stage: 'queued',
          progressPercent: 0,
        },
      });
      const jobB = await prisma.mediaProcessingJob.create({
        data: {
          userId: userB.userId,
          mediaSourceId: ms.id,
          idempotencyKey: `e2e_cancel_b_${Date.now()}`,
          sharedWorkKey,
          sourceType: 'VOD',
          status: 'QUEUED',
          stage: 'queued',
          progressPercent: 0,
        },
      });

      // Scenario 11 & Step 3C.1.1 Scenario 17 (Multi-tab UI sync):
      // Same user opens TWO tabs to jobA; cancelling in Tab 1 syncs Tab 2 to CANCELLED while User B stays QUEUED!
      const pageA2 = await ctxA.newPage();
      await pageA.goto(`${WEB_BASE}/media?job=${jobA.id}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await pageA2.goto(`${WEB_BASE}/media?job=${jobA.id}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await pageA.getByTestId('cancel-media-job-btn').waitFor({ state: 'visible', timeout: 15_000 });
      await pageA2.getByTestId('media-job-status-card').waitFor({ state: 'visible', timeout: 15_000 });

      await pageA.getByTestId('cancel-media-job-btn').click();
      await pageA.getByTestId('cancel-job-feedback').waitFor({ state: 'visible', timeout: 15_000 });
      expect(await pageA.getByTestId('media-job-status-badge').textContent()).toContain('CANCELLED');
      expect(await pageA.getByTestId('cancel-job-feedback').textContent()).toContain('other clippers');

      // Multi-tab BroadcastChannel sync updates Tab 2 automatically without manual reload!
      await pageA2.waitForFunction(
        () =>
          document.querySelector('[data-testid="media-job-status-card"]')?.getAttribute('data-job-status') ===
          'CANCELLED',
        undefined,
        { timeout: 15_000 },
      );
      await pageA2.close();

      const freshJobB = await prisma.mediaProcessingJob.findUniqueOrThrow({ where: { id: jobB.id } });
      expect(freshJobB.status).toBe('QUEUED');

      // Scenario 12: Failed job displays useful error code & message
      const failedJob = await prisma.mediaProcessingJob.create({
        data: {
          userId: userA.userId,
          mediaSourceId: ms.id,
          idempotencyKey: `e2e_fail_a_${Date.now()}`,
          sharedWorkKey: `mwk_e2e_fail_${Date.now()}`,
          sourceType: 'VOD',
          status: 'FAILED',
          stage: 'failed',
          errorCode: 'DRM_RESTRICTED',
          errorMessage: 'Stream is DRM protected and cannot be processed.',
        },
      });
      await pageA.goto(`${WEB_BASE}/media?job=${failedJob.id}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await pageA.getByTestId('media-job-failed-banner').waitFor({ state: 'visible', timeout: 15_000 });
      const failText = (await pageA.getByTestId('media-job-failed-banner').textContent()) ?? '';
      expect(failText).toContain('DRM_RESTRICTED');
      expect(failText).toContain('DRM protected');

      // Scenario 17: Cross-user job & project denial (User B cannot view User A's job OR private project!)
      const privateProjA = await prisma.project.create({
        data: {
          userId: userA.userId,
          title: 'Secret Private Project A',
          status: 'ANALYZED',
          mediaSourceId: ms.id,
        },
      });

      await pageB.goto(`${WEB_BASE}/media?job=${jobA.id}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await pageB.getByTestId('media-input-error').waitFor({ state: 'visible', timeout: 15_000 });
      expect(await pageB.getByTestId('media-job-status-card').count()).toBe(0);

      await pageB.goto(`${WEB_BASE}/projects/${privateProjA.id}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await pageB.waitForSelector('text=Project Not Found', { timeout: 15_000 });
      expect(await pageB.content()).not.toContain('Secret Private Project A');

      // Scenario 19: Mobile viewport (390x844) layout usability on /dashboard and /media (no horizontal overflow!)
      for (const route of ['/dashboard', '/media']) {
        await pageB.goto(`${WEB_BASE}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
        await pageB.getByTestId('universal-media-workspace').waitFor({ state: 'visible', timeout: 15_000 });
        const overflow = await pageB.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(4);
        expect(await pageB.getByTestId('universal-url-input').isVisible()).toBe(true);
        expect(await pageB.getByTestId('resolve-source-btn').isVisible()).toBe(true);
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  }, 120_000);
});
