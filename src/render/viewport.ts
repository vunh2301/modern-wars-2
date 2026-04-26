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
 * Phase 6.7: Infinite horizontal wrap. Snap viewport.center.x vào canonical
 * range [-W/2, +W/2] khi user pan vượt biên — invisible (visual identical
 * vì hex grid wrap-instance copies fill seamlessly).
 *
 * Hotfix 2026-04-26 (Justin iPhone test): trước đây snap fire trên 'moved'
 * EVENT (continuous during drag/decelerate). pixi-viewport drag plugin track
 * pointer delta nội bộ — moveCenter mid-drag breaks delta calculation →
 * screen "giật ngược" + map mất. Fix: chỉ snap trên 'moved-end' (sau khi
 * drag + decelerate hoàn tất). Wrap-instance copies trong rbush (offsets
 * [-W, 0, +W]) đã cover khi user pan past seam → không thấy empty area
 * trong lúc đang kéo. Snap silent trên release.
 *
 * Y vẫn clamp (Mercator chỉ wrap longitude). Reuse pixi-viewport's intrinsic
 * Y bounds via worldHeight in createViewport.
 */
export function enableInfiniteWrap(viewport: Viewport): void {
  const W = WRAP_DISTANCE_PX;
  const HALF_W = W / 2;
  let snapping = false;

  const trySnap = (): void => {
    if (snapping) return;
    const cx = viewport.center.x;
    if (cx > HALF_W) {
      snapping = true;
      viewport.moveCenter(cx - W, viewport.center.y);
      snapping = false;
    } else if (cx < -HALF_W) {
      snapping = true;
      viewport.moveCenter(cx + W, viewport.center.y);
      snapping = false;
    }
  };

  // ONLY snap on 'moved-end' — fired after drag + decelerate complete.
  // 'moved' (continuous during drag) DELIBERATELY NOT handled — would
  // interrupt drag plugin's pointer-delta tracking and cause visible jump.
  viewport.on('moved-end', trySnap);
}
