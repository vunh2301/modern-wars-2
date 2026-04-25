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
  viewport.on('zoomed', () => {
    void (async () => {
      const next = pickTier(viewport.scale.x, availableTiers);
      if (next === currentTier) return;
      try {
        const td = await loadTier(next);
        currentTier = next;
        hexLayer.setTier(td, lut);
        console.info(`[lod] switched to tier ${next} at zoom ${viewport.scale.x.toFixed(2)}`);
      } catch (err) {
        console.warn(`[lod] tier ${next} load failed`, err);
      }
    })();
  });
}

bootstrap().catch((err) => {
  console.error('[boot] fatal:', err);
  document.body.innerHTML = `<pre style="color:#f00;padding:16px;font-family:monospace;">[boot] ${err instanceof Error ? err.message : String(err)}</pre>`;
});
