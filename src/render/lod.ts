/**
 * LOD tier switcher. SPEC Section 5.2 + 5.5 (asymmetric hysteresis).
 *
 * Tier 0 (zoom < 0.5): aggregate render — country fills hidden, borders
 *   simplified or hidden, troops show as 1 ball/country at centroid.
 * Tier 1 (zoom 0.5-2): standard render (Phase 1b layers).
 * Tier 2 (zoom > 2): detail render — lazy-load tier-2 polygons + borders.
 *
 * Hysteresis (asymmetric): trigger thresholds offset by ±0.05 to chống
 * thrash khi zoom oscillate quanh boundary.
 *   Tier 0 → 1: zoom > 0.55
 *   Tier 1 → 0: zoom < 0.45
 *   Tier 1 → 2: zoom > 2.05 (triggers tier-2 lazy load)
 *   Tier 2 → 1: zoom < 1.95
 */
import type { Viewport } from 'pixi-viewport';
import type { Container } from 'pixi.js';
import { loadTier2 } from '../data/loadWorld';
import type { WorldData } from '../data/types';
import { emit } from '../telemetry/emit';

export type LodTier = 0 | 1 | 2;

export interface LodLayers {
  fills: Container;
  borders: Container;
  troops: Container;
  capitals: Container;
}

export interface LodSwitcher {
  bind: () => () => void;
  current: () => LodTier;
}

const T0_TO_T1 = 0.55;
const T1_TO_T0 = 0.45;
const T1_TO_T2 = 2.05;
const T2_TO_T1 = 1.95;
const TIER2_LAZY_THRESHOLD = 1.5;
const RETRY_BACKOFF_MS = 500;

export function createLodSwitcher(params: {
  viewport: Viewport;
  layers: LodLayers;
  world: WorldData;
}): LodSwitcher {
  const { viewport, layers, world } = params;
  let tier: LodTier = 1;
  let lazyTier2Started = false;
  let lazyTier2Failed = false;

  const apply = (next: LodTier): void => {
    if (next === tier) return;
    performance.mark('lod-switch-start');
    const prev = tier;
    tier = next;

    // Tier-specific visibility
    if (next === 0) {
      layers.fills.visible = false;
      layers.borders.visible = false;
      layers.troops.visible = true;
      layers.capitals.visible = false;
    } else if (next === 1) {
      layers.fills.visible = true;
      layers.borders.visible = true;
      layers.troops.visible = true;
      layers.capitals.visible = true;
    } else {
      // tier 2
      layers.fills.visible = true;
      layers.borders.visible = true;
      layers.troops.visible = true;
      layers.capitals.visible = true;
    }

    try {
      performance.mark('lod-switch-end');
      performance.measure('lod-tier-switch', 'lod-switch-start', 'lod-switch-end');
      const m = performance.getEntriesByName('lod-tier-switch').pop();
      void m;
    } catch {
      // ignore
    }
    emit({ type: 'frame-budget-violation', frameMs: 0, scenario: `lod-switch-${prev}-${next}` });
  };

  const lazyLoadTier2 = async (): Promise<void> => {
    if (lazyTier2Started) return;
    lazyTier2Started = true;
    try {
      await loadTier2(world);
    } catch (err) {
      console.warn('[lod] tier-2 lazy-load failed, retrying once', err);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      try {
        await loadTier2(world);
      } catch (err2) {
        console.error('[lod] tier-2 lazy-load failed permanently — staying tier-1', err2);
        lazyTier2Failed = true;
      }
    }
  };

  const onZoom = (): void => {
    const z = viewport.scale.x;
    // Tier 2 lazy-load trigger before threshold (warmup)
    if (z > TIER2_LAZY_THRESHOLD && !lazyTier2Started) {
      void lazyLoadTier2();
    }
    if (tier === 0) {
      if (z > T0_TO_T1) apply(1);
    } else if (tier === 1) {
      if (z < T1_TO_T0) apply(0);
      else if (z > T1_TO_T2 && !lazyTier2Failed) apply(2);
    } else {
      // tier === 2
      if (z < T2_TO_T1) apply(1);
    }
  };

  const bind = (): (() => void) => {
    apply(1);
    viewport.on('zoomed', onZoom);
    viewport.on('moved', onZoom); // some pan ops also adjust zoom
    return () => {
      viewport.off('zoomed', onZoom);
      viewport.off('moved', onZoom);
    };
  };

  return { bind, current: () => tier };
}
