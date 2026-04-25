/**
 * Bootstrap entry. SPEC Section 11 Phase 0 — empty Pixi canvas full-screen.
 *
 * Subsequent phases:
 *   Phase 2 → src/data/* (tier loaders + IndexedDB)
 *   Phase 3 → src/render/viewport + hexLayer
 *   Phase 4 → src/render/lod (tier picker + hysteresis)
 *   Phase 5 → src/benchmark/* + stats.js HUD
 */
import { createStage, mountStage } from './render/stage';

async function bootstrap(): Promise<void> {
  const host = document.getElementById('pixi-host');
  if (!host || !(host instanceof HTMLDivElement)) {
    throw new Error('Missing #pixi-host div in index.html');
  }
  const app = await createStage();
  mountStage(app, host);

  // Phase 0 sanity ping: console marker so we can confirm boot order in DevTools.
  console.info('[boot] stage mounted', {
    width: app.screen.width,
    height: app.screen.height,
    resolution: app.renderer.resolution,
  });
}

bootstrap().catch((err) => {
  console.error('[boot] fatal:', err);
});
