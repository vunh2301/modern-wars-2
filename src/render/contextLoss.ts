/**
 * WebGL context loss handler. SPEC Section 13.3.
 *
 * iOS Safari often loses WebGL context on background tab > 30s, low memory
 * pressure, or thermal events. Pause sim, show overlay, recover when
 * webglcontextrestored fires.
 *
 * Recovery scope (Phase 8 MVP): pause + auto-resume on restore. Full
 * `rebuildPixiResources` (re-upload geometry from cached tier files) deferred
 * to Phase 7 polish — Pixi v8 typically auto-recovers if textures still in JS heap.
 */
import type { Application } from 'pixi.js';
import { useGameStore } from '../state/store';
import { emit } from '../telemetry/emit';

export interface ContextLossHandle {
  detach: () => void;
}

export function attachContextLossHandler(app: Application): ContextLossHandle {
  // Pixi v8 canvas via app.canvas.
  const canvas = app.canvas as HTMLCanvasElement | undefined;
  if (!canvas) return { detach: () => {} };

  let wasPaused = false;

  const onLost = (e: Event): void => {
    e.preventDefault();
    wasPaused = useGameStore.getState().paused;
    useGameStore.getState().setPaused(true);
    emit({ type: 'webgl-context-lost' });
    showOverlay('Pausing — graphics restoring…');
  };

  const onRestored = (): void => {
    hideOverlay();
    if (!wasPaused) {
      useGameStore.getState().setPaused(false);
    }
  };

  canvas.addEventListener('webglcontextlost', onLost as EventListener);
  canvas.addEventListener('webglcontextrestored', onRestored as EventListener);

  return {
    detach: () => {
      canvas.removeEventListener('webglcontextlost', onLost as EventListener);
      canvas.removeEventListener('webglcontextrestored', onRestored as EventListener);
      hideOverlay();
    },
  };
}

let overlayEl: HTMLDivElement | null = null;

function showOverlay(text: string): void {
  if (!overlayEl) {
    overlayEl = document.createElement('div');
    overlayEl.setAttribute('role', 'status');
    overlayEl.style.position = 'fixed';
    overlayEl.style.inset = '0';
    overlayEl.style.background = 'rgba(0, 8, 20, 0.85)';
    overlayEl.style.backdropFilter = 'blur(6px)';
    overlayEl.style.color = '#00e5ff';
    overlayEl.style.display = 'flex';
    overlayEl.style.alignItems = 'center';
    overlayEl.style.justifyContent = 'center';
    overlayEl.style.fontFamily = "'JetBrains Mono', 'SF Mono', Menlo, monospace";
    overlayEl.style.fontSize = '1rem';
    overlayEl.style.zIndex = '500';
    overlayEl.style.letterSpacing = '0.15em';
    document.body.appendChild(overlayEl);
  }
  overlayEl.textContent = text;
  overlayEl.style.display = 'flex';
}

function hideOverlay(): void {
  if (overlayEl) overlayEl.style.display = 'none';
}
