/**
 * Hex render layer. SPEC v1.0-locked Section 8.
 *
 * Phase 1 MVP: render ALL hexes of current tier directly via ParticleContainer.
 * Visible-only culling lands in Phase 4.
 *
 * Texture geometry (flat-top hex):
 *   side length = HEX_TEXTURE_SIDE px (in render texture)
 *   outer width  = 2 * SIDE
 *   outer height = sqrt(3) * SIDE
 *   Tile pitch:  horiz = 1.5 * SIDE; vert = sqrt(3) * SIDE
 *
 * At runtime: particle scale = hexSizeWorldPx / HEX_TEXTURE_SIDE so
 * geometry overlap pattern (flat-top hex tiling) is preserved exactly.
 *
 * Border: 1 px dark stroke baked into texture for "Catan-style" hex grid look.
 */
import 'pixi.js/particle-container';
import {
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  RenderTexture,
  type Application,
} from 'pixi.js';
import type { TierData } from '../data/tiers';
import { axialToPx } from '../geo/hex';
import { kmToWorldPx } from '../geo/projection';

export interface HexLayer {
  root: Container;
  setTier: (tier: TierData, lut: Uint32Array) => void;
  destroy: () => void;
}

const HEX_TEXTURE_SIDE = 32; // px — hex side length in render texture
const SQRT_3 = Math.sqrt(3);
const HEX_TEX_W = Math.ceil(2 * HEX_TEXTURE_SIDE);            // 64
const HEX_TEX_H = Math.ceil(SQRT_3 * HEX_TEXTURE_SIDE);       // 55
const STROKE_PX = 1.2;
const STROKE_COLOR = 0x05101a; // near-ocean dark, just enough to read seams

function makeHexTexture(app: Application): RenderTexture {
  // Per Justin 2026-04-26: bỏ hex stroke vì sub-pixel jitter khi pan tạo flash.
  // Pure fill — countries identified via color blocks. Country borders as
  // separate edge layer = future polish.
  const cx = HEX_TEX_W / 2;
  const cy = HEX_TEX_H / 2;
  const points: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    points.push(cx + HEX_TEXTURE_SIDE * Math.cos(angle), cy + HEX_TEXTURE_SIDE * Math.sin(angle));
  }
  const g = new Graphics();
  g.poly(points);
  g.fill({ color: 0xffffff, alpha: 1 });
  // No stroke — eliminates per-hex grid lines that flickered during pan.
  void STROKE_PX;
  void STROKE_COLOR;

  const tex = RenderTexture.create({ width: HEX_TEX_W, height: HEX_TEX_H, resolution: 1 });
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
    pc.cullable = false; // single container, GPU offscreen-skip handles it

    const hexSizeWorldPx = kmToWorldPx(tier.sizeKm);
    const scale = hexSizeWorldPx / HEX_TEXTURE_SIDE;

    const t0 = performance.now();
    for (let i = 0; i < tier.hexes.length; i++) {
      const h = tier.hexes[i]!;
      const [x, y] = axialToPx(h.q, h.r, hexSizeWorldPx);
      const tint = lut[h.countryId] ?? 0x666688;
      pc.addParticle(new Particle({
        texture,
        x,
        y,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: scale,
        scaleY: scale,
        tint,
      }));
    }
    const dt = performance.now() - t0;
    console.info(`[hex-layer] tier ${tier.name}: ${tier.hexes.length} particles in ${dt.toFixed(0)}ms`);
    root.addChild(pc);
    void Rectangle; // chunked path reserved for future when CullerPlugin tuning works
  };

  const destroy = (): void => {
    if (pc) pc.destroy({ children: true });
    texture.destroy();
    root.destroy({ children: true });
  };

  return { root, setTier, destroy };
}
