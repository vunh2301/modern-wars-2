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
 * Borders: separate Graphics overlay vẽ stroke chỉ giữa các hex thuộc 2
 * country khác nhau (hoặc rìa map). Inner-country hexes vẫn pure fill →
 * đất liền mạch theo Justin 2026-04-26. Toggle visible theo zoom.
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
import type { TierData, HexRecord } from '../data/tiers';
import { axialToPx, SQRT_3 } from '../geo/hex';
import { kmToWorldPx } from '../geo/projection';

export interface HexLayer {
  root: Container;
  setTier: (tier: TierData, lut: Uint32Array) => void;
  setBordersVisible: (visible: boolean) => void;
  destroy: () => void;
}

const HEX_TEXTURE_SIDE = 32; // px — hex side length in render texture
const HEX_TEX_W = Math.ceil(2 * HEX_TEXTURE_SIDE);            // 64
const HEX_TEX_H = Math.ceil(SQRT_3 * HEX_TEXTURE_SIDE);       // 55

const BORDER_COLOR = 0x05101a;
const BORDER_ALPHA = 0.85;
// Stroke width = fraction of hex side. At zoom 1× với hex 50km (~8 world px)
// → ~0.5 world px → ~0.5 viewport px ≈ visible nhưng mỏng.
const BORDER_WIDTH_FACTOR = 0.06;

// 6 axial neighbor offsets (flat-top, q-axis right, r-axis down-left).
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [+1, 0], [+1, -1], [0, -1],
  [-1, 0], [-1, +1], [0, +1],
];

function makeHexTexture(app: Application): RenderTexture {
  // Per Justin 2026-04-26: bỏ inner hex stroke → đất same-country liền mạch.
  // Country borders rendered as separate Graphics overlay (computed runtime).
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

  const tex = RenderTexture.create({ width: HEX_TEX_W, height: HEX_TEX_H, resolution: 1 });
  app.renderer.render({ container: g, target: tex });
  g.destroy();
  return tex;
}

/**
 * Build border edges Float32Array [x1,y1,x2,y2, …]. Một edge xuất hiện 1 lần
 * (tie-break theo countryId thấp hơn). Bao gồm cả edges ở rìa map (neighbor
 * missing) để outline coastlines.
 */
function computeBorderEdges(hexes: ReadonlyArray<HexRecord>, hexSizeWorldPx: number): Float32Array {
  // Pack (q,r) → 32-bit int. q,r are int16 → offset +32768 to keep positive.
  const KEY_OFFSET = 32768;
  const countryByKey = new Map<number, number>();
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i]!;
    const key = (h.q + KEY_OFFSET) * 65536 + (h.r + KEY_OFFSET);
    countryByKey.set(key, h.countryId);
  }

  // Perpendicular factor: distance(center→neighbor) = SQRT_3 * size; we want
  // perpendicular length = size/2 → factor = 1/(2*SQRT_3).
  const PERP_F = 0.5 / SQRT_3;
  const out: number[] = [];

  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i]!;
    const [hx, hy] = axialToPx(h.q, h.r, hexSizeWorldPx);
    for (let n = 0; n < 6; n++) {
      const off = NEIGHBORS[n]!;
      const nq = h.q + off[0];
      const nr = h.r + off[1];
      const nkey = (nq + KEY_OFFSET) * 65536 + (nr + KEY_OFFSET);
      const neighborCountry = countryByKey.get(nkey);

      // Same country → no border.
      if (neighborCountry === h.countryId) continue;
      // Dedup: when both hexes exist (different countries), only draw from
      // the side with smaller countryId. Edges to ocean (neighbor undefined)
      // always drawn from current hex.
      if (neighborCountry !== undefined && h.countryId > neighborCountry) continue;

      const [nx, ny] = axialToPx(nq, nr, hexSizeWorldPx);
      const mx = (hx + nx) / 2;
      const my = (hy + ny) / 2;
      const dx = nx - hx;
      const dy = ny - hy;
      const px = -dy * PERP_F;
      const py = dx * PERP_F;
      out.push(mx + px, my + py, mx - px, my - py);
    }
  }
  return new Float32Array(out);
}

export function createHexLayer(app: Application): HexLayer {
  const root = new Container();
  root.label = 'hex-layer';
  root.cullable = false;

  const texture = makeHexTexture(app);

  let pc: ParticleContainer | null = null;
  let borders: Graphics | null = null;

  const setTier = (tier: TierData, lut: Uint32Array): void => {
    if (pc) {
      pc.destroy({ children: true });
      pc = null;
    }
    if (borders) {
      borders.destroy();
      borders = null;
    }

    pc = new ParticleContainer({
      dynamicProperties: { position: false, scale: false, rotation: false, color: false },
    });
    pc.label = `tier-${tier.name}`;
    pc.cullable = false;

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
    const dtFill = performance.now() - t0;
    root.addChild(pc);

    // Borders overlay — chỉ giữa các country khác nhau / rìa map.
    const t1 = performance.now();
    const edges = computeBorderEdges(tier.hexes, hexSizeWorldPx);
    borders = new Graphics();
    borders.label = `borders-${tier.name}`;
    borders.cullable = false;
    for (let i = 0; i < edges.length; i += 4) {
      borders.moveTo(edges[i]!, edges[i + 1]!).lineTo(edges[i + 2]!, edges[i + 3]!);
    }
    borders.stroke({
      color: BORDER_COLOR,
      alpha: BORDER_ALPHA,
      width: hexSizeWorldPx * BORDER_WIDTH_FACTOR,
    });
    root.addChild(borders);
    const dtBorders = performance.now() - t1;

    console.info(
      `[hex-layer] tier ${tier.name}: ${tier.hexes.length} particles ${dtFill.toFixed(0)}ms, ` +
      `${edges.length / 4} border segments ${dtBorders.toFixed(0)}ms`,
    );
  };

  const setBordersVisible = (visible: boolean): void => {
    if (borders) borders.visible = visible;
  };

  const destroy = (): void => {
    if (pc) pc.destroy({ children: true });
    if (borders) borders.destroy();
    texture.destroy();
    root.destroy({ children: true });
  };

  return { root, setTier, setBordersVisible, destroy };
}
