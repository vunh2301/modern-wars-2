/**
 * Troop particles. SPEC Section 5.5 + Section 20.5.
 *
 * Phase 5 MVP scope: tier-0 aggregate (1 particle per country at centroid,
 * sized by sqrt(troops), tinted by current owner color from LUT). Tier-1 + 2
 * detail particles deferred to Phase 6a LOD switcher.
 *
 * Pixi v8 ParticleContainer requires the side-effect import (Section 5.5):
 *   import 'pixi.js/particle-container';
 */
import 'pixi.js/particle-container';
import { Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import type { WorldData } from '../../data/types';
import { useGameStore } from '../../state/store';
import { selectTroopsVersion, selectOwnershipVersion } from '../../state/selectors';
import { palette } from '../../style/palette';
import { trackTexture, untrackTexture } from '../textureRegistry';

export interface TroopsLayer {
  root: Container;
  bind: () => () => void;
  destroy: () => void;
}

// Reduced from 6 → 3 to avoid troop particles obscuring tiny country fills
// on phone-sized viewports (Justin feedback 2026-04-25).
const TROOP_BASE_SIZE = 3;
const TROOP_DIVISOR = 400;
const FACTION_COLORS = [0x0088aa, 0xaa0066, 0xaa6600, 0x006644, 0x666688];

function colorFor(ownerId: string): number {
  // Hash code → palette index (4-color from Welsh-Powell would also work,
  // but this gives stable colors per ownerId for visualization).
  let h = 0;
  for (let i = 0; i < ownerId.length; i++) h = (h * 31 + ownerId.charCodeAt(i)) >>> 0;
  return FACTION_COLORS[h % FACTION_COLORS.length] ?? 0x0088aa;
}

export function createTroopsLayer(world: WorldData): TroopsLayer {
  void palette; // hex used directly
  const container = new ParticleContainer({
    dynamicProperties: { position: true, scale: true, rotation: false, color: true },
    boundsArea: new Rectangle(0, 0, 3600, 1800),
  });
  container.label = 'troops';
  container.zIndex = 4;
  container.cullable = false;

  // Shared 1×1 white texture for all particles (tinted per particle).
  const texture = Texture.WHITE;
  trackTexture(texture.source);

  // Build particle per country (sorted ISO for deterministic init).
  const particles = new Map<string, Particle>();
  const codes = Object.keys(world.countries).sort();
  for (const code of codes) {
    const meta = world.countries[code];
    if (!meta) continue;
    const [cx, cy] = meta.centroid;
    const p = new Particle({
      texture,
      x: cx,
      y: cy,
      scaleX: TROOP_BASE_SIZE,
      scaleY: TROOP_BASE_SIZE,
      anchorX: 0.5,
      anchorY: 0.5,
      tint: colorFor(code),
    });
    particles.set(code, p);
    container.addParticle(p);
  }

  const updateAll = (): void => {
    const state = useGameStore.getState();
    for (const [code, p] of particles) {
      const c = state.countries[code];
      if (!c) continue;
      const size = TROOP_BASE_SIZE + Math.sqrt(Math.max(0, c.troops)) / TROOP_DIVISOR;
      p.scaleX = size;
      p.scaleY = size;
      p.tint = colorFor(c.ownerId);
    }
  };

  const bind = (): (() => void) => {
    updateAll();
    const unsubTroops = useGameStore.subscribe((s, prev) => {
      if (selectTroopsVersion(s) !== selectTroopsVersion(prev)) updateAll();
    });
    const unsubOwner = useGameStore.subscribe((s, prev) => {
      if (selectOwnershipVersion(s) !== selectOwnershipVersion(prev)) updateAll();
    });
    return () => {
      unsubTroops();
      unsubOwner();
    };
  };

  return {
    root: container,
    bind,
    destroy: () => {
      untrackTexture(texture.source);
      container.destroy({ children: true, texture: false });
    },
  };
}
