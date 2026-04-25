import { useCallback, useEffect, useRef, useState } from 'react';
import type { Application } from 'pixi.js';
import type { Viewport } from 'pixi-viewport';
import { palette } from '../style/palette';
import { loadWorld, type WorldLoadProgress } from '../data/loadWorld';
import type { WorldData } from '../data/types';
import { useOwnership } from '../state/store';
import { emit } from '../telemetry/emit';
import { Loading, type BootStep } from '../ui/Loading';
import { createStage } from './stage';
import { createViewport, resizeViewport } from './viewport';
import { createOceanLayer } from './layers/ocean';
import { createCountryFillsLayer } from './layers/countryFills';
import { createBordersLayer } from './layers/borders';

/**
 * End-to-end Pixi mount. SPEC Sections 5.1, 5.4, 13.1, 15.1.
 *
 * Lifecycle:
 *   1. `createStage` → Pixi Application + CullerPlugin.
 *   2. `loadWorld` → fetch & validate the four eager JSONs.
 *   3. Build viewport + layers (ocean, country fills, borders).
 *   4. First non-skeleton frame → `performance.measure('boot-to-playable')`.
 *
 * Cleanup destroys the Application + companion textures on unmount per
 * Section 15.1 destroy contract.
 */
export function PixiRoot(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  const [step, setStep] = useState<BootStep>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [bootKey, setBootKey] = useState(0);

  const onProgress = useCallback((p: WorldLoadProgress) => {
    setStep(p.step === 'fetching' ? 'fetching' : p.step === 'parsing' ? 'parsing' : p.step === 'composing' ? 'composing' : 'building');
    setProgress(p.loaded / p.total);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const localCleanups: Array<() => void> = [];
    cleanupRef.current = localCleanups;

    const boot = async (): Promise<void> => {
      performance.mark('boot-start');
      setStep('fetching');
      setProgress(0);

      const { app } = await createStage(host);
      if (cancelled) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
        return;
      }
      appRef.current = app;

      let world: WorldData;
      try {
        world = await loadWorld(onProgress);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[boot] world load failed:', err);
        setErrorMessage(msg);
        setStep('error');
        return;
      }

      if (cancelled) return;
      setStep('building');
      setProgress(1);

      // Init store ownership map from world.
      useOwnership.getState().initOwnership(Object.keys(world.countries));

      const viewport = createViewport(app);
      viewportRef.current = viewport;
      app.stage.addChild(viewport);

      // Layer order = z-stack (Section 5.1).
      const ocean = createOceanLayer();
      viewport.addChild(ocean);

      const fills = createCountryFillsLayer(world);
      viewport.addChild(fills.root);
      const fillsUnsub = fills.bind();
      fills.retintAll();
      localCleanups.push(fillsUnsub, () => fills.destroy());

      const borders = createBordersLayer(world);
      viewport.addChild(borders.mesh);
      const bordersUnsub = borders.bind();
      localCleanups.push(bordersUnsub, () => borders.destroy());

      // Center on world.
      viewport.moveCenter(1800, 900);
      viewport.fitWorld(true);
      viewport.setZoom(Math.max(viewport.scale.x, 0.5), true);

      // Resize handling (Section 5.4).
      const onResize = (): void => resizeViewport(app, viewport);
      window.addEventListener('resize', onResize);
      const orientation = window.matchMedia?.('(orientation:portrait)');
      orientation?.addEventListener?.('change', onResize);
      localCleanups.push(() => {
        window.removeEventListener('resize', onResize);
        orientation?.removeEventListener?.('change', onResize);
      });

      // Mark playable on next ticker frame (one Pixi render cycle past mount).
      const markPlayable = (): void => {
        try {
          performance.mark('boot-playable');
          performance.measure('boot-to-playable', 'boot-start', 'boot-playable');
          const m = performance.getEntriesByName('boot-to-playable').pop();
          if (m) emit({ type: 'boot-to-playable', ms: Math.round(m.duration) });
        } catch (e) {
          console.warn('[boot] perf measure failed', e);
        }
      };
      app.ticker.addOnce(() => {
        if (cancelled) return;
        setStep('ready');
        markPlayable();
      });
    };

    void boot();

    return () => {
      cancelled = true;
      for (const fn of localCleanups.splice(0)) {
        try { fn(); } catch (e) { console.warn('[unmount] cleanup error', e); }
      }
      const current = appRef.current;
      appRef.current = null;
      const vp = viewportRef.current;
      viewportRef.current = null;
      if (vp) vp.destroy({ children: true, texture: false });
      if (current) {
        current.ticker.stop();
        current.destroy(true, { children: true, texture: true, textureSource: true });
      }
    };
    // bootKey forces a fresh boot when user clicks Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootKey]);

  return (
    <>
      <div
        ref={hostRef}
        className="pixi-host"
        style={{
          position: 'absolute',
          inset: 0,
          background: palette.bgVoid,
        }}
      />
      <Loading
        step={step}
        progress={progress}
        errorMessage={errorMessage}
        onRetry={step === 'error' ? () => { setErrorMessage(undefined); setBootKey((k) => k + 1); } : undefined}
      />
    </>
  );
}
