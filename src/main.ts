/**
 * Bootstrap entry. SPEC v1.0 Section 11 Phase 0-3.
 *
 * Phase 7: ?engine=mesh (default) uses src/render/meshHexLayer.ts (pre-baked
 * chunked mesh buffers). ?engine=particles falls back to Phase 6
 * src/render/hexLayer.ts (ParticleContainer) for safe rollback.
 */
import type { Container } from 'pixi.js';
import { createStage, mountStage } from './render/stage';
import {
  createViewport,
  fitViewportToWorld,
  resizeViewport,
  enableInfiniteWrap,
  enableWrapCopyPanClamp,
} from './render/viewport';
import { createHexLayer } from './render/hexLayer';
import { createMeshHexLayer } from './render/meshHexLayer';
import { createBenchmark } from './render/benchmark';
import { createSandboxLayer } from './sandbox/sandboxLayer';
import { loadManifest } from './data/manifest';
import { loadCountries } from './data/countries';
import { loadTier } from './data/tiers';
import { loadChunksManifest, computeColorLutHash, getWorkerPoolStats, getDecodeMode, getWorkerPoolSize } from './data/chunks';
import { buildColorLut } from './render/colors';
import { pickTier } from './render/lod';

/** Coalesce repeated calls to next requestAnimationFrame tick. Trailing dispatch. */
function throttleRaf(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

interface ViewportBbox { minX: number; minY: number; maxX: number; maxY: number }

interface UnifiedHexLayer {
  root: Container;
  setTier(tierName: string, sizeKm: number): Promise<void>;
  setBordersVisible(visible: boolean): void;
  updateVisibility(bbox: ViewportBbox): void;
  getStats(): { visibleChunks: number; builtChunks: number; totalChunks: number; lastBuildMs: number; lastCullMs: number; lastTierSwitchMs: number };
  /** Phase 7.9 (C): warm adjacent tier cache (mesh engine only; particles no-op). */
  prefetchTier?: (tierName: string, signal?: AbortSignal) => Promise<void>;
  /** Phase 8.3: wire cullNow for static-viewport QueueFullError retry rAF driver. */
  setCullNow?: (fn: () => void) => void;
  /** Phase 8 H3: cold-cache worker stress (mesh engine only). */
  forceWorkerStress?: (jobCount: number) => Promise<{ latencies: number[]; failedCount: number }>;
  destroy(): void;
}

/**
 * Sandbox mode (?map=sandbox) — synthetic 64×64 hex grid, 3 colored regions
 * ở giữa. Skip ALL tier/chunk/manifest/LOD infrastructure. Texture experiments.
 *
 * URL params còn dùng được:
 *   ?seed=N      different random region positions (default 1)
 *   ?rows=N      grid rows (default 64)
 *   ?cols=N      grid cols (default 64)
 *   ?renderer=webgpu|webgl   (Phase 7.8 — passed to createStage)
 */
async function bootstrapSandbox(
  app: Awaited<ReturnType<typeof createStage>>,
  viewport: ReturnType<typeof createViewport>,
): Promise<void> {
  const params = new URLSearchParams(location.search);
  const seed = parseInt(params.get('seed') ?? '1', 10) || 1;
  const rows = parseInt(params.get('rows') ?? '64', 10) || 64;
  const cols = parseInt(params.get('cols') ?? '64', 10) || 64;

  const sandbox = createSandboxLayer(app, rows, cols, seed);
  viewport.addChild(sandbox.root);

  // FPS unlock (Phase 7.9 standard).
  app.ticker.maxFPS = 0;
  app.ticker.minFPS = 30;

  // Fit viewport on sandbox bounds (centered at 0,0).
  const fitX = app.screen.width / (sandbox.bounds.maxX - sandbox.bounds.minX);
  const fitY = app.screen.height / (sandbox.bounds.maxY - sandbox.bounds.minY);
  viewport.setZoom(Math.min(fitX, fitY) * 0.9, true);
  viewport.moveCenter(0, 0);

  // Resize handler reuse — sandbox không cần re-cull (single mesh always rendered).
  window.addEventListener(
    'resize',
    () => resizeViewport(app, viewport),
    { passive: true },
  );

  // HUD globals (HUD đã wire ở queueMicrotask phía dưới — chỉ set values).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.__mwApp = app;
  w.__mwViewport = viewport;
  w.__mwEngine = 'sandbox';
  w.__mwTier = `${rows}x${cols}`;
  w.__mwZoom = viewport.scale.x;
  w.__mwHexCount = sandbox.hexCount;
  w.__mwSandbox = sandbox;
  w.__mwSetZoom = (z: number): void => {
    viewport.setZoom(z, true);
    w.__mwZoom = z;
  };

  viewport.on('zoomed', () => { w.__mwZoom = viewport.scale.x; });

  performance.mark('boot-end');
  performance.measure('boot-to-playable', 'boot-start', 'boot-end');
  console.info('[boot] sandbox ready', {
    engine: 'sandbox',
    rows,
    cols,
    seed,
    hexCount: sandbox.hexCount,
    screen: { w: app.screen.width, h: app.screen.height },
  });
}

async function bootstrap(): Promise<void> {
  performance.mark('boot-start');

  const host = document.getElementById('pixi-host');
  if (!host || !(host instanceof HTMLDivElement)) {
    throw new Error('Missing #pixi-host div in index.html');
  }

  const app = await createStage();
  mountStage(app, host);

  const viewport = createViewport(app);
  app.stage.addChild(viewport);
  // Phase 6.7: infinite horizontal wrap (replaces tier-aware pan clamps).
  enableInfiniteWrap(viewport);

  // ?map=sandbox: synthetic 64×64 hex grid, 3 random country regions in middle.
  // Bypass tier/chunk/manifest infrastructure entirely — texture/shader test bed.
  const isSandbox = new URLSearchParams(location.search).get('map') === 'sandbox';
  if (isSandbox) {
    await bootstrapSandbox(app, viewport);
    return;
  }

  // Phase 7: engine selector. Default = mesh (Phase 7 path). ?engine=particles
  // falls back to Phase 6 ParticleContainer renderer (rollback path D-8).
  const engine = (new URLSearchParams(location.search).get('engine') ?? 'mesh') as 'mesh' | 'particles';

  // Particles engine: pre-emitted 3 wrap copies cover ±1.5W → clamp pan at
  // ±W to stay within coverage (else fast pan past = black map). Mesh engine
  // uses dynamic wrap-shift, no clamp needed.
  if (engine === 'particles') {
    enableWrapCopyPanClamp(viewport);
  }

  // Load common data
  const [manifest, countries] = await Promise.all([loadManifest(), loadCountries()]);
  const lut = buildColorLut(countries.countries);
  const availableTiers = new Set(Object.keys(manifest.tiles));

  // Codex-review LOW fix: validate baked colorLutHash matches runtime LUT.
  // If countries.json edited without re-running `bake:chunks`, mesh tints
  // would silently drift from particle-engine reference. Warn (don't fail).
  if (engine === 'mesh') {
    void (async () => {
      try {
        const chunksManifest = await loadChunksManifest();
        const runtimeHash = await computeColorLutHash(lut);
        if (chunksManifest.colorLutHash !== runtimeHash) {
          console.warn(
            `[mesh-hex] colorLutHash mismatch — baked=${chunksManifest.colorLutHash} runtime=${runtimeHash}. ` +
            'Re-run `npm run bake:chunks` after countries.json changes, or use ?engine=particles to render with runtime tints.',
          );
        }
      } catch (err) {
        console.warn('[mesh-hex] colorLutHash check failed', err);
      }
    })();
  }

  // Build unified layer adapter — both engines satisfy the same interface.
  let hexLayer: UnifiedHexLayer;
  if (engine === 'mesh') {
    const meshLayer = createMeshHexLayer(app);
    hexLayer = meshLayer; // signatures align (setTier async, all else identical)
  } else {
    const particles = createHexLayer(app);
    hexLayer = {
      root: particles.root,
      setTier: async (tierName: string) => {
        const td = await loadTier(tierName);
        particles.setTier(td, lut);
      },
      setBordersVisible: particles.setBordersVisible,
      updateVisibility: particles.updateVisibility,
      getStats: particles.getStats,
      destroy: particles.destroy,
    };
  }
  viewport.addChild(hexLayer.root);

  const benchmark = createBenchmark(app, hexLayer);

  // Phase 8 perf-test: ?tier=<name> locks LOD switcher + skips warm prefetch.
  // Use case: stress test single tier (e.g. ?tier=10km) without other tiers
  // polluting cache/CPU/memory. When locked, initial = locked tier, no
  // tier transitions, no adjacent prefetch.
  const lockedTier = (() => {
    const t = new URLSearchParams(location.search).get('tier');
    return t && availableTiers.has(t) ? t : null;
  })();

  // Initial: load coarsest tier (or locked tier for perf isolation).
  const initialTier = lockedTier ?? pickTier(1, availableTiers);
  const initialSizeKm = manifest.tiles[initialTier]?.sizeKm ?? 50;
  await hexLayer.setTier(initialTier, initialSizeKm);

  // Phase 7.9 FPS unlock: explicit cap-off (Pixi default 0 nhưng để rõ ràng).
  // 60fps trên iPhone là cap iOS Safari (mặc định ProMotion off cho web). FPS
  // 120 unlock bằng iOS Settings > Accessibility > Motion > Limit Frame Rate (off).
  app.ticker.maxFPS = 0;
  app.ticker.minFPS = 30;

  fitViewportToWorld(viewport, app);

  // Phase 7.9 (C): warm cache cho adjacent tiers (next-finer + next-coarser).
  // Chunks load idle-paced, không compete với active render. Khi user zoom →
  // tier switch, chunkCache đã warm → cache hit → instant build → no flash.
  const TIER_ORDER: ReadonlyArray<string> = ['50km', '25km', '10km', '5km', '2km', '1km'];
  let warmAbortController = new AbortController();
  const warmAdjacentTiers = (current: string): void => {
    if (!hexLayer.prefetchTier) return;
    warmAbortController.abort();
    warmAbortController = new AbortController();
    const sig = warmAbortController.signal;
    const idx = TIER_ORDER.indexOf(current);
    if (idx < 0) return;
    const queue: string[] = [];
    if (TIER_ORDER[idx + 1] && availableTiers.has(TIER_ORDER[idx + 1]!)) queue.push(TIER_ORDER[idx + 1]!);
    if (TIER_ORDER[idx - 1] && availableTiers.has(TIER_ORDER[idx - 1]!)) queue.push(TIER_ORDER[idx - 1]!);
    if (TIER_ORDER[idx + 2] && availableTiers.has(TIER_ORDER[idx + 2]!)) queue.push(TIER_ORDER[idx + 2]!);
    void (async () => {
      for (const t of queue) {
        if (sig.aborted) return;
        try { await hexLayer.prefetchTier!(t, sig); } catch { /* best-effort */ }
      }
    })();
  };
  // Skip warm prefetch when ?tier= locked — perf test wants single-tier isolation.
  if (!lockedTier) warmAdjacentTiers(initialTier);

  // Phase 6: viewport-based chunk culling. cullNow() fires synchronously so
  // first frame after setTier renders only visible chunks (no blank flash).
  const cullNow = (): void => {
    const r = viewport.getVisibleBounds();
    hexLayer.updateVisibility({
      minX: r.x,
      minY: r.y,
      maxX: r.x + r.width,
      maxY: r.y + r.height,
    });
  };
  const updateVisibleChunks = throttleRaf(cullNow);
  // Phase 8.3: wire cullNow for static-viewport QueueFullError retry rAF driver.
  hexLayer.setCullNow?.(cullNow);
  cullNow();

  // Resize handler
  window.addEventListener('resize', () => resizeViewport(app, viewport), { passive: true });
  window.addEventListener('orientationchange', () => resizeViewport(app, viewport), { passive: true });

  performance.mark('boot-end');
  performance.measure('boot-to-playable', 'boot-start', 'boot-end');
  const m = performance.getEntriesByName('boot-to-playable').pop();
  console.info('[boot] ready', {
    engine,
    bootMs: m ? Math.round(m.duration) : null,
    initialTier,
    countryCount: countries.countries.length,
    hexCount: manifest.tiles[initialTier]?.hexCount ?? 0,
    screen: { w: app.screen.width, h: app.screen.height },
  });

  // LOD switcher (basic) — re-load tier when zoom band changes
  let currentTier = initialTier;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.__mwEngine = engine;
  w.__mwTier = currentTier;
  w.__mwZoom = viewport.scale.x;
  w.__mwHexCount = manifest.tiles[initialTier]?.hexCount ?? 0;

  // Justin 2026-04-26: borders chỉ visible khi zoom >= 0.9× để tránh sọc
  // mờ moiré ở fit-to-screen. Inner-country hexes seamless via pure-fill texture.
  const BORDERS_VISIBLE_ZOOM = 0.9;
  hexLayer.setBordersVisible(viewport.scale.x >= BORDERS_VISIBLE_ZOOM);

  // Debug hook for headless screenshot tests — không dùng trong gameplay.
  w.__mwViewport = viewport;
  w.__mwSetZoom = (z: number): void => {
    viewport.setZoom(z, true);
    hexLayer.setBordersVisible(z >= BORDERS_VISIBLE_ZOOM);
    w.__mwZoom = z;
    // pixi-viewport.setZoom() không emit 'zoomed' (chỉ user-driven mới emit).
    // Fire manually để LOD switcher pick up tier change cho headless test.
    viewport.emit('zoomed', { type: 'animate', viewport });
    cullNow(); // sync cull — headless tests screenshot before rAF fires
  };
  w.__mwCenterOn = (lng: number, lat: number): void => {
    // Mercator → world px (Y-negated for screen-down).
    const lngRad = (lng * Math.PI) / 180;
    const latClamp = Math.max(-85, Math.min(85, lat));
    const yMerc = Math.log(Math.tan(Math.PI / 4 + (latClamp * Math.PI) / 360));
    viewport.moveCenter(lngRad * 1024, -yMerc * 1024);
    cullNow();
  };
  w.__mwCullNow = cullNow;
  w.__mwHexLayer = hexLayer;
  w.__mwBenchmark = (): unknown => benchmark.snapshot();
  w.__mwBenchReset = (): void => benchmark.reset();
  // Phase 8 H3 cold-cache stress hook for bench scenario 4. Awaits jobCount
  // loadChunk dispatches against the worker pool and returns { latencies, failedCount }.
  // Particles engine doesn't expose forceWorkerStress → returns empty result.
  w.__mwForceWorkerStress = (jobCount: number): Promise<{ latencies: number[]; failedCount: number }> =>
    hexLayer.forceWorkerStress?.(jobCount) ?? Promise.resolve({ latencies: [], failedCount: 0 });

  const updateHud = (): void => {
    w.__mwZoom = viewport.scale.x;
    w.__mwTier = currentTier;
    hexLayer.setBordersVisible(viewport.scale.x >= BORDERS_VISIBLE_ZOOM);
  };

  // Debounce LOD switch so rapid pinch / momentum scale changes don't thrash.
  let lodSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  let lodInFlight = false;

  const maybeSwitchLod = (): void => {
    // Lock tier when ?tier= URL param set — perf test isolation.
    if (lockedTier) return;
    if (lodSwitchTimer) clearTimeout(lodSwitchTimer);
    lodSwitchTimer = setTimeout(() => {
      lodSwitchTimer = null;
      if (lodInFlight) return;
      // currentTier is always a valid TierName (validated via manifest.tiles) — safe cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const next = pickTier(viewport.scale.x, availableTiers, currentTier as any);
      if (next === currentTier) return;
      lodInFlight = true;
      const fromTier = currentTier;
      const sizeKm = manifest.tiles[next]?.sizeKm ?? 50;
      void (async () => {
        try {
          await hexLayer.setTier(next, sizeKm);
          currentTier = next;
          // Phase 6: re-cull immediately for new tier so first post-switch
          // frame already shows visible chunks (else 1-frame blank flash).
          cullNow();
          // Phase 7.9 (C): warm cache cho tier kế của tier mới.
          warmAdjacentTiers(next);
          benchmark.recordTierSwitch(fromTier, next, hexLayer.getStats().lastTierSwitchMs);
          w.__mwTier = currentTier;
          w.__mwHexCount = manifest.tiles[next]?.hexCount ?? 0;
          console.info(`[lod] → ${next} at zoom ${viewport.scale.x.toFixed(2)}`);
        } catch (err) {
          console.warn(`[lod] tier ${next} load failed`, err);
        } finally {
          lodInFlight = false;
        }
      })();
    }, 250);
  };

  viewport.on('zoomed', () => {
    updateHud();
    maybeSwitchLod();
    updateVisibleChunks();
  });
  viewport.on('moved', () => {
    updateHud();
    updateVisibleChunks();
  });

  // FPS sampler — Pixi Application.ticker.FPS already smoothed.
  w.__mwApp = app;
}

bootstrap().catch((err) => {
  console.error('[boot] fatal:', err);
  document.body.innerHTML = `<pre style="color:#f00;padding:16px;font-family:monospace;">[boot] ${err instanceof Error ? err.message : String(err)}</pre>`;
});

// ─────────────────────────────────────────────────────────────────────────────
// Debug HUD — engine + tier + zoom + memory + FPS history + chunk stats.
// Justin 2026-04-26: extended với memory peak/settled tracking để verify
// trên iPhone Safari trực tiếp (không cần Mac+DevTools).
// Phase 7 merge: line 3 thêm chunk visible/built + build/cull/tier-switch ms.
//
// Layout:
//   Line 1: engine | fps (current) | fps p95 (last 5s) | tier | zoom | hexes
//   Line 2: mem now | mem peak (60s) | mem settled (post-GC)
//   Line 3: chunks visible/built | last build/cull/tier-switch (Phase 7+)
//
// Memory column reads `performance.memory` (Chromium) hoặc fallback "—" trên iOS.
// iOS Safari không expose performance.memory → trên iPhone Mac DevTools cần thiết.
// NHƯNG fps + tier + zoom + hexes + chunks hiển thị đầy đủ trên mobile.
// ─────────────────────────────────────────────────────────────────────────────
queueMicrotask(() => {
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;top:env(safe-area-inset-top, 8px);left:8px;' +
    'color:#00e5ff;font:11px/1.4 "JetBrains Mono",ui-monospace,monospace;' +
    'background:rgba(0,8,20,.85);padding:6px 8px;border:1px solid #0088aa;' +
    'border-radius:3px;z-index:9999;pointer-events:none;white-space:pre;' +
    'min-width:240px;letter-spacing:0.02em;';
  hud.textContent = 'engine: — | fps: — | tier: — | zoom: —\nmem: — | peak: — | settled: —';
  document.body.appendChild(hud);

  // ── FPS history ring buffer (last 5s @ 4Hz sample = 20 samples) ──
  const FPS_RING_SIZE = 20;
  const fpsRing: number[] = new Array(FPS_RING_SIZE).fill(0);
  let fpsRingIdx = 0;

  const sampleFps = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const fps = w.__mwApp?.ticker?.FPS ?? 0;
    fpsRing[fpsRingIdx] = fps;
    fpsRingIdx = (fpsRingIdx + 1) % FPS_RING_SIZE;
  };

  const fpsP95 = (): number => {
    const sorted = [...fpsRing].filter((v) => v > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const idx = Math.floor(sorted.length * 0.05); // p95 lower bound (worst 5%)
    return sorted[idx] ?? 0;
  };

  // ── Memory tracking (Chromium only; iOS fallback) ──
  type PerfMem = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getMem = (): PerfMem | null => (performance as any).memory ?? null;

  let memPeakMb = 0;
  let memSettledMb = 0;
  let lastSettledSampleAt = 0;

  // Reset peak via tap on HUD (in case anh muốn re-baseline mid-test).
  hud.addEventListener('click', () => {
    memPeakMb = 0;
    fpsRing.fill(0);
  });
  hud.style.pointerEvents = 'auto';
  hud.style.cursor = 'pointer';
  hud.title = 'Tap to reset peak';

  // Sample FPS every 250ms (4Hz)
  setInterval(() => {
    sampleFps();
  }, 250);

  // Sample memory every 100ms — pre-GC peak detection
  setInterval(() => {
    const mem = getMem();
    if (mem) {
      const usedMb = mem.usedJSHeapSize / 1048576;
      if (usedMb > memPeakMb) memPeakMb = usedMb;
    }
  }, 100);

  // Sample "settled" memory every 2000ms — post-GC approximation.
  // V8 typically completes major GC cycle within 1-2s of pressure.
  // Sampling at 2Hz period vs 100ms peak captures post-GC stable value.
  setInterval(() => {
    const mem = getMem();
    if (mem) {
      memSettledMb = mem.usedJSHeapSize / 1048576;
      lastSettledSampleAt = performance.now();
    }
  }, 2000);

  // Render HUD every 250ms
  setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const eng = w.__mwEngine ?? '—';
    const z = w.__mwZoom ?? 0;
    const t = w.__mwTier ?? '—';
    const h = w.__mwHexCount ?? 0;
    const fps = w.__mwApp?.ticker?.FPS ?? 0;
    const p95 = fpsP95();
    const stats = w.__mwHexLayer?.getStats?.();

    const mem = getMem();
    const memNowMb = mem ? mem.usedJSHeapSize / 1048576 : null;
    const memSettledAge = lastSettledSampleAt ? (performance.now() - lastSettledSampleAt) / 1000 : 0;

    const line1 =
      `engine: ${eng} | fps: ${fps.toFixed(0)} (p95 ${p95.toFixed(0)}) | ` +
      `tier: ${t} | zoom: ${z.toFixed(2)}× | hexes: ${h.toLocaleString()}`;

    const memStr = memNowMb !== null
      ? `mem: ${memNowMb.toFixed(0)}MB | peak: ${memPeakMb.toFixed(0)}MB | ` +
        `settled: ${memSettledMb.toFixed(0)}MB (${memSettledAge.toFixed(0)}s ago)`
      : 'mem: iOS Safari (use Mac Web Inspector) | tap HUD to reset peak';

    // Phase 7: chunk stats line — only when hexLayer.getStats() available.
    const chunkStr = stats
      ? `chunks: ${stats.visibleChunks}/${stats.totalChunks} visible, ${stats.builtChunks} built | ` +
        `build: ${stats.lastBuildMs.toFixed(1)}ms | cull: ${stats.lastCullMs.toFixed(1)}ms | switch: ${stats.lastTierSwitchMs.toFixed(1)}ms`
      : '';

    // Phase 8: worker pool stats line.
    // NOTE: performance.memory = main thread only. Worker heap excluded.
    // Total process memory = main + Σ(worker heaps). Use DevTools for full view.
    const poolStats = getWorkerPoolStats();
    const decodeMode = getDecodeMode();
    const poolSize = getWorkerPoolSize();
    const workerStr = decodeMode === 'worker' && poolStats
      ? `decode: worker(${poolSize}) | active: ${poolStats.activeJobs} | queue: ${poolStats.queueDepth} | post p95: ${poolStats.p95LatencyMs.toFixed(1)}ms`
      : `decode: main`;

    hud.textContent = [line1, memStr, chunkStr, workerStr].filter(Boolean).join('\n');

    // Color-code: red khi memory peak > 250MB target (Justin 2026-04-26).
    if (memNowMb !== null && memPeakMb > 250) {
      hud.style.color = '#ff5566';
      hud.style.borderColor = '#ff5566';
    } else if (p95 > 0 && p95 < 55) {
      hud.style.color = '#ffaa00';
      hud.style.borderColor = '#ffaa00';
    } else {
      hud.style.color = '#00e5ff';
      hud.style.borderColor = '#0088aa';
    }
  }, 250);
});
