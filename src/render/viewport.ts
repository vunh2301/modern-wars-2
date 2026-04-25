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

export function fitViewportToWorld(viewport: Viewport, app: Application): void {
  const bounds = worldBoundsPx();
  const scaleX = app.screen.width / bounds.width;
  const scaleY = app.screen.height / bounds.height;
  const scale = Math.min(scaleX, scaleY);
  viewport.setZoom(scale, true);
  viewport.moveCenter(0, 0); // mercator center is at (0, 0)
}

export function resizeViewport(app: Application, viewport: Viewport): void {
  const bounds = worldBoundsPx();
  viewport.resize(app.screen.width, app.screen.height, bounds.width, bounds.height);
}
