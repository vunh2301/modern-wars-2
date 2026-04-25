/**
 * pixi-viewport setup. SPEC Section 5.4.
 *
 * Construction MUST pass `events: app.renderer.events` (v8 requirement).
 * Clamp zoom min=0.3 / max=3 to align with LOD tier-2 threshold (Section 5.2).
 */
import type { Application } from 'pixi.js';
import { Viewport } from 'pixi-viewport';

export const WORLD_W = 3600;
export const WORLD_H = 1800;

export function createViewport(app: Application): Viewport {
  const viewport = new Viewport({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (app.renderer as any).events,
    screenWidth: app.screen.width,
    screenHeight: app.screen.height,
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    passiveWheel: false,
  });

  viewport
    .drag()
    .pinch()
    .wheel()
    .decelerate()
    .clampZoom({ minScale: 0.3, maxScale: 3 });

  return viewport;
}

/**
 * Re-bound viewport on resize/orientation change. Caller wires this to
 * `ResizeObserver` + `matchMedia('(orientation:portrait)')` per Section 5.4.
 */
export function resizeViewport(app: Application, viewport: Viewport): void {
  viewport.resize(app.screen.width, app.screen.height, WORLD_W, WORLD_H);
}
