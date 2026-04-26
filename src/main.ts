/**
 * Bootstrap entry. SPEC v1.0 Section 11 Phase 0-3.
 *
 * Phase 0: empty Pixi canvas full-screen.
 * Phase 2: data loader (manifest + countries + tier).
 * Phase 3: viewport + hex layer + initial render.
 */
import { createStage, mountStage } from './render/stage';
import {
  createViewport,
  fitViewportToWorld,
  resizeViewport,
  enableXPanClamp,
  disableXPanClamp,
} from './render/viewport';
import { createHexLayer } from './render/hexLayer';
import { loadManifest } from './data/manifest';
import { loadCountries } from './data/countries';
import { loadTier } from './data/tiers';
import { buildColorLut } from './render/colors';
import { pickTier } from './render/lod';

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

  const hexLayer = createHexLayer(app);
  viewport.addChild(hexLayer.root);

  // Load data
  const [manifest, countries] = await Promise.all([loadManifest(), loadCountries()]);
  const lut = buildColorLut(countries.countries);
  const availableTiers = new Set(Object.keys(manifest.tiles));

  // Coarse tier wraps; fine tier (10km) needs clamp để tránh empty edge.
  const TIERS_WITH_WRAP: ReadonlySet<string> = new Set(['50km', '25km']);
  const applyPanClampForTier = (tierName: string): void => {
    if (TIERS_WITH_WRAP.has(tierName)) disableXPanClamp(viewport);
    else enableXPanClamp(viewport);
  };

  // Initial: load coarsest tier for instant world view
  const initialTier = pickTier(1, availableTiers);
  const tier = await loadTier(initialTier);
  hexLayer.setTier(tier, lut);
  applyPanClampForTier(initialTier);

  fitViewportToWorld(viewport, app);

  // Resize handler
  window.addEventListener('resize', () => resizeViewport(app, viewport), { passive: true });
  window.addEventListener('orientationchange', () => resizeViewport(app, viewport), { passive: true });

  performance.mark('boot-end');
  performance.measure('boot-to-playable', 'boot-start', 'boot-end');
  const m = performance.getEntriesByName('boot-to-playable').pop();
  console.info('[boot] ready', {
    bootMs: m ? Math.round(m.duration) : null,
    initialTier,
    countryCount: countries.countries.length,
    hexCount: tier.hexes.length,
    screen: { w: app.screen.width, h: app.screen.height },
  });

  // LOD switcher (basic) — re-load tier when zoom band changes
  let currentTier = initialTier;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.__mwTier = currentTier;
  w.__mwZoom = viewport.scale.x;
  w.__mwHexCount = tier.hexes.length;

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
  };
  w.__mwCenterOn = (lng: number, lat: number): void => {
    // Mercator → world px (Y-negated for screen-down).
    const lngRad = (lng * Math.PI) / 180;
    const latClamp = Math.max(-85, Math.min(85, lat));
    const yMerc = Math.log(Math.tan(Math.PI / 4 + (latClamp * Math.PI) / 360));
    viewport.moveCenter(lngRad * 1024, -yMerc * 1024);
  };

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
      void (async () => {
        try {
          const td = await loadTier(next);
          currentTier = next;
          hexLayer.setTier(td, lut);
          applyPanClampForTier(currentTier);
          w.__mwTier = currentTier;
          w.__mwHexCount = td.hexes.length;
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
  });
  viewport.on('moved', updateHud);

  // FPS sampler — Pixi Application.ticker.FPS already smoothed.
  w.__mwApp = app;
}

bootstrap().catch((err) => {
  console.error('[boot] fatal:', err);
  document.body.innerHTML = `<pre style="color:#f00;padding:16px;font-family:monospace;">[boot] ${err instanceof Error ? err.message : String(err)}</pre>`;
});

// ─────────────────────────────────────────────────────────────────────────────
// Debug HUD — tier + zoom + memory + FPS history.
// Justin 2026-04-26: extended với memory peak/settled tracking để verify
// trên iPhone Safari trực tiếp (không cần Mac+DevTools).
//
// Layout:
//   Line 1: fps (current) | fps p95 (last 5s) | tier | zoom | hexes
//   Line 2: mem now | mem peak (60s) | mem settled (post-GC)
//
// Memory column reads `performance.memory` (Chromium) hoặc fallback "—" trên iOS.
// iOS Safari không expose performance.memory → trên iPhone Mac DevTools cần thiết.
// NHƯNG fps + tier + zoom + hexes hiển thị đầy đủ trên mobile, đủ verify Phase 7.
// ─────────────────────────────────────────────────────────────────────────────
queueMicrotask(() => {
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;top:env(safe-area-inset-top, 8px);left:8px;' +
    'color:#00e5ff;font:11px/1.4 "JetBrains Mono",ui-monospace,monospace;' +
    'background:rgba(0,8,20,.85);padding:6px 8px;border:1px solid #0088aa;' +
    'border-radius:3px;z-index:9999;pointer-events:none;white-space:pre;' +
    'min-width:240px;letter-spacing:0.02em;';
  hud.textContent = 'fps: — | tier: — | zoom: —\nmem: — | peak: — | settled: —';
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
    const z = w.__mwZoom ?? 0;
    const t = w.__mwTier ?? '—';
    const h = w.__mwHexCount ?? 0;
    const fps = w.__mwApp?.ticker?.FPS ?? 0;
    const p95 = fpsP95();

    const mem = getMem();
    const memNowMb = mem ? mem.usedJSHeapSize / 1048576 : null;
    const memSettledAge = lastSettledSampleAt ? (performance.now() - lastSettledSampleAt) / 1000 : 0;

    const line1 =
      `fps: ${fps.toFixed(0)} (p95 ${p95.toFixed(0)}) | ` +
      `tier: ${t} | zoom: ${z.toFixed(2)}× | hexes: ${h.toLocaleString()}`;

    const memStr = memNowMb !== null
      ? `mem: ${memNowMb.toFixed(0)}MB | peak: ${memPeakMb.toFixed(0)}MB | ` +
        `settled: ${memSettledMb.toFixed(0)}MB (${memSettledAge.toFixed(0)}s ago)`
      : 'mem: iOS Safari (use Mac Web Inspector) | tap HUD to reset peak';

    hud.textContent = `${line1}\n${memStr}`;

    // Color-code: red khi memory peak > 250MB target
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

