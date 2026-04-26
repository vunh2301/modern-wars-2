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

// Pan to Europe (Paris ~ 2°E, 48°N) at zoom 4× to verify FR + neighbors.
await page.evaluate(() => {
  window.__mwSetZoom?.(4);
  window.__mwCenterOn?.(2, 48);
});
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `${OUT}/05-europe-zoom-4.png` });
console.log('  → 05-europe-zoom-4.png (Paris @ zoom 4×)');

// Pan to antimeridian — Bering Strait (180° / 65°N) at zoom 1× to verify
// wrap: Russia Chukotka + Alaska visible from both sides via 3-copy hexLayer.
await page.evaluate(() => {
  window.__mwSetZoom?.(1);
  window.__mwCenterOn?.(180, 65);
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${OUT}/06-bering.png` });
console.log('  → 06-bering.png (Bering Strait lng 180° / 65°N @ zoom 1×)');

// Pan way east (lng 270° = wrapped to lng -90° = North America center).
// Should show Mexico/Caribbean continuously via wrap.
await page.evaluate(() => {
  window.__mwCenterOn?.(270, 25);
});
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: `${OUT}/07-wrapped-270.png` });
console.log('  → 07-wrapped-270.png (lng 270° wraps to -90° / N. America)');

// Africa Horn (Somaliland 47°E, 9°N) at zoom 5× to verify XM rendered.
await page.evaluate(() => {
  window.__mwSetZoom?.(5);
  window.__mwCenterOn?.(47, 9);
});
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `${OUT}/08-somaliland.png` });
console.log('  → 08-somaliland.png (Somaliland 47°E/9°N @ zoom 5×)');

// Stress: max zoom (8×) on dense urban region — verify no crash.
await page.evaluate(() => {
  window.__mwSetZoom?.(8);
  window.__mwCenterOn?.(2, 48);
});
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `${OUT}/09-max-zoom.png` });
console.log('  → 09-max-zoom.png (Paris @ zoom 8× = max)');

// Sanity: pan to Asia interior (lng 100°E lat 50°N) at 25km zoom 2.5×.
// FAR from antimeridian. If lằn appears here too, it's NOT wrap-related.
await page.evaluate(() => {
  window.__mwSetZoom?.(2.5);
  window.__mwCenterOn?.(100, 50);
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${OUT}/10-asia-25km.png` });
console.log('  → 10-asia-25km.png (Russia/Mongolia 100°E/50°N @ 25km zoom 2.5×)');

// Same coords but tier 50km (zoom 1×) for comparison.
await page.evaluate(() => {
  window.__mwSetZoom?.(1);
  window.__mwCenterOn?.(100, 50);
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${OUT}/11-asia-50km.png` });
console.log('  → 11-asia-50km.png (Russia interior 100°E/50°N @ 50km)');

// Pan left to lng -180° (test clamp doesn't block left).
await page.evaluate(() => {
  window.__mwSetZoom?.(0.5);
  window.__mwCenterOn?.(-180, 0);
});
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: `${OUT}/12-pan-left-180.png` });
console.log('  → 12-pan-left-180.png (lng -180° / clamp test)');

// Zoom 8× pan tới Russia far East (Cape Dezhnev ~169°E 66°N, có đất gần edge).
await page.evaluate(() => {
  window.__mwSetZoom?.(8);
  window.__mwCenterOn?.(170, 65);
});
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `${OUT}/13-zoom8-far-east.png` });
console.log('  → 13-zoom8-far-east.png (Russia FE 170°E 65°N zoom 8× / 10km clamp test)');

// Test Y pan free (zoom 1, pan vertically to Greenland).
await page.evaluate(() => {
  window.__mwSetZoom?.(1);
  window.__mwCenterOn?.(-40, 75);
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${OUT}/14-y-pan-greenland.png` });
console.log('  → 14-y-pan-greenland.png (Greenland test Y pan free)');

console.log('\n=== LOGS ===');
for (const l of logs) console.log(l);

if (errors.length) {
  console.log('\n=== ERRORS ===');
  for (const e of errors) console.log(e);
}

await browser.close();
process.exit(errors.length ? 1 : 0);
