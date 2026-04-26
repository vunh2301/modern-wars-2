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
    .clampZoom({ minScale: 0.20, maxScale: 8 });
  // Pan clamp dynamic per-tier (xem main.ts setPanClampForTier):
  // coarse tier có wrap copies → no clamp (user pan freely past seam);
  // 10km tier no wrap → clamp ±W/2 để tránh empty edge.

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
  // worldWidth phải khớp WRAP_DISTANCE_PX (đã set trong createViewport),
  // không phải bounds.width = 2π·R thô — nếu khác sẽ break clamp boundaries.
  viewport.resize(app.screen.width, app.screen.height, WRAP_DISTANCE_PX, bounds.height);
}

/**
 * Phase 6.7 + Hotfix 2026-04-26: Infinite horizontal wrap.
 *
 * Approach: viewport.center.x is NEVER snapped (no jump, drag plugin
 * unaffected). Instead, hexLayer's updateVisibility computes a wrapShift
 * (floor((cx) / W) * W) and renders chunk meshes at offsetX + wrapShift so
 * they cover viewport's actual world position regardless of drift.
 *
 * Result: user can fast-fling map sang trái/phải vô hạn — wrap copies
 * always in viewport. No visible jump. No "map mất" symptom.
 *
 * This function previously snapped viewport position; now it's a no-op
 * (kept for API compat — main.ts still calls). Y bounds via createViewport.
 */
/**
 * Pan clamp at ±W (= canonical + 1 wrap copy on each side).
 * Used by ?engine=particles where Phase 6 pre-emits 3 wrap copies (offsets
 * [-W, 0, +W]) covering visible world ∈ [-1.5W, +1.5W]. Without clamp,
 * fast drag could push viewport.center.x past ±1.5W → black map.
 */
export function enableWrapCopyPanClamp(viewport: Viewport): void {
  viewport.plugins.remove('clamp');
  viewport.clamp({
    left: -WRAP_DISTANCE_PX,
    right: WRAP_DISTANCE_PX,
    top: null,
    bottom: null,
  });
}

export function enableInfiniteWrap(_viewport: Viewport): void {
  // Intentional no-op — wrap rendering handled in hexLayer.updateVisibility.
  void _viewport;
}
