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
import {
  kmToWorldPx,
  WRAP_DISTANCE_PX,
  WRAP_HEX_COUNT_BASE,
  WRAP_BASE_TIER_KM,
} from '../geo/projection';

// Coarse tiers (50km/25km) get horizontal wrap copies (no Y shift —
// canonical bake's lng wrap PiP places hexes at correct geographic lat).
// 10km tier skip wrap để tránh OOM iPhone (1.25M × 3 = 3.75M particles).
const WRAP_TIER_NAMES: ReadonlySet<string> = new Set(['50km', '25km']);

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
function computeBorderEdges(
  hexes: ReadonlyArray<HexRecord>,
  hexSizeWorldPx: number,
  wrapHexCount: number,
): Float32Array {
  // Pack (q,r) → 32-bit int. q,r are int16 → offset +32768 to keep positive.
  const KEY_OFFSET = 32768;
  const countryByKey = new Map<number, number>();
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i]!;
    const key = (h.q + KEY_OFFSET) * 65536 + (h.r + KEY_OFFSET);
    countryByKey.set(key, h.countryId);
  }

  const halfWrap = Math.floor(wrapHexCount / 2);
  const qMin = -halfWrap;
  const qMax = qMin + wrapHexCount - 1;

  // Wrap-aware neighbor lookup. Flat-top axial: y = -√3·size·(r + q/2). Khi
  // q wrap qua wrapHexCount columns, r PHẢI adjust ±wrapHexCount/2 để giữ
  // y khớp (geographic continuity). Trước đây em chỉ wrap q → lookup miss
  // hex thực + draw rim border ở wrap seam → visible zigzag (Justin lằn).
  const lookup = (q: number, r: number): number | undefined => {
    let qq = q;
    let rr = r;
    if (qq > qMax) { qq -= wrapHexCount; rr += halfWrap; }
    else if (qq < qMin) { qq += wrapHexCount; rr -= halfWrap; }
    return countryByKey.get((qq + KEY_OFFSET) * 65536 + (rr + KEY_OFFSET));
  };

  const PERP_F = 0.5 / SQRT_3;
  const out: number[] = [];

  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i]!;
    const [hx, hy] = axialToPx(h.q, h.r, hexSizeWorldPx);
    for (let n = 0; n < 6; n++) {
      const off = NEIGHBORS[n]!;
      const nq = h.q + off[0];
      const nr = h.r + off[1];
      const neighborCountry = lookup(nq, nr);

      if (neighborCountry === h.countryId) continue;
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

  // ONE ParticleContainer + ONE Graphics chứa cả 3 wrap copies. Trước em
  // tách riêng 3 PC + 3 Graphics → mỗi mesh anti-alias độc lập, edge giữa
  // 2 mesh hiện zigzag (Justin 2026-04-26). Gộp về 1 mesh → batch rendering
  // → AA pass duy nhất → seam invisible.
  let particles: ParticleContainer | null = null;
  let borders: Graphics | null = null;

  const setTier = (tier: TierData, lut: Uint32Array): void => {
    if (particles) { particles.destroy({ children: true }); particles = null; }
    if (borders) { borders.destroy(); borders = null; }

    const hexSizeWorldPx = kmToWorldPx(tier.sizeKm);
    const scale = hexSizeWorldPx / HEX_TEXTURE_SIDE;

    // Wrap copies — Y shift = 0 vì hex GRID positions từ bake đã PiP đúng
    // theo lng/lat Mercator, không cần shift Y để khớp flat-top axial drift.
    // (Trước em thử Y shift = -W/√3 nhưng Justin thấy "lệch chỗ cắt map".)
    const offsets: ReadonlyArray<readonly [number, number]> = WRAP_TIER_NAMES.has(tier.name)
      ? [[-WRAP_DISTANCE_PX, 0], [0, 0], [WRAP_DISTANCE_PX, 0]]
      : [[0, 0]];

    const N = tier.hexes.length;
    const px = new Float32Array(N);
    const py = new Float32Array(N);
    const tints = new Uint32Array(N);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const h = tier.hexes[i]!;
      const [x, y] = axialToPx(h.q, h.r, hexSizeWorldPx);
      px[i] = x;
      py[i] = y;
      tints[i] = lut[h.countryId] ?? 0x666688;
    }
    const dtGeom = performance.now() - t0;

    const wrapHexCount = WRAP_HEX_COUNT_BASE * (WRAP_BASE_TIER_KM / tier.sizeKm);
    const t1 = performance.now();
    const edges = computeBorderEdges(tier.hexes, hexSizeWorldPx, wrapHexCount);
    const dtEdges = performance.now() - t1;

    const t2 = performance.now();
    particles = new ParticleContainer({
      dynamicProperties: { position: false, scale: false, rotation: false, color: false },
    });
    particles.label = `tier-${tier.name}`;
    particles.cullable = false;

    borders = new Graphics();
    borders.label = `borders-${tier.name}`;
    borders.cullable = false;

    for (const [ox, oy] of offsets) {
      // Particles: emit each hex 1-3 times with (x, y) shifted by (ox, oy).
      for (let i = 0; i < N; i++) {
        particles.addParticle(new Particle({
          texture,
          x: px[i]! + ox,
          y: py[i]! + oy,
          anchorX: 0.5,
          anchorY: 0.5,
          scaleX: scale,
          scaleY: scale,
          tint: tints[i]!,
        }));
      }
      // Borders: emit each segment 1-3 times with (x, y) shifted by (ox, oy).
      for (let i = 0; i < edges.length; i += 4) {
        borders.moveTo(edges[i]! + ox, edges[i + 1]! + oy).lineTo(edges[i + 2]! + ox, edges[i + 3]! + oy);
      }
    }
    borders.stroke({
      color: BORDER_COLOR,
      alpha: BORDER_ALPHA,
      width: hexSizeWorldPx * BORDER_WIDTH_FACTOR,
    });
    root.addChild(particles);
    root.addChild(borders);
    const dtBuild = performance.now() - t2;

    console.info(
      `[hex-layer] tier ${tier.name}: ${N}×${offsets.length} particles, ` +
      `${edges.length / 4}×${offsets.length} border segments — ` +
      `geom ${dtGeom.toFixed(0)}ms, edges ${dtEdges.toFixed(0)}ms, build ${dtBuild.toFixed(0)}ms`,
    );
  };

  const setBordersVisible = (visible: boolean): void => {
    if (borders) borders.visible = visible;
  };

  const destroy = (): void => {
    if (particles) particles.destroy({ children: true });
    if (borders) borders.destroy();
    texture.destroy();
    root.destroy({ children: true });
  };

  return { root, setTier, setBordersVisible, destroy };
}
