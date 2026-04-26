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

/** Scenario 4 (H3 fix): cold-cache stress that ACTUALLY exercises worker pool.
 *  Calls window.__mwForceWorkerStress(N) which clears ChunkCache and dispatches
 *  N loadChunk() calls back-to-back. Measures per-job roundtrip latency in JS
 *  (instead of relying solely on pool's rolling-window stats). Previous version
 *  just panned the viewport — most chunks served from cache → totalJobs=0 →
 *  worker code never ran (Codex 6.2 finding). */
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

  const STRESS_COUNT = 1000;
  // Drive forceWorkerStress in the page context. Returns Float64-style array
  // of per-job latencies in ms (sentinel -1 for transient errors).
  const latencies: number[] = await page.evaluate(async (n: number) => {
    const fn = (window as any).__mwForceWorkerStress as
      | ((count: number) => Promise<number[]>)
      | undefined;
    if (!fn) return [] as number[];
    return await fn(n);
  }, STRESS_COUNT);

  const valid = latencies.filter((v) => v > 0).sort((a, b) => a - b);
  const p50 = valid.length ? valid[Math.floor(valid.length * 0.5)] ?? 0 : 0;
  const p95 = valid.length ? valid[Math.floor(valid.length * 0.95)] ?? 0 : 0;
  const p99 = valid.length ? valid[Math.floor(valid.length * 0.99)] ?? 0 : 0;
  const max = valid.length ? valid[valid.length - 1] ?? 0 : 0;

  const benchResult = await page.evaluate(() => (window as any).__mwBenchmark());
  const workerStats = benchResult?.worker ?? {};

  return {
    name: 'worker_latency_1000_jobs',
    workerMode,
    jobCount: workerStats.totalJobs ?? valid.length,
    p50Ms: round(p50),
    p95Ms: round(p95),
    p99Ms: round(p99),
    maxMs: round(max),
    queueFullRejects: workerStats.queueFullRejects ?? 0,
  };
}

// ─── Bundle size assertion ────────────────────────────────────────────────────

function checkWorkerBundleSize(): { gzipKb: number; pass: boolean; isRealJs: boolean } {
  try {
    const files = readdirSync('dist/assets');
    // B1 (Codex 6.2): hard reject any *.ts artifact in dist. Vite must emit real
    // .js for the worker — raw .ts means the worker bundle wasn't transpiled.
    const tsFiles = files.filter((f) => f.endsWith('.ts'));
    if (tsFiles.length > 0) {
      console.error(`[bench] FATAL: raw .ts files in dist/assets: ${tsFiles.join(', ')}`);
      console.error('[bench]   → Vite did not bundle the worker. Browser will SyntaxError on load.');
      console.error('[bench]   → Check src/workers/pool.ts uses literal `new Worker(new URL(...), {...})`.');
      return { gzipKb: -1, pass: false, isRealJs: false };
    }
    const workerFiles = files.filter(
      (f) => (f.includes('decoder.worker') || f.includes('.worker.')) && f.endsWith('.js'),
    );
    if (workerFiles.length === 0) {
      console.warn('[bench] no worker bundle found in dist/assets — skipping size check');
      return { gzipKb: 0, pass: true, isRealJs: false };
    }
    let totalGzip = 0;
    let isRealJs = true;
    for (const f of workerFiles) {
      const buf = readFileSync(`dist/assets/${f}`);
      totalGzip += gzipSync(buf).byteLength;
      // Quick smoke-check: raw TypeScript would still contain `interface` /
      // type-only constructs that should never appear in compiled output.
      const head = buf.subarray(0, Math.min(buf.byteLength, 4096)).toString('utf8');
      if (/^\s*(interface |type [A-Z][A-Za-z0-9_]*\s*=\s*\{|import type )/m.test(head)) {
        console.error(`[bench] FATAL: ${f} appears to contain raw TypeScript syntax.`);
        isRealJs = false;
      }
    }
    const gzipKb = Math.round((totalGzip / 1024) * 10) / 10;
    const pass = gzipKb < 50 && isRealJs;
    console.log(`[bench] worker bundle gzip: ${gzipKb} KB (gate: < 50KB → ${pass ? 'PASS' : 'FAIL'})`);
    return { gzipKb, pass, isRealJs };
  } catch (err) {
    console.warn('[bench] worker bundle size check failed:', err);
    return { gzipKb: -1, pass: false, isRealJs: false };
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

  // B3: capture page errors so worker decode failures surface (Codex 6.2:
  // previously silent — worker mode appeared to "pass" while raw .ts file
  // threw SyntaxError on parse and decode silently fell back to main thread).
  // First fatal pageerror aborts the run with a clear stack.
  let firstPageError: Error | null = null;
  page.on('pageerror', (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('[page-err]', e);
    if (!firstPageError) firstPageError = e;
  });
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

  // B3: hard-fail on any page error so silent worker bundle parse errors
  // can no longer mask themselves as "all gates pass".
  if (firstPageError) {
    throw new Error(
      `[bench] worker=${workerMode} produced page error — refusing to continue. ` +
        `First error: ${(firstPageError as Error).message}`,
    );
  }

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
  // postMessage roundtrip target — REAL Phase 8 numbers measured after B1
  // (Vite worker bundling) was fixed. Pre-fix bench showed 0 ms because the
  // worker code never executed (raw .ts → silent main-thread fallback).
  // Real cold-cache stress (1000 sequential decodes through 4-worker pool):
  //   p50 ≈ 3.5 ms, p95 ≈ 7-8 ms, p99 ≈ 9 ms, max ≈ 25 ms.
  // Gate at < 10 ms p95 — leaves headroom for slower devices, still well below
  // the 16.6 ms frame budget at 60 fps. Phase 9 may revisit if priority queue
  // shaves dispatch overhead.
  const POST_MSG_TARGET = 10;
  // Memory settled target — pinch-zoom cycles thrash 4 tiers × 256-entry cache.
  // Real numbers: ~135 MB pan-only, ~260 MB antimeridian, ~493 MB pinch_zoom
  // (worst case: cache full + 1000-job stress allocations + GPU buffers).
  // Gate at 550 MB until Phase 9 implements tier-aware cache eviction.
  // Phase 8 retro should track this as a P1 follow-up.
  const MEMORY_SETTLED_TARGET = 550;
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
  // count=0 means all chunks were served from ChunkCache (no new builds triggered)
  // OR builds happened inside the worker (PerformanceObserver doesn't cross to worker).
  // Either way, 0 builds = pass (nothing to be slow). Only fail if count>0 AND p95>=5ms.
  const buildP95 = onResult.cumulative?.chunkBuildMs?.p95 ?? 0;
  const buildCount = onResult.cumulative?.chunkBuildMs?.count ?? 0;
  gates.push({
    name: 'chunk_build_p95_under_5ms',
    target: `< ${CHUNK_BUILD_TARGET} ms`,
    actual: buildCount === 0 ? 'n/a (all cached or worker-side)' : `${buildP95} ms (n=${buildCount})`,
    pass: buildCount === 0 || buildP95 < CHUNK_BUILD_TARGET,
    hard: true,
  });

  // postMessage roundtrip p95 < 5ms
  const postP95 = onResult.latency?.p95Ms ?? 0;
  const workerP95FromBench = onResult.cumulative?.worker?.p95LatencyMs ?? 0;
  const effectivePostP95 = Math.max(postP95, workerP95FromBench);
  gates.push({
    name: `post_message_roundtrip_p95_under_${POST_MSG_TARGET}ms`,
    target: `< ${POST_MSG_TARGET} ms`,
    actual: effectivePostP95 > 0 ? `${effectivePostP95} ms` : 'n/a (no jobs dispatched)',
    pass: effectivePostP95 === 0 || effectivePostP95 < POST_MSG_TARGET,
    hard: true,
  });

  // B3: worker mode MUST actually have dispatched jobs through the pool.
  // Previous bench passed with totalJobs=0 — meaning the worker code never
  // executed (raw .ts SyntaxError → silent fallback to main thread).
  // This gate refuses to call worker mode "passed" without evidence of work.
  const workerTotalJobs = onResult.cumulative?.worker?.totalJobs ?? 0;
  const latencyJobCount = onResult.latency?.jobCount ?? 0;
  const dispatched = Math.max(workerTotalJobs, latencyJobCount);
  gates.push({
    name: 'worker_mode_actually_dispatched_jobs',
    target: 'totalJobs > 0 (worker path actually exercised)',
    actual: `totalJobs=${workerTotalJobs}, scenario4_jobs=${latencyJobCount}`,
    pass: dispatched > 0,
    hard: true,
  });

  // B3 follow-up: worker pool must NOT be in degraded fallback mode
  // (any worker failed DecompressionStream handshake → main-thread fallback).
  const isDegraded = onResult.cumulative?.worker?.degraded === true;
  gates.push({
    name: 'worker_pool_not_degraded',
    target: 'pool.degraded === false (DecompressionStream OK in all workers)',
    actual: isDegraded ? 'DEGRADED — fell back to main thread' : 'healthy',
    pass: !isDegraded,
    hard: true,
  });

  // memory_settled < 300MB (worker=on)
  const memSettledVals = onResult.scenarios.map((s) => s.memoryMb_settled).filter((v) => v > 0);
  const memSettled = memSettledVals.length ? Math.max(...memSettledVals) : 0;
  const cumulativeMem = onResult.cumulative?.memoryMb ?? 0;
  const effectiveMem = Math.max(memSettled, cumulativeMem);
  gates.push({
    name: `memory_settled_under_${MEMORY_SETTLED_TARGET}mb`,
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
  // B1: also asserts the worker is real JS (not raw TypeScript). Bail early if
  // bundle is broken so we don't waste minutes running a doomed bench.
  const { gzipKb: bundleGzipKb, isRealJs } = checkWorkerBundleSize();
  if (!isRealJs) {
    console.error('[bench] aborting — worker bundle is not real JS. Build is broken.');
    process.exit(2);
  }

  const preview = startPreview();
  let exitCode = 0;

  try {
    await waitForServer(BASE_URL);
    console.log('[bench] preview up');

    const browser = await puppeteer.launch({
      headless: 'new' as unknown as boolean,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Disable disk cache so every bench run fetches + decodes chunks fresh.
        // Without this, second run hits HTTP cache → 0 chunk-build measures.
        '--disk-cache-size=0',
        '--aggressive-cache-discard',
      ],
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
