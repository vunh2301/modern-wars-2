/**
 * Headless screenshot test. Em (claude) tự verify visually trước khi push to main.
 *
 * Usage:
 *   1. npm run build
 *   2. npm run preview &  (or vite preview --port 4173)
 *   3. node scripts/screenshot.mjs
 *
 * Output: screenshot.png in repo root. Justin can also inspect.
 */
import puppeteer from 'puppeteer';
import { mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const URL = process.env.URL ?? 'http://localhost:4173/';
const OUT_DIR = '.screenshots';
const WAIT_MS = 4000;

function startPreview() {
  console.log('[screenshot] starting vite preview...');
  const p = spawn('npx', ['vite', 'preview', '--port', '4173', '--host'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  return p;
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server didn't start within ${timeoutMs}ms`);
}

async function shoot(label, viewportW, viewportH, browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: viewportW, height: viewportH, deviceScaleFactor: 2 });
  console.log(`[screenshot] [${label}] navigating ${URL}...`);
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 });
  console.log(`[screenshot] [${label}] waiting ${WAIT_MS}ms for hexes to settle...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));
  const path = `${OUT_DIR}/${label}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`[screenshot] [${label}] wrote ${path}`);

  // Capture console errors
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  await page.close();
  return errors;
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR);
  const preview = startPreview();
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));

  try {
    await waitForServer(URL);
    console.log('[screenshot] server up');

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // iPhone 13 Pro Max-like viewport
    await shoot('iphone', 430, 932, browser);
    // Desktop wide
    await shoot('desktop', 1280, 800, browser);

    await browser.close();
    console.log('[screenshot] done. Inspect .screenshots/*.png');
  } finally {
    preview.kill();
  }
}

main().catch((err) => {
  console.error('[screenshot] FAILED', err);
  process.exit(1);
});
