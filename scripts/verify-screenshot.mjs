/**
 * Multi-zoom screenshot verifier — preview must already be running on :4173.
 * Captures 4 states: fit (default), zoom 0.5x, zoom 1.5x, zoom 5x.
 * Reports console errors + LOD switches.
 */
import puppeteer from 'puppeteer';
import { mkdirSync, existsSync } from 'node:fs';

const URL = 'http://localhost:4173/';
const OUT = '.screenshots';
if (!existsSync(OUT)) mkdirSync(OUT);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  const t = msg.text();
  if (msg.type() === 'error') errors.push(`CONSOLE: ${t}`);
  if (t.startsWith('[hex-layer]') || t.startsWith('[lod]') || t.startsWith('[boot]')) logs.push(t);
});

console.log('navigating', URL);
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 });
console.log('waiting 3s for initial hexes...');
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${OUT}/01-fit.png` });
console.log('  → 01-fit.png (initial fit-to-screen)');

const zoomLevels = [
  { name: '02-zoom-0.5', z: 0.5 },
  { name: '03-zoom-1.5', z: 1.5 },
  { name: '04-zoom-5',   z: 5 },
];
for (const { name, z } of zoomLevels) {
  await page.evaluate((zz) => window.__mwSetZoom?.(zz), z);
  await new Promise((r) => setTimeout(r, 4000)); // allow LOD reload (10km tier ~1.17M hexes)
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  → ${name}.png (zoom ${z}×)`);
}

console.log('\n=== LOGS ===');
for (const l of logs) console.log(l);

if (errors.length) {
  console.log('\n=== ERRORS ===');
  for (const e of errors) console.log(e);
}

await browser.close();
process.exit(errors.length ? 1 : 0);
