import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

const spawnedProcesses: ChildProcess[] = [];

function cleanup() {
  for (const proc of spawnedProcesses) {
    try {
      if (proc.pid && !proc.killed) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          proc.kill('SIGTERM');
        }
      }
    } catch {
      // process already dead
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function checkUrl(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitForUrl(url: string, maxWaitMs = 30000, desc = ''): Promise<boolean> {
  const start = Date.now();
  process.stdout.write(`Waiting for ${desc || url} to be ready... `);
  while (Date.now() - start < maxWaitMs) {
    if (await checkUrl(url)) {
      console.log('READY');
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log('TIMEOUT');
  return false;
}

async function ensureLocalServices() {
  console.log('=== Checking Local Test Infrastructure ===');

  // 1. Check API
  let apiRunning = await checkUrl('http://localhost:4000/health');
  if (!apiRunning) {
    console.log('Starting local API server on port 4000...');
    const apiProc = spawn('node', ['dist/index.js'], {
      cwd: API_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    spawnedProcesses.push(apiProc);
    apiRunning = await waitForUrl('http://localhost:4000/health', 25000, 'API server');
    if (!apiRunning) {
      throw new Error('API server failed to start within 25 seconds. Ensure local postgres and redis containers are running.');
    }
  } else {
    console.log('✓ API server is already running on http://localhost:4000');
  }

  // 2. Start worker if we started the API or worker is not running
  console.log('Starting BullMQ worker for analysis/render jobs...');
  const workerProc = spawn('node', ['dist/worker.js'], {
    cwd: API_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: process.platform === 'win32',
  });
  spawnedProcesses.push(workerProc);
  await new Promise((r) => setTimeout(r, 2000));

  // 3. Check Next.js Web Frontend
  let webRunning = await checkUrl('http://localhost:3000');
  if (!webRunning) {
    console.log('Starting Next.js frontend on port 3000...');
    const webProc = spawn('npm', ['run', 'start', '--prefix', 'apps/web'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    spawnedProcesses.push(webProc);
    webRunning = await waitForUrl('http://localhost:3000', 30000, 'Next.js frontend');
    if (!webRunning) {
      throw new Error('Next.js frontend failed to start within 30 seconds.');
    }
  } else {
    console.log('✓ Next.js frontend is already running on http://localhost:3000');
  }

  console.log('✓ All local services ready.\n');
}

async function runE2ETests(): Promise<number> {
  return new Promise((resolve) => {
    console.log('=== Launching Playwright E2E Pipeline Verification ===\n');

    const env = {
      ...process.env,
      RUN_BROWSER_E2E: '1',
      NODE_ENV: 'test',
    };

    const vitestArgs = [
      'vitest',
      'run',
      'tests/e2e/browser-pipeline.test.ts',
      '--testTimeout=360000',
      '--hookTimeout=120000',
    ];

    const testProc = spawn('npx', vitestArgs, {
      cwd: API_ROOT,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    testProc.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function main() {
  try {
    await ensureLocalServices();
    const exitCode = await runE2ETests();
    cleanup();
    process.exit(exitCode);
  } catch (err: any) {
    console.error('\nE2E Runner Error:', err.message);
    cleanup();
    process.exit(1);
  }
}

main();
