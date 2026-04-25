/**
 * Hex render layer. SPEC v1.0 Section 8.
 *
 * Phase 1 MVP scope: render ALL hexes of current tier directly via
 * ParticleContainer. Visible-only culling via rbush spatial query lands in
 * Phase 4 (LOD + lazy load). For 50km tier (~77K hexes) this works fine
 * on iPhone GPU as a single batched draw call.
 */
import 'pixi.js/particle-container';
import {
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  RenderTexture,
  type Application,
} from 'pixi.js';
import type { TierData } from '../data/tiers';
import { axialToPx, hexSpriteScale, SQRT_3 } from '../geo/hex';
import { kmToWorldPx } from '../geo/projection';

export interface HexLayer {
  root: Container;
  setTier: (tier: TierData, lut: Uint32Array) => void;
  destroy: () => void;
}

function makeHexTexture(app: Application): RenderTexture {
  // Pre-render a single flat-top hex into a 32×32 RenderTexture, white fill.
  // Particles tint per country color at runtime.
  const SIZE = 14; // half of 32 minus margin; final scale set per-particle.
  const g = new Graphics();
  const points: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    points.push(SIZE * Math.cos(angle), SIZE * Math.sin(angle));
  }
  g.poly(points);
  g.fill({ color: 0xffffff, alpha: 1 });

  const tex = RenderTexture.create({ width: 32, height: 32, resolution: 1 });
  app.renderer.render({ container: g, target: tex });
  g.destroy();
  return tex;
}

export function createHexLayer(app: Application): HexLayer {
  const root = new Container();
  root.label = 'hex-layer';
  root.cullable = false;

  const texture = makeHexTexture(app);

  let pc: ParticleContainer | null = null;

  const setTier = (tier: TierData, lut: Uint32Array): void => {
    if (pc) {
      pc.destroy({ children: true });
      pc = null;
    }

    pc = new ParticleContainer({
      dynamicProperties: { position: false, scale: false, rotation: false, color: false },
    });
    pc.label = `tier-${tier.name}`;
    pc.cullable = false;

    // Hex render size in world px = sizeKm → world px (Mercator radians × scale)
    const hexSizeWorldPx = kmToWorldPx(tier.sizeKm);
    const { width, height } = hexSpriteScale(hexSizeWorldPx);
    void height;
    // Particle tint scales with hexSize. Texture is 32 px wide → scale = width/32.
    const scale = width / 32;

    const t0 = performance.now();
    for (let i = 0; i < tier.hexes.length; i++) {
      const h = tier.hexes[i]!;
      const [x, y] = axialToPx(h.q, h.r, hexSizeWorldPx);
      const tint = lut[h.countryId] ?? 0x666688;
      const p = new Particle({
        texture,
        x,
        y,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: scale,
        scaleY: scale,
        tint,
      });
      pc.addParticle(p);
    }
    const dt = performance.now() - t0;
    console.info(`[hex-layer] tier ${tier.name}: ${tier.hexes.length} particles in ${dt.toFixed(0)}ms (hexSizeWorldPx=${hexSizeWorldPx.toFixed(2)}, scale=${scale.toFixed(3)})`);

    root.addChild(pc);
    void SQRT_3;
  };

  const destroy = (): void => {
    if (pc) pc.destroy({ children: true });
    texture.destroy();
    root.destroy({ children: true });
  };

  return { root, setTier, destroy };
}
