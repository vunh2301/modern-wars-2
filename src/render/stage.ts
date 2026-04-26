/**
 * Pixi.Application setup. SPEC Section 8.1 + Section 11 Phase 0.
 *
 * Empty canvas full-screen, ocean background fill #040d18 (Section 8.1).
 * DPR cap 2 for mobile perf. CullerPlugin will be registered when hex layer
 * lands (Phase 3).
 */
import { Application, Color, CullerPlugin, extensions } from 'pixi.js';

// Register Pixi v8 CullerPlugin so containers with cullable=true + cullArea
// get auto-skipped when offscreen. Required for chunked hex rendering perf.
extensions.add(CullerPlugin);

const OCEAN_BG = 0x040d18;

export async function createStage(): Promise<Application> {
  const app = new Application();
  // Phase 7.8 (2026-04-26): default ?renderer=webgpu (iOS Safari 18.4+
  // enables WebGPU mặc định trên iPhone). WGSL shader đã fix attribute
  // inline trong fn args (Pixi v8 extractAttributesFromGpuProgram chỉ parse
  // @location ở function args, không phải struct fields). Pixi v8 auto-fallback
  // to WebGL2 nếu không hỗ trợ. URL override ?renderer=webgl forces fallback.
  const rendererPref = (new URLSearchParams(location.search).get('renderer') ?? 'webgpu') as 'webgl' | 'webgpu';
  await app.init({
    preference: rendererPref,
    background: new Color(OCEAN_BG),
    resizeTo: window,
    resolution: Math.min(window.devicePixelRatio ?? 1, 2),
    antialias: true,
    autoDensity: true,
    powerPreference: 'high-performance',
  });
  // app.renderer.type: 1=WEBGL, 2=WEBGPU enum.
  const typeStr = app.renderer.type === 2 ? 'webgpu' : 'webgl';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__mwRenderer = typeStr;
  console.info(`[stage] renderer=${typeStr} (preference=${rendererPref})`);
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
