/**
 * Pixi.Application setup. SPEC Section 8.1 + Section 11 Phase 0.
 *
 * Empty canvas full-screen, ocean background fill #040d18 (Section 8.1).
 * DPR cap 2 for mobile perf. CullerPlugin will be registered when hex layer
 * lands (Phase 3).
 */
import { Application, Color } from 'pixi.js';

const OCEAN_BG = 0x040d18;

export async function createStage(): Promise<Application> {
  const app = new Application();
  await app.init({
    background: new Color(OCEAN_BG),
    resizeTo: window,
    resolution: Math.min(window.devicePixelRatio ?? 1, 2),
    antialias: true,
    autoDensity: true,
    powerPreference: 'high-performance',
  });
  return app;
}

export function mountStage(app: Application, host: HTMLDivElement): void {
  host.appendChild(app.canvas);

  // Re-resize on orientation/visibility change (Phase 0 minimal — full
  // ResizeObserver wiring lands with viewport in Phase 3).
  const onResize = (): void => {
    app.renderer.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });
}
