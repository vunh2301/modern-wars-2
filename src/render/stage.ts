/**
 * Pixi `Application` factory. SPEC Sections 5.3, 5.4, 14.2.
 *
 * Centralised so render layers (PixiRoot, viewport, layers/*) share the same
 * lifecycle and so HMR cleanup can `destroy` consistently.
 */
import { Application, extensions, CullerPlugin, VERSION } from 'pixi.js';
import { hexToPixiTint, palette } from '../style/palette';

let cullerRegistered = false;

export type StageInit = {
  app: Application;
};

export async function createStage(host: HTMLElement): Promise<StageInit> {
  // SPEC 5.3 runtime assert: tint cascade requires Pixi >= 8.6.
  const major = parseFloat(VERSION);
  if (!Number.isFinite(major) || major < 8.6) {
    throw new Error(`Pixi >= 8.6 required for tint cascade; got ${VERSION}`);
  }

  // SPEC 5.4: register CullerPlugin BEFORE app.init so cullable=true takes effect.
  if (!cullerRegistered) {
    extensions.add(CullerPlugin);
    cullerRegistered = true;
  }

  const app = new Application();
  await app.init({
    resolution: Math.min(window.devicePixelRatio, 2), // SPEC 4.4 DPR cap = 2
    antialias: true,
    powerPreference: 'high-performance',
    background: hexToPixiTint(palette.bgVoid),
    resizeTo: host,
    autoDensity: true,
  });

  host.appendChild(app.canvas);
  app.canvas.setAttribute('aria-hidden', 'true');
  app.canvas.style.display = 'block';
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';

  // SPEC 5.3 uniform budget guard — primary LUT path means borders shader
  // doesn't depend on this, but keep the assert as a tripwire for future
  // shader work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderer = app.renderer as any;
  const gl: WebGL2RenderingContext | undefined = renderer?.gl;
  if (gl) {
    const maxFU = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    if (typeof maxFU === 'number' && maxFU < 128) {
      console.warn(`MAX_FRAGMENT_UNIFORM_VECTORS=${maxFU} < 128 (Section 5.3 budget guard)`);
    }
  }

  return { app };
}
