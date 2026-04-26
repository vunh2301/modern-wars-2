/**
 * pixi-viewport setup. SPEC v1.0 Section 3 + 6.
 *
 * Pinch zoom 1× → 32×, drag pan, decelerate. Constructed with
 * `events: app.renderer.events` (Pixi v8 requirement).
 */
import type { Application } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { worldBoundsPx, WRAP_DISTANCE_PX } from '../geo/projection';

export function createViewport(app: Application): Viewport {
  const bounds = worldBoundsPx();
  const viewport = new Viewport({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (app.renderer as any).events,
    screenWidth: app.screen.width,
    screenHeight: app.screen.height,
    // worldWidth = wrap-aligned hex grid span (slightly > 2π·R for hex pitch fit).
    worldWidth: WRAP_DISTANCE_PX,
    worldHeight: bounds.height,
    passiveWheel: false,
  });

  viewport
    .drag()
    .pinch()
    .wheel()
    .decelerate({ friction: 0.93 })
    .clampZoom({ minScale: 0.20, maxScale: 8 })
    // Clamp pan to canonical world width so user never sees empty space
    // beyond wrap copies. Wrap copies (50km/25km only) handle visual seam
    // when viewport extends past canonical edge near boundary.
    .clamp({ direction: 'x' });

  return viewport;
}

/**
 * Initial view per SPEC v1.0-locked Section 14 #5: zoom 1.5× of fit-to-screen,
 * center (lng=0°, lat=20°N). On portrait phone (430×932), fitScale ≈ 0.067
 * (430/6435 world width). 1.5× → 0.1.
 *
 * To realistically show Asia + Europe + N. America together: cap initial zoom
 * to whichever is larger of (fit-horizontal, fit-vertical) × 0.9 so the
 * world fits comfortably with small margin.
 */
export function fitViewportToWorld(viewport: Viewport, app: Application): void {
  const bounds = worldBoundsPx();
  const fitX = app.screen.width / bounds.width;
  const fitY = app.screen.height / bounds.height;
  // Use the LARGER fit ratio so the smaller dimension fills the screen tightly,
  // letting the other dimension overflow (typical map app behavior).
  // Initial zoom respects clampZoom.minScale (0.20×).
  const initialZoom = Math.max(0.20, Math.max(fitX, fitY) * 0.9);
  viewport.setZoom(initialZoom, true);
  // Center at (lng=0°, lat=20°N) → world px (Y inverted for screen-down).
  viewport.moveCenter(0, -0.357 * 1024);
}

export function resizeViewport(app: Application, viewport: Viewport): void {
  const bounds = worldBoundsPx();
  viewport.resize(app.screen.width, app.screen.height, bounds.width, bounds.height);
}
