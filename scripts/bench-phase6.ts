/**
 * Phase 6 benchmark harness.
 *
 * Runs 3 scenarios via headless Chromium with iPhone 13 Pro Max viewport
 * (430×932 @ DPR 2). Real iPhone hardware NOT used (autonomous loop has
 * no remote inspect / BrowserStack access) — results are desktop-GPU
 * upper bound; flag in output for human verification.
 *
 * Usage:
 *   npm run build
 *   npm run preview &
 *   tsx scripts/bench-phase6.ts
 *
 * Output:
 *   bench-results/phase-6-final.json
 *
 * Exit code 0 if all gates pass, 1 if any fail.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import puppeteer, { type Page } from 'puppeteer';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const URL = process.env.URL ?? 'http://localhost:4173/';
const OUT_DIR = 'bench-results';
const OUT_FILE = `${OUT_DIR}/phase-6-final.json`;

interface ScenarioResult {
  name: string;
  durationMs: number;
  fpsSamples: number;
  fps_p50: number;
  fps_p95: number;  // 5th percentile (95% of frames at least this FPS)
  fps_p99: number;  // 1st percentile (99% of frames at least this FPS)
  fps_min: number;
  visibleChunks_min: number;
  visibleChunks_max: number;
  visibleChunks_avg: number;
  memoryMb_max: number;
  memoryMb_avg: number;
}

interface FinalReport {
  meta: {
    timestamp: string;
    url: string;
    viewport: string;
    note: string;
  };
  scenarios: ScenarioResult[];
  cumulative: any; // benchmark.snapshot()
  gates: Array<{ name: string; target: string; actual: string; pass: boolean }>;
  passAll: boolean;
}

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

async function waitForBoot(page: Page, timeoutMs = 25000): Promise<void> {
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

/** Sample FPS + visible chunks + memory at 100ms cadence while running `inner`. */
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
          } catch { /* unsupported browser */ }
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

function summarize(
  name: string,
  durationMs: number,
  samples: { fps: number[]; visible: number[]; memoryMb: number[] },
): ScenarioResult {
  const sortedFps = [...samples.fps].sort((a, b) => a - b);
  const visMin = samples.visible.length ? Math.min(...samples.visible) : 0;
  const visMax = samples.visible.length ? Math.max(...samples.visible) : 0;
  const visAvg = samples.visible.length
    ? samples.visible.reduce((a, b) => a + b, 0) / samples.visible.length
    : 0;
  const memMax = samples.memoryMb.length ? Math.max(...samples.memoryMb) : 0;
  const memAvg = samples.memoryMb.length
    ? samples.memoryMb.reduce((a, b) => a + b, 0) / samples.memoryMb.length
    : 0;
  return {
    name,
    durationMs,
    fpsSamples: sortedFps.length,
    fps_p50: round(percentile(sortedFps, 0.50)),
    fps_p95: round(percentile(sortedFps, 0.05)),
    fps_p99: round(percentile(sortedFps, 0.01)),
    fps_min: round(sortedFps[0] ?? 0),
    visibleChunks_min: visMin,
    visibleChunks_max: visMax,
    visibleChunks_avg: round(visAvg),
    memoryMb_max: round(memMax),
    memoryMb_avg: round(memAvg),
  };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

// ─── Scenarios ───────────────────────────────────────────────────────────

async function scenarioPanStorm10km(page: Page, durationMs = 30000): Promise<ScenarioResult> {
  console.log('[bench] scenario 1: pan storm @ 10km tier');
  await page.evaluate(() => (window as any).__mwSetZoom(4.5));
  await new Promise((r) => setTimeout(r, 5000)); // tier 10km load + initial cull
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
      await new Promise((r) => setTimeout(r, 33)); // ~30Hz pan rate
    }
  });

  return summarize('pan_storm_10km_30s', durationMs, samples);
}

async function scenarioPinchZoom(page: Page, durationMs = 60000): Promise<ScenarioResult> {
  console.log('[bench] scenario 2: pinch zoom storm');
  await page.evaluate(() => (window as any).__mwSetZoom(1));
  await new Promise((r) => setTimeout(r, 3000));
  await page.evaluate(() => (window as any).__mwBenchReset?.());

  // Cycle 1× → 8× (max scale clamp) → 1×. Each leg ~750ms = 6 zooms / cycle.
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

  return summarize('pinch_zoom_60s', durationMs, samples);
}

async function scenarioPanWorld(page: Page, durationMs = 60000): Promise<ScenarioResult> {
  console.log('[bench] scenario 3: pan around world @ tier 10km');
  await page.evaluate(() => (window as any).__mwSetZoom(4.5));
  await new Promise((r) => setTimeout(r, 5000));
  await page.evaluate(() => (window as any).__mwBenchReset?.());

  // Walk a great circle: lng -180→+180 stepping 10°, lat oscillates -50..+50.
  const samples = await sampleWhile(page, durationMs, async () => {
    const start = Date.now();
    let lng = -180;
    let i = 0;
    while (Date.now() - start < durationMs) {
      const lat = Math.sin(i / 6) * 50;
      await page.evaluate((ln: number, la: number) => {
        (window as any).__mwCenterOn(ln, la);
        (window as any).__mwCullNow?.();
      }, lng, lat);
      lng += 10;
      if (lng > 180) lng = -180;
      i++;
      await new Promise((r) => setTimeout(r, 200)); // 5Hz pan
    }
  });

  return summarize('pan_world_10km_60s', durationMs, samples);
}

async function scenarioAntimeridianPan10km(page: Page, durationMs = 30000): Promise<ScenarioResult> {
  console.log('[bench] scenario 4: antimeridian pan @ 10km tier (wrap stress)');
  await page.evaluate(() => (window as any).__mwSetZoom(4.5));
  await new Promise((r) => setTimeout(r, 5000));
  // Center near Bering before reset to start at seam
  await page.evaluate(() => (window as any).__mwCenterOn(180, 60));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => (window as any).__mwBenchReset?.());

  // Loop: -170° → +170° → -170°. Each cycle ~7s at 5Hz with 12° step.
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

  return summarize('antimeridian_pan_10km_30s', durationMs, samples);
}

// ─── Main ─────────────────────────────────────────────────────────────────

function checkGates(scenarios: ScenarioResult[], cumulative: any): FinalReport['gates'] {
  const s1 = scenarios.find((s) => s.name === 'pan_storm_10km_30s');
  const s2 = scenarios.find((s) => s.name === 'pinch_zoom_60s');
  const s4 = scenarios.find((s) => s.name === 'antimeridian_pan_10km_30s');
  const tierSwitch = cumulative.tierSwitchMs ?? {};
  const buildMs = cumulative.chunkBuildMs ?? { p95: 0, max: 0 };
  const memMb = cumulative.memoryMb ?? 0;

  const gates: FinalReport['gates'] = [
    {
      name: 'tier_switch_50to25_under_50ms',
      target: '< 50 ms',
      actual: `${tierSwitch['50km->25km'] ?? 'n/a'} ms`,
      pass: typeof tierSwitch['50km->25km'] === 'number' && tierSwitch['50km->25km'] < 50,
    },
    {
      name: 'tier_switch_25to10_under_80ms',
      target: '< 80 ms',
      actual: `${tierSwitch['25km->10km'] ?? 'n/a'} ms`,
      pass: typeof tierSwitch['25km->10km'] === 'number' && tierSwitch['25km->10km'] < 80,
    },
    {
      name: 'pan_storm_10km_fps_p95_ge_58',
      target: '≥ 58 fps',
      actual: `${s1?.fps_p95 ?? 'n/a'} fps`,
      pass: (s1?.fps_p95 ?? 0) >= 58,
    },
    {
      name: 'pinch_zoom_fps_p95_ge_55',
      target: '≥ 55 fps',
      actual: `${s2?.fps_p95 ?? 'n/a'} fps`,
      pass: (s2?.fps_p95 ?? 0) >= 55,
    },
    {
      name: 'memory_peak_under_250mb',
      target: '< 250 MB',
      // Per-scenario max instead of cumulative — true peak during pan/zoom.
      actual: `${Math.max(...scenarios.map((s) => s.memoryMb_max), memMb)} MB (cum=${memMb})`,
      pass: Math.max(...scenarios.map((s) => s.memoryMb_max), memMb) > 0
            && Math.max(...scenarios.map((s) => s.memoryMb_max), memMb) < 250,
    },
    {
      name: 'visible_chunks_max_le_12_at_10km',
      target: '≤ 12',
      actual: `${s1?.visibleChunks_max ?? 'n/a'}`,
      pass: (s1?.visibleChunks_max ?? 0) > 0 && (s1?.visibleChunks_max ?? 99) <= 12,
    },
    {
      name: 'chunk_build_p95_under_8ms',
      target: '< 8 ms',
      actual: `${buildMs.p95} ms (max ${buildMs.max} ms)`,
      pass: buildMs.p95 > 0 && buildMs.p95 < 8,
    },
    {
      name: 'antimeridian_pan_10km_fps_p95_ge_58',
      target: '≥ 58 fps',
      actual: `${s4?.fps_p95 ?? 'n/a'} fps`,
      pass: (s4?.fps_p95 ?? 0) >= 58,
    },
  ];
  return gates;
}

async function main(): Promise<void> {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR);

  const preview = startPreview();
  let exitCode = 0;
  try {
    await waitForServer(URL);
    console.log('[bench] preview up');

    const browser = await puppeteer.launch({
      headless: 'new' as unknown as boolean,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

    page.on('pageerror', (err) => console.error('[page-err]', err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`[page-console-err] ${msg.text()}`);
    });

    console.log(`[bench] navigating ${URL}`);
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitForBoot(page);
    console.log('[bench] boot complete');

    const scenarios: ScenarioResult[] = [];

    // Scenario 1: pan storm @ 10km
    scenarios.push(await scenarioPanStorm10km(page));
    // Scenario 2: pinch zoom storm
    scenarios.push(await scenarioPinchZoom(page));
    // Scenario 3: pan around world
    scenarios.push(await scenarioPanWorld(page));
    // Scenario 4: antimeridian pan @ 10km (wrap stress — D-6 extended)
    scenarios.push(await scenarioAntimeridianPan10km(page));

    const cumulative = await page.evaluate(() => (window as any).__mwBenchmark());

    const gates = checkGates(scenarios, cumulative);
    const passAll = gates.every((g) => g.pass);

    const report: FinalReport = {
      meta: {
        timestamp: new Date().toISOString(),
        url: URL,
        viewport: '430×932 @ DPR2 (iPhone 13 Pro Max emulated)',
        note: 'Headless Chromium, NOT real iPhone. GPU-bound metrics likely optimistic vs real A15.',
      },
      scenarios,
      cumulative,
      gates,
      passAll,
    };

    writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n[bench] wrote ${OUT_FILE}`);

    console.log('\n=== GATES ===');
    for (const g of gates) {
      const mark = g.pass ? '✓' : '✗';
      console.log(`  ${mark}  ${g.name.padEnd(40)} ${g.actual.padStart(20)} (target: ${g.target})`);
    }
    console.log(`\nResult: ${passAll ? 'PASS' : 'FAIL'}`);
    if (!passAll) exitCode = 1;

    await browser.close();
  } catch (err) {
    console.error('[bench] FAILED', err);
    exitCode = 2;
  } finally {
    preview.kill();
  }
  process.exit(exitCode);
}

main();
