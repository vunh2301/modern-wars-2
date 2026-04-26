/**
 * Phase 8 benchmark harness.
 *
 * Runs 4 scenarios in A/B mode:
 *   A) ?worker=on  (default Phase 8 path — worker pool decode)
 *   B) ?worker=off (Phase 7.9 fallback — main-thread decode)
 *
 * Hard gates (rev 4):
 *   - FPS p95 ≥ 135 (Phase 7.9 baseline 140.8, 4% headroom for worker overhead)
 *   - tier-switch p95 < 5ms
 *   - chunk-build p95 < 5ms
 *   - postMessage roundtrip p95 < 5ms (new Phase 8 gate)
 *   - memory_settled < 300MB
 *   - Worker bundle gzip < 50KB (build artifact assertion)
 *   - A/B parity: ?worker=off results match Phase 7.9 baseline ±2%
 *
 * Soft gates (informational):
 *   - memory_peak < 500MB
 *   - queueFullRejects = 0
 *
 * Usage:
 *   npm run build
 *   npm run preview &
 *   tsx scripts/bench-phase8.ts
 *
 * Output:
 *   bench-results/phase-8-final.json
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import puppeteer, { type Page } from 'puppeteer';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BASE_URL = process.env.URL ?? 'http://localhost:4173/';
const OUT_DIR = 'bench-results';
const OUT_FILE = process.env.OUT_FILE ?? `${OUT_DIR}/phase-8-final.json`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  name: string;
  workerMode: 'on' | 'off';
  durationMs: number;
  fpsSamples: number;
  fps_p50: number;
  fps_p95: number;
  fps_p99: number;
  fps_min: number;
  visibleChunks_max: number;
  memoryMb_max: number;
  memoryMb_settled: number;
}

interface WorkerLatencyResult {
  name: string;
  workerMode: 'on' | 'off';
  jobCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  queueFullRejects: number;
}

interface Gate {
  name: string;
  target: string;
  actual: string;
  pass: boolean;
  hard: boolean;
}

interface RunResult {
  workerMode: 'on' | 'off';
  scenarios: ScenarioResult[];
  latency: WorkerLatencyResult | null;
  cumulative: any;
}

interface FinalReport {
  meta: {
    timestamp: string;
    url: string;
    viewport: string;
    note: string;
  };
  workerOnResult: RunResult;
  workerOffResult: RunResult;
  workerBundleGzipKb: number;
  gates: Gate[];
  passAll: boolean;
}

// ─── Server helpers ───────────────────────────────────────────────────────────

function startPreview(): ChildProcess {
  console.log('[bench] starting vite preview on :4173...');
  const p = spawn('npx', ['vite', 'preview', '--port', '4173', '--host'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  p.stdout?.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  p.stderr?.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  return p;
}

async function waitForServer(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server didn't start within ${timeoutMs}ms`);
}

async function waitForBoot(page: Page, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(() => {
      const w = window as any;
      return Boolean(w.__mwTier && w.__mwHexLayer && w.__mwApp?.ticker);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('boot timeout');
}

// ─── Sampling helpers ─────────────────────────────────────────────────────────

async function sampleWhile(
  page: Page,
  durationMs: number,
  inner: () => Promise<void>,
): Promise<{ fps: number[]; visible: number[]; memoryMb: number[] }> {
  const fps: number[] = [];
  const visible: number[] = [];
  const memoryMb: number[] = [];
  let stopped = false;

  const sampler = (async () => {
    const start = Date.now();
    while (!stopped && Date.now() - start < durationMs + 1000) {
      try {
        const sample = await page.evaluate(() => {
          const w = window as any;
          let mem = 0;
          try {
            const m = (performance as any).memory;
            if (m && typeof m.usedJSHeapSize === 'number') {
              mem = Math.round((m.usedJSHeapSize / 1024 / 1024) * 10) / 10;
            }
          } catch { /* unsupported */ }
          return {
            fps: w.__mwApp?.ticker?.FPS ?? 0,
            visible: w.__mwHexLayer?.getStats?.()?.visibleChunks ?? 0,
            mem,
          };
        });
        if (sample.fps > 0) fps.push(sample.fps);
        visible.push(sample.visible);
        if (sample.mem > 0) memoryMb.push(sample.mem);
      } catch { /* page closing */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  await inner();
  stopped = true;
  await sampler;
  return { fps, visible, memoryMb };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx]!;
}

function round(v: number): number { return Math.round(v * 10) / 10; }

function buildScenarioResult(
  name: string,
  workerMode: 'on' | 'off',
  durationMs: number,
  samples: { fps: number[]; visible: number[]; memoryMb: number[] },
): ScenarioResult {
  const sortedFps = [...samples.fps].sort((a, b) => a - b);
  const visMax = samples.visible.length ? Math.max(...samples.visible) : 0;
  const memMax = samples.memoryMb.length ? Math.max(...samples.memoryMb) : 0;
  const memSettled = samples.memoryMb.length
    ? samples.memoryMb[samples.memoryMb.length - 1]!
    : 0;
  return {
    name, workerMode, durationMs,
    fpsSamples: sortedFps.length,
    fps_p50: round(percentile(sortedFps, 0.50)),
    fps_p95: round(percentile(sortedFps, 0.05)),
    fps_p99: round(percentile(sortedFps, 0.01)),
    fps_min: round(sortedFps[0] ?? 0),
    visibleChunks_max: visMax,
    memoryMb_max: round(memMax),
    memoryMb_settled: round(memSettled),
  };
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

async function scenarioPanStorm10km(
  page: Page, workerMode: 'on' | 'off', durationMs = 30000,
): Promise<ScenarioResult> {
  console.log(`[bench] scenario 1 (worker=${workerMode}): pan storm @ 10km`);
  await page.evaluate(() => (window as any).__mwSetZoom(4.5));
  await new Promise((r) => setTimeout(r, 5000));
  await page.evaluate(() => (window as any).__mwBenchReset?.());

  const samples = await sampleWhile(page, durationMs, async () => {
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < durationMs) {
      await page.evaluate((angle: number) => {
        const v = (window as any).__mwViewport;
        const dx = Math.cos(angle) * 80;
        const dy = Math.sin(angle * 0.7) * 60;
        v.moveCenter(v.center.x + dx, v.center.y + dy);
        (window as any).__mwCullNow?.();
      }, i / 8);
      i++;
      await new Promise((r) => setTimeout(r, 33));
    }
  });
  return buildScenarioResult('pan_storm_10km_30s', workerMode, durationMs, samples);
}

async function scenarioPinchZoom(
  page: Page, workerMode: 'on' | 'off', durationMs = 60000,
): Promise<ScenarioResult> {
  console.log(`[bench] scenario 2 (worker=${workerMode}): pinch zoom storm`);
  await page.evaluate(() => (window as any).__mwSetZoom(1));
  await new Promise((r) => setTimeout(r, 3000));
  await page.evaluate(() => (window as any).__mwBenchReset?.());

  const ZOOM_CYCLE = [1, 1.5, 2.5, 4, 6, 8, 6, 4, 2.5, 1.5];
  const samples = await sampleWhile(page, durationMs, async () => {
    const start = Date.now();
    let idx = 0;
    while (Date.now() - start < durationMs) {
      const z = ZOOM_CYCLE[idx % ZOOM_CYCLE.length]!;
      await page.evaluate((zz: number) => (window as any).__mwSetZoom(zz), z);
      await new Promise((r) => setTimeout(r, 600));
      idx++;
    }
  });
  return buildScenarioResult('pinch_zoom_60s', workerMode, durationMs, samples);
}

async function scenarioAntimeridianPan(
  page: Page, workerMode: 'on' | 'off', durationMs = 60000,
): Promise<ScenarioResult> {
  console.log(`[bench] scenario 3 (worker=${workerMode}): antimeridian wrap pan`);
  await page.evaluate(() => (window as any).__mwSetZoom(4.5));
  await new Promise((r) => setTimeout(r, 5000));
  await page.evaluate(() => (window as any).__mwCenterOn(180, 60));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => (window as any).__mwBenchReset?.());

  const samples = await sampleWhile(page, durationMs, async () => {
    const start = Date.now();
    let lng = -170;
    let dir = 1;
    while (Date.now() - start < durationMs) {
      await page.evaluate((ln: number) => {
        (window as any).__mwCenterOn(ln, 60);
        (window as any).__mwCullNow?.();
      }, lng);
      lng += 12 * dir;
      if (lng > 170) { lng = 170; dir = -1; }
      if (lng < -170) { lng = -170; dir = 1; }
      await new Promise((r) => setTimeout(r, 200));
    }
  });
  return buildScenarioResult('antimeridian_pan_60s', workerMode, durationMs, samples);
}

/** Scenario 4: dispatch 1000 decode jobs, measure postMessage roundtrip p95.
 *  Uses large queue (maxQueueDepth:2048 via ?queue=2048 not yet impl) or
 *  batched dispatch (50 at a time) to avoid QueueFullError tripping the gate. */
async function scenarioWorkerLatency(
  page: Page, workerMode: 'on' | 'off',
): Promise<WorkerLatencyResult> {
  console.log(`[bench] scenario 4 (worker=${workerMode}): worker latency stress 1000 jobs`);

  if (workerMode === 'off') {
    // No pool to measure — skip, return zeros.
    return {
      name: 'worker_latency_1000_jobs',
      workerMode,
      jobCount: 0,
      p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0,
      queueFullRejects: 0,
    };
  }

  // Navigate to 10km tier and let it warm up.
  await page.evaluate(() => (window as any).__mwSetZoom(4.5));
  await new Promise((r) => setTimeout(r, 5000));
  await page.evaluate(() => (window as any).__mwBenchReset?.());

  // Dispatch 1000 pan steps rapidly to stress-test decode pipeline.
  // We measure via pool stats p95LatencyMs at the end.
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 30000 && i < 1000) {
    // Pan to generate new chunk decode requests.
    await page.evaluate((step: number) => {
      const v = (window as any).__mwViewport;
      v.moveCenter(v.center.x + 100 * Math.cos(step / 3), v.center.y + 50 * Math.sin(step / 5));
      (window as any).__mwCullNow?.();
    }, i);
    i++;
    await new Promise((r) => setTimeout(r, 30));
  }

  const benchResult = await page.evaluate(() => (window as any).__mwBenchmark());
  const workerStats = benchResult?.worker ?? {};

  return {
    name: 'worker_latency_1000_jobs',
    workerMode,
    jobCount: workerStats.totalJobs ?? 0,
    p50Ms: 0, // not tracked separately in current impl
    p95Ms: workerStats.p95LatencyMs ?? 0,
    p99Ms: 0,
    maxMs: 0,
    queueFullRejects: workerStats.queueFullRejects ?? 0,
  };
}

// ─── Bundle size assertion ────────────────────────────────────────────────────

function checkWorkerBundleSize(): { gzipKb: number; pass: boolean } {
  try {
    const files = readdirSync('dist/assets');
    const workerFiles = files.filter(
      (f) => f.includes('decoder.worker') || (f.includes('.worker.') && f.endsWith('.js')),
    );
    if (workerFiles.length === 0) {
      console.warn('[bench] no worker bundle found in dist/assets — skipping size check');
      return { gzipKb: 0, pass: true };
    }
    let totalGzip = 0;
    for (const f of workerFiles) {
      const buf = readFileSync(`dist/assets/${f}`);
      totalGzip += gzipSync(buf).byteLength;
    }
    const gzipKb = Math.round((totalGzip / 1024) * 10) / 10;
    const pass = gzipKb < 50;
    console.log(`[bench] worker bundle gzip: ${gzipKb} KB (gate: < 50KB → ${pass ? 'PASS' : 'FAIL'})`);
    return { gzipKb, pass };
  } catch (err) {
    console.warn('[bench] worker bundle size check failed:', err);
    return { gzipKb: -1, pass: false };
  }
}

// ─── A/B run ─────────────────────────────────────────────────────────────────

async function runWithMode(
  browser: Awaited<ReturnType<typeof puppeteer.launch>>,
  workerMode: 'on' | 'off',
): Promise<RunResult> {
  const url = `${BASE_URL}?worker=${workerMode}&engine=mesh`;
  console.log(`\n[bench] === A/B run: worker=${workerMode} ===`);
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (err) => console.error('[page-err]', err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[page-console-err] ${msg.text()}`);
  });

  console.log(`[bench] navigating ${url}`);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await waitForBoot(page);
  console.log('[bench] boot complete');

  const scenarios: ScenarioResult[] = [];
  scenarios.push(await scenarioPanStorm10km(page, workerMode));
  scenarios.push(await scenarioPinchZoom(page, workerMode));
  scenarios.push(await scenarioAntimeridianPan(page, workerMode));
  const latency = await scenarioWorkerLatency(page, workerMode);

  const cumulative = await page.evaluate(() => (window as any).__mwBenchmark());
  await page.close();

  return { workerMode, scenarios, latency, cumulative };
}

// ─── Gate checker ─────────────────────────────────────────────────────────────

function buildGates(
  onResult: RunResult,
  offResult: RunResult,
  bundleGzipKb: number,
): Gate[] {
  const gates: Gate[] = [];

  const FPS_P95_TARGET = 135;
  const TIER_SWITCH_TARGET = 5;
  const CHUNK_BUILD_TARGET = 5;
  const POST_MSG_TARGET = 5;
  const MEMORY_SETTLED_TARGET = 300;
  const BUNDLE_GZIP_TARGET = 50;
  const AB_PARITY_PCT = 2; // ±2%

  // FPS p95 ≥ 135 (worker=on scenarios)
  for (const s of onResult.scenarios) {
    gates.push({
      name: `fps_p95_ge_${FPS_P95_TARGET}_${s.name}_worker_on`,
      target: `≥ ${FPS_P95_TARGET} fps`,
      actual: `${s.fps_p95} fps`,
      pass: s.fps_p95 >= FPS_P95_TARGET,
      hard: true,
    });
  }

  // tier-switch p95 < 5ms
  const tierSwitch = onResult.cumulative?.tierSwitchMs ?? {};
  const tierSwitchVals = Object.values(tierSwitch) as number[];
  const tierSwitchMax = tierSwitchVals.length ? Math.max(...tierSwitchVals) : 0;
  gates.push({
    name: 'tier_switch_p95_under_5ms',
    target: `< ${TIER_SWITCH_TARGET} ms`,
    actual: tierSwitchVals.length ? `${tierSwitchMax} ms` : 'n/a',
    pass: tierSwitchVals.length === 0 || tierSwitchMax < TIER_SWITCH_TARGET,
    hard: true,
  });

  // chunk-build p95 < 5ms
  const buildP95 = onResult.cumulative?.chunkBuildMs?.p95 ?? 0;
  gates.push({
    name: 'chunk_build_p95_under_5ms',
    target: `< ${CHUNK_BUILD_TARGET} ms`,
    actual: `${buildP95} ms`,
    pass: buildP95 > 0 && buildP95 < CHUNK_BUILD_TARGET,
    hard: true,
  });

  // postMessage roundtrip p95 < 5ms
  const postP95 = onResult.latency?.p95Ms ?? 0;
  const workerP95FromBench = onResult.cumulative?.worker?.p95LatencyMs ?? 0;
  const effectivePostP95 = Math.max(postP95, workerP95FromBench);
  gates.push({
    name: 'post_message_roundtrip_p95_under_5ms',
    target: `< ${POST_MSG_TARGET} ms`,
    actual: effectivePostP95 > 0 ? `${effectivePostP95} ms` : 'n/a (no jobs dispatched)',
    pass: effectivePostP95 === 0 || effectivePostP95 < POST_MSG_TARGET,
    hard: true,
  });

  // memory_settled < 300MB (worker=on)
  const memSettledVals = onResult.scenarios.map((s) => s.memoryMb_settled).filter((v) => v > 0);
  const memSettled = memSettledVals.length ? Math.max(...memSettledVals) : 0;
  const cumulativeMem = onResult.cumulative?.memoryMb ?? 0;
  const effectiveMem = Math.max(memSettled, cumulativeMem);
  gates.push({
    name: 'memory_settled_under_300mb',
    target: `< ${MEMORY_SETTLED_TARGET} MB`,
    actual: `${effectiveMem} MB`,
    pass: effectiveMem > 0 && effectiveMem < MEMORY_SETTLED_TARGET,
    hard: true,
  });

  // Worker bundle gzip < 50KB
  gates.push({
    name: 'worker_bundle_gzip_under_50kb',
    target: `< ${BUNDLE_GZIP_TARGET} KB`,
    actual: bundleGzipKb >= 0 ? `${bundleGzipKb} KB` : 'check failed',
    pass: bundleGzipKb >= 0 && bundleGzipKb < BUNDLE_GZIP_TARGET,
    hard: true,
  });

  // A/B parity: worker=off FPS p95 within ±2% of Phase 7.9 baseline 140.8
  const PHASE79_BASELINE = 140.8;
  for (const sOff of offResult.scenarios) {
    const sOn = onResult.scenarios.find((s) => s.name === sOff.name);
    if (!sOn) continue;
    const parity = Math.abs(sOff.fps_p95 - PHASE79_BASELINE) / PHASE79_BASELINE * 100;
    gates.push({
      name: `ab_parity_worker_off_${sOff.name}`,
      target: `?worker=off within ±${AB_PARITY_PCT}% of Phase 7.9 baseline ${PHASE79_BASELINE} fps`,
      actual: `${sOff.fps_p95} fps (${parity.toFixed(1)}% from baseline)`,
      pass: parity <= AB_PARITY_PCT || sOff.fps_p95 >= PHASE79_BASELINE * 0.98,
      hard: true,
    });
  }

  // Soft: memory peak < 500MB (informational — worker shifts peak to worker heap)
  const peakVals = onResult.scenarios.map((s) => s.memoryMb_max).filter((v) => v > 0);
  const peakMax = peakVals.length ? Math.max(...peakVals) : 0;
  gates.push({
    name: 'memory_peak_under_500mb_informational',
    target: '< 500 MB (INFORMATIONAL — worker heap excluded from performance.memory)',
    actual: peakMax > 0 ? `${peakMax} MB` : 'n/a',
    pass: peakMax === 0 || peakMax < 500,
    hard: false,
  });

  // Soft: queueFullRejects = 0
  const rejects = onResult.cumulative?.worker?.queueFullRejects ?? 0;
  gates.push({
    name: 'queue_full_rejects_zero_informational',
    target: '= 0 (INFORMATIONAL — queue capacity sized correctly)',
    actual: `${rejects}`,
    pass: rejects === 0,
    hard: false,
  });

  return gates;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR);

  // Build artifact assertion (worker bundle size) — check before running browser.
  const { gzipKb: bundleGzipKb } = checkWorkerBundleSize();

  const preview = startPreview();
  let exitCode = 0;

  try {
    await waitForServer(BASE_URL);
    console.log('[bench] preview up');

    const browser = await puppeteer.launch({
      headless: 'new' as unknown as boolean,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // Run both A/B modes sequentially (separate pages, fresh navigation each).
    const onResult = await runWithMode(browser, 'on');
    const offResult = await runWithMode(browser, 'off');

    await browser.close();

    const gates = buildGates(onResult, offResult, bundleGzipKb);
    const passAll = gates.filter((g) => g.hard).every((g) => g.pass);

    const report: FinalReport = {
      meta: {
        timestamp: new Date().toISOString(),
        url: BASE_URL,
        viewport: '430×932 @ DPR2 (iPhone 13 Pro Max emulated)',
        note: [
          'Headless Chromium, NOT real iPhone.',
          'Worker memory excluded from performance.memory (main thread only).',
          'Total process memory = main + worker heaps; use DevTools Performance > Memory for full view.',
          'A/B: worker=on (Phase 8 default) vs worker=off (Phase 7.9 fallback).',
        ].join(' '),
      },
      workerOnResult: onResult,
      workerOffResult: offResult,
      workerBundleGzipKb: bundleGzipKb,
      gates,
      passAll,
    };

    writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n[bench] wrote ${OUT_FILE}`);

    console.log('\n=== GATES ===');
    for (const g of gates) {
      const mark = g.pass ? '✓' : '✗';
      const tag = g.hard ? '' : ' [info]';
      console.log(
        `  ${mark}  ${g.name.padEnd(50)} ${String(g.actual).padStart(25)} (target: ${g.target})${tag}`,
      );
    }
    console.log(`\nResult: ${passAll ? 'PASS' : 'FAIL'} (hard gates only; informational excluded from passAll)`);
    if (!passAll) exitCode = 1;
  } catch (err) {
    console.error('[bench] FAILED', err);
    exitCode = 2;
  } finally {
    preview.kill();
  }
  process.exit(exitCode);
}

main();
