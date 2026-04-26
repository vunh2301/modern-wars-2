/**
 * Bootstrap entry. SPEC v1.0 Section 11 Phase 0-3.
 *
 * Phase 0: empty Pixi canvas full-screen.
 * Phase 2: data loader (manifest + countries + tier).
 * Phase 3: viewport + hex layer + initial render.
 */
import { createStage, mountStage } from './render/stage';
import { createViewport, fitViewportToWorld, resizeViewport } from './render/viewport';
import { createHexLayer } from './render/hexLayer';
import { loadManifest } from './data/manifest';
import { loadCountries } from './data/countries';
import { loadTier } from './data/tiers';
import { buildColorLut } from './render/colors';
import { pickTier } from './render/lod';
import { WRAP_DISTANCE_PX, WRAP_Y_SHIFT_PX } from './geo/projection';

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

  // Initial: load coarsest tier for instant world view
  const initialTier = pickTier(1, availableTiers);
  const tier = await loadTier(initialTier);
  hexLayer.setTier(tier, lut);

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

  // World wrap: hexLayer renders 3 copies at offsets ±W (50km/25km tiers).
  // User pan smoothly into wrap copies — user may pan total ±1.5W before
  // seeing empty edge. NO viewport.center snap (Justin 2026-04-26 "khựng
  // giật ngược camera" — snap jerks UX).
  void WRAP_DISTANCE_PX;
  void WRAP_Y_SHIFT_PX;

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

// Debug HUD: tier + zoom indicator (top-left, small monospace).
// Enables quick visual confirmation that LOD switcher fires correctly.
queueMicrotask(() => {
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:env(safe-area-inset-top, 8px);left:8px;color:#00e5ff;font:11px/1.3 \'JetBrains Mono\',monospace;background:rgba(0,8,20,.7);padding:4px 6px;border:1px solid #0088aa;z-index:9999;pointer-events:none;';
  hud.textContent = 'tier: — | zoom: —';
  document.body.appendChild(hud);
  setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const z = w.__mwZoom ?? 0;
    const t = w.__mwTier ?? '—';
    const h = w.__mwHexCount ?? 0;
    const fps = w.__mwApp?.ticker?.FPS ?? 0;
    hud.textContent =
      `fps: ${fps.toFixed(0)} | tier: ${t} | zoom: ${z.toFixed(2)}× | hexes: ${h.toLocaleString()}`;
  }, 250);
});

