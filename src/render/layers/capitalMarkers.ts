/**
 * Capital city markers. SPEC Section 9 Phase 5 deliverable + Section 20.1.
 *
 * Renders an amber dot at each `country.capital.position` (only countries with
 * capital lookup data — no fake centroid markers per Section 6.4).
 */
import { Container, Graphics } from 'pixi.js';
import type { WorldData } from '../../data/types';
import { palette } from '../../style/palette';

export interface CapitalMarkersLayer {
  root: Container;
  destroy: () => void;
}

const MARKER_RADIUS = 2.2;
const MARKER_COLOR = 0xffb800; // palette.amber

export function createCapitalMarkersLayer(world: WorldData): CapitalMarkersLayer {
  void palette; // referenced via hex
  const root = new Container();
  root.label = 'capitalMarkers';
  root.zIndex = 6;
  root.cullable = false;

  for (const code of Object.keys(world.countries).sort()) {
    const meta = world.countries[code];
    if (!meta?.capital) continue;
    const [x, y] = meta.capital.position;
    const g = new Graphics();
    g.circle(x, y, MARKER_RADIUS);
    g.fill({ color: MARKER_COLOR, alpha: 0.95 });
    g.circle(x, y, MARKER_RADIUS * 1.8);
    g.stroke({ color: MARKER_COLOR, alpha: 0.4, width: 0.6 });
    root.addChild(g);
  }

  return {
    root,
    destroy: () => {
      root.destroy({ children: true, texture: false });
    },
  };
}
