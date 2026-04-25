/**
 * pixi-viewport setup. SPEC v1.0 Section 3 + 6.
 *
 * Pinch zoom 1× → 32×, drag pan, decelerate. Constructed with
 * `events: app.renderer.events` (Pixi v8 requirement).
 */
import type { Application } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { worldBoundsPx } from '../geo/projection';

export function createViewport(app: Application): Viewport {
  const bounds = worldBoundsPx();
  const viewport = new Viewport({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (app.renderer as any).events,
    screenWidth: app.screen.width,
    screenHeight: app.screen.height,
    worldWidth: bounds.width,
    worldHeight: bounds.height,
    passiveWheel: false,
  });

  viewport
    .drag()
    .pinch()
    .wheel()
    .decelerate({ friction: 0.93 })
    .clampZoom({ minScale: 0.5, maxScale: 32 });

  return viewport;
}

/**
 * Initial view: 1.5× zoom centered at (lng=0°, lat=20°N) per SPEC v1.0-locked
 * Section 1 acceptance + Section 14 confirmed decision #5.
 *
 * 1.5× = "fit-to-screen" × 1.5 (slightly zoomed in vs naive fitWorld so
 * Asia + Europe + N. America visible together, Antarctica off-screen).
 */
export function fitViewportToWorld(viewport: Viewport, app: Application): void {
  const bounds = worldBoundsPx();
  const fitScaleX = app.screen.width / bounds.width;
  const fitScaleY = app.screen.height / bounds.height;
  const fitScale = Math.min(fitScaleX, fitScaleY);
  viewport.setZoom(fitScale * 1.5, true);
  // Center at (lng=0°, lat=20°N) → world px (Y inverted for screen-down).
  // Mercator y for lat=20° = log(tan(π/4 + 20°·π/360)) ≈ 0.357 rad
  // World px y = -0.357 * 1024 ≈ -366 (north = up = negative screen Y)
  viewport.moveCenter(0, -0.357 * 1024);
}

export function resizeViewport(app: Application, viewport: Viewport): void {
  const bounds = worldBoundsPx();
  viewport.resize(app.screen.width, app.screen.height, bounds.width, bounds.height);
}
