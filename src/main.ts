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
} from './render/viewport';
import { createHexLayer } from './render/hexLayer';
import { createMeshHexLayer } from './render/meshHexLayer';
import { createBenchmark } from './render/benchmark';
import { loadManifest } from './data/manifest';
import { loadCountries } from './data/countries';
import { loadTier } from './data/tiers';
import { loadChunksManifest, computeColorLutHash } from './data/chunks';
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
  destroy(): void;
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

  // Phase 7: engine selector. Default = mesh (Phase 7 path). ?engine=particles
  // falls back to Phase 6 ParticleContainer renderer (rollback path D-8).
  const engine = (new URLSearchParams(location.search).get('engine') ?? 'mesh') as 'mesh' | 'particles';

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

  // Initial: load coarsest tier for instant world view
  const initialTier = pickTier(1, availableTiers);
  const initialSizeKm = manifest.tiles[initialTier]?.sizeKm ?? 50;
  await hexLayer.setTier(initialTier, initialSizeKm);

  fitViewportToWorld(viewport, app);

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

  const updateHud = (): void => {
    w.__mwZoom = viewport.scale.x;
    w.__mwTier = currentTier;
    hexLayer.setBordersVisible(viewport.scale.x >= BORDERS_VISIBLE_ZOOM);
  };

  // Debounce LOD switch so rapid pinch / momentum scale changes don't thrash.
  let lodSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  let lodInFlight = false;

  const maybeSwitchLod = (): void => {
    if (lodSwitchTimer) clearTimeout(lodSwitchTimer);
    lodSwitchTimer = setTimeout(() => {
      lodSwitchTimer = null;
      if (lodInFlight) return;
      const next = pickTier(viewport.scale.x, availableTiers, currentTier);
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

// Debug HUD: tier + zoom + Phase 6 chunk metrics + Phase 7 engine (top-left).
queueMicrotask(() => {
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:env(safe-area-inset-top, 8px);left:8px;color:#00e5ff;font:11px/1.4 \'JetBrains Mono\',monospace;background:rgba(0,8,20,.7);padding:4px 6px;border:1px solid #0088aa;z-index:9999;pointer-events:none;white-space:pre;';
  hud.textContent = 'engine: — | tier: — | zoom: —';
  document.body.appendChild(hud);
  setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const eng = w.__mwEngine ?? '—';
    const z = w.__mwZoom ?? 0;
    const t = w.__mwTier ?? '—';
    const h = w.__mwHexCount ?? 0;
    const fps = w.__mwApp?.ticker?.FPS ?? 0;
    const stats = w.__mwHexLayer?.getStats?.();
    const line1 = `engine: ${eng} | fps: ${fps.toFixed(0)} | tier: ${t} | zoom: ${z.toFixed(2)}× | hexes: ${h.toLocaleString()}`;
    const line2 = stats
      ? `chunks: ${stats.visibleChunks}/${stats.totalChunks} visible | built: ${stats.builtChunks}/${stats.totalChunks}`
      : '';
    const line3 = stats
      ? `last build: ${stats.lastBuildMs.toFixed(2)}ms | last cull: ${stats.lastCullMs.toFixed(2)}ms | tier-switch: ${stats.lastTierSwitchMs.toFixed(1)}ms`
      : '';
    hud.textContent = [line1, line2, line3].filter(Boolean).join('\n');
  }, 250);
});
