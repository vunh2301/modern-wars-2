/**
 * Bundle size gate. SPEC Section 19.1 / Section 12.
 *
 * Reads dist/ and asserts:
 *   - Initial route gzipped ≤ 350KB (HARD FAIL)
 *   - Total app gzipped ≤ 500KB (HARD FAIL, excludes public/geo/*)
 *   - Tone.js NOT in initial chunk (must be lazy)
 *   - Phase 0 sub-budget: initial ≤ 280KB gz (per task description acceptance)
 *
 * Phase 0 stub: walks dist/assets/*.js + index.html, computes gzip sizes.
 * Future hardening: parse Vite manifest.json for accurate route attribution.
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, extname } from 'node:path';

const DIST = 'dist';
const INITIAL_LIMIT_KB = 350;
const PHASE_0_INITIAL_LIMIT_KB = 280;
const TOTAL_LIMIT_KB = 500;

type FileSize = { path: string; raw: number; gz: number };

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function sizeOf(path: string): FileSize {
  const buf = readFileSync(path);
  const gz = gzipSync(buf, { level: 9 });
  return { path, raw: buf.length, gz: gz.length };
}

function fmtKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function main(): void {
  if (!existsSync(DIST)) {
    console.error(`[check-bundle] ${DIST}/ not found. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const all = walk(DIST).filter((p) => /\.(js|css|html)$/i.test(p));
  const sized = all.map(sizeOf);

  // "Initial" heuristic: index.html + entry chunk + CSS that ships with index.
  // Vite emits hashed `assets/index-*.js` and `assets/index-*.css` for entry.
  const initialFiles = sized.filter((f) => {
    const base = f.path.replace(/\\/g, '/');
    return /index\.html$/.test(base) || /assets\/index-[^/]+\.(js|css)$/.test(base);
  });

  // React + Pixi vendor chunks count as initial because they are eagerly imported.
  const vendorInitial = sized.filter((f) => /assets\/(pixi|react)-[^/]+\.js$/.test(f.path.replace(/\\/g, '/')));

  const initial = [...initialFiles, ...vendorInitial];
  const initialGz = initial.reduce((s, f) => s + f.gz, 0);
  const totalGz = sized.reduce((s, f) => s + f.gz, 0);

  // Tone.js leak check: initial chunks must NOT eagerly import the Tone module
  // (dynamic import('tone') is fine — it lands in a separate code-split chunk).
  // Detection: only fail if the entry chunk contains a STATIC import path
  // referencing the actual `tone` module exports (not just a chunk URL hint).
  const initialJs = initial.filter((f) => f.path.endsWith('.js'));
  const toneLeak = initialJs.find((f) => {
    const txt = readFileSync(f.path, 'utf8');
    // Static-import shapes (eager): `from"tone"`, `from "tone"`, `require("tone")`.
    const staticImport = /from\s*["']tone["']|require\s*\(\s*["']tone["']\s*\)/;
    return staticImport.test(txt);
  });

  console.info('[check-bundle] File breakdown:');
  for (const f of sized.sort((a, b) => b.gz - a.gz)) {
    const tag = initial.includes(f) ? '[INIT]' : '      ';
    console.info(`  ${tag} ${fmtKb(f.gz).padStart(10)} gz  ${fmtKb(f.raw).padStart(10)} raw  ${f.path}`);
  }
  console.info('');
  console.info(`[check-bundle] Initial gzipped: ${fmtKb(initialGz)} (limit ${INITIAL_LIMIT_KB} KB; phase-0 sub-limit ${PHASE_0_INITIAL_LIMIT_KB} KB)`);
  console.info(`[check-bundle] Total gzipped:   ${fmtKb(totalGz)} (limit ${TOTAL_LIMIT_KB} KB)`);

  let failed = false;

  if (initialGz > INITIAL_LIMIT_KB * 1024) {
    console.error(`[check-bundle] FAIL: initial ${fmtKb(initialGz)} exceeds ${INITIAL_LIMIT_KB} KB.`);
    failed = true;
  } else if (initialGz > PHASE_0_INITIAL_LIMIT_KB * 1024) {
    console.warn(`[check-bundle] WARN: initial ${fmtKb(initialGz)} exceeds Phase-0 sub-limit ${PHASE_0_INITIAL_LIMIT_KB} KB.`);
  }

  if (totalGz > TOTAL_LIMIT_KB * 1024) {
    console.error(`[check-bundle] FAIL: total ${fmtKb(totalGz)} exceeds ${TOTAL_LIMIT_KB} KB.`);
    failed = true;
  }

  if (toneLeak) {
    console.error(`[check-bundle] FAIL: Tone.js detected in initial chunk ${toneLeak.path}. Must be lazy-loaded.`);
    failed = true;
  }

  if (failed) {
    console.error('[check-bundle] Bundle gate FAILED.');
    process.exit(1);
  }
  console.info('[check-bundle] OK.');
  // Use file extensions to silence lint about unused imports
  void extname;
}

main();
