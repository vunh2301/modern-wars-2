import { useEffect, useRef } from 'react';
import { Application, extensions, CullerPlugin, VERSION } from 'pixi.js';
import { palette, hexToPixiTint } from '../style/palette';

/**
 * Mounts a Pixi v8 `Application` into a host <div>.
 *
 * SPEC Section 5.4 — viewport construction with `events: app.renderer.events`,
 * Culling pipeline with explicit `extensions.add(CullerPlugin)`.
 * SPEC Section 4.4 — DPR cap = 2.
 * SPEC Section 5.3 — runtime assert Pixi >= 8.6 for tint cascade.
 * SPEC Section 15.1 — destroy contract on React unmount.
 *
 * Phase 0 scope: empty Pixi scene with ocean background only. Pan/zoom, country
 * meshes, borders, particles arrive in Phase 1b+.
 */
export function PixiRoot(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const app = new Application();
    appRef.current = app;

    const init = async () => {
      // SPEC Section 5.3: tint cascade requires Pixi >= 8.6
      const major = parseFloat(VERSION);
      if (!Number.isFinite(major) || major < 8.6) {
        throw new Error(`Pixi >= 8.6 required for tint cascade; got ${VERSION}`);
      }

      // SPEC Section 5.4: register CullerPlugin BEFORE app.init so cullable=true takes effect
      extensions.add(CullerPlugin);

      await app.init({
        resolution: Math.min(window.devicePixelRatio, 2),
        antialias: true,
        powerPreference: 'high-performance',
        background: hexToPixiTint(palette.bgVoid),
        resizeTo: host,
        autoDensity: true,
      });

      if (cancelled) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
        return;
      }

      host.appendChild(app.canvas);
      app.canvas.setAttribute('aria-hidden', 'true');
      app.canvas.style.display = 'block';
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
    };

    void init().catch((err) => {
      console.error('Pixi init failed:', err);
    });

    return () => {
      cancelled = true;
      const current = appRef.current;
      appRef.current = null;
      if (current) {
        current.ticker.stop();
        current.destroy(true, { children: true, texture: true, textureSource: true });
      }
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="pixi-host"
      style={{
        position: 'absolute',
        inset: 0,
        background: palette.bgVoid,
      }}
    />
  );
}
