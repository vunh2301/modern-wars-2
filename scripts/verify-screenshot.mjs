/**
 * Quick screenshot — assumes preview already running on :4173.
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
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`);
});

console.log('navigating', URL);
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 });
console.log('waiting 4s for hexes...');
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `${OUT}/iphone.png` });
console.log('iphone screenshot saved');

if (errors.length) {
  console.log('\n=== ERRORS ===');
  for (const e of errors) console.log(e);
}

await browser.close();
process.exit(0);
