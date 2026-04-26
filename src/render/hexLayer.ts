/**
 * Hex render layer — Phase 6 chunked, viewport-culled.
 *
 * Tier data partitioned vào 8×4 = 32 logical chunks (createChunkGrid). Mỗi
 * chunk's GPU resources (ParticleContainer + Graphics) lazy-built khi chunk
 * lần đầu tiên enter viewport. Cached across pan, destroyed on tier switch.
 *
 * `setTier` chỉ làm CPU work (chunkGrid build) — KHÔNG còn GPU allocation
 * → tier-switch freeze rớt từ 200-500ms về < 50ms.
 *
 * `updateVisibility(bbox)` được main.ts gọi throttled per-frame:
 *   rbush.search(expanded bbox) → toggle particles.visible per (chunk, offset).
 *
 * Texture geometry (flat-top hex) shared across all chunks — 1 RenderTexture
 * per HexLayer (tạo lúc createHexLayer, destroy lúc layer destroy).
 *
 * Wrap copies: 50km/25km có 3 GPU containers per chunk (offsets [-W, 0, +W]),
 * 10km chỉ 1. Same hex/edge data, position-shifted at addParticle/moveTo.
 *
 * Borders: pure-fill texture (no inner stroke) → đất same-country liền mạch.
 * Country-boundary edges drawn as separate Graphics overlay per chunk.
 * Wrap-aware lookup (q wrap → r adjust ±halfWrap) preserved trong chunkGrid.
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
import { SQRT_3 } from '../geo/hex';
import {
  kmToWorldPx,
  WRAP_DISTANCE_PX,
  worldBoundsPx,
} from '../geo/projection';
import {
  createChunkGrid,
  type ChunkData,
  type ChunkEntry,
  type ChunkGrid,
} from './chunkGrid';

// Wrap copies cho ALL tiers (50km/25km/10km). Phase 6 D-6 (extended): chunked
// lazy build (D-4) khiến 10km wrap an toàn — peak ~24 chunk-instances ×
// ~39K hexes ≈ 940K particles ≪ baseline 1.25M monolithic. Justin 2026-04-26
// "zoom 10km cuộn qua trái và phải không được bị đứng ngay hai cạnh map".
const WRAP_TIER_NAMES: ReadonlySet<string> = new Set(['50km', '25km', '10km']);

export interface ViewportBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface HexLayer {
  root: Container;
  setTier: (tier: TierData, lut: Uint32Array) => void;
  setBordersVisible: (visible: boolean) => void;
  /** Toggle chunk visibility based on viewport bbox (world px). */
  updateVisibility: (bbox: ViewportBbox) => void;
  /** Read-only stats for HUD/benchmark. */
  getStats: () => HexLayerStats;
  destroy: () => void;
}

export interface HexLayerStats {
  totalChunks: number;
  visibleChunks: number;
  builtChunks: number;
  lastCullMs: number;
  lastBuildMs: number;
  lastTierSwitchMs: number;
}

// Bump 32→64 (2026-04-26): higher base texture resolution reduces AA fringe
// "vết border các cell mờ" visible at low zoom in particles engine.
const HEX_TEXTURE_SIDE = 64; // px — hex side length in render texture
const HEX_TEX_W = Math.ceil(2 * HEX_TEXTURE_SIDE);            // 128
const HEX_TEX_H = Math.ceil(SQRT_3 * HEX_TEXTURE_SIDE);       // 111

const BORDER_COLOR = 0x05101a;
const BORDER_ALPHA = 0.85;
// Stroke width = fraction of hex side (matches Phase < 6 visual).
const BORDER_WIDTH_FACTOR = 0.06;

function makeHexTexture(app: Application): RenderTexture {
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

export function createHexLayer(app: Application): HexLayer {
  const root = new Container();
  root.label = 'hex-layer';
  root.cullable = false; // chunks own visibility; CullerPlugin would double-count

  const texture = makeHexTexture(app);

  let chunkGrid: ChunkGrid | null = null;
  let currentTier: TierData | null = null;
  let currentLut: Uint32Array | null = null;
  let currentHexSizeWorldPx = 0;
  let currentBorderWidth = 0;
  let bordersVisible = true;

  // visible-set tracking for diff. Entries are stable references from rbush.
  let visibleSet: Set<ChunkEntry> = new Set();

  // Phase 6 Iter 1: LRU eviction. Caps built (chunk, offset) instances so
  // pan-around-world doesn't accumulate full 96-instance heap (785 MB observed
  // → ~150 MB target). Build order = FIFO age. Evict oldest non-visible.
  // 24 = arch § 14 worst-case (12 visible × 2 wrap copies straddling seam).
  const MAX_BUILT_INSTANCES = 24;
  const builtOrder: Array<{ chunk: ChunkData; offsetX: number }> = [];

  const isCurrentlyVisible = (chunk: ChunkData, offsetX: number): boolean => {
    for (const e of visibleSet) {
      if (e.chunk === chunk && e.offsetX === offsetX) return true;
    }
    return false;
  };

  const evictIfNeeded = (): void => {
    let safety = 64;
    while (builtOrder.length > MAX_BUILT_INSTANCES && safety-- > 0) {
      let evictIdx = -1;
      for (let i = 0; i < builtOrder.length; i++) {
        const cand = builtOrder[i]!;
        if (!isCurrentlyVisible(cand.chunk, cand.offsetX)) { evictIdx = i; break; }
      }
      if (evictIdx < 0) break; // all built are visible — accept transient overcap
      const evicted = builtOrder.splice(evictIdx, 1)[0]!;
      const pc = evicted.chunk.particlesByOffset.get(evicted.offsetX);
      pc?.destroy({ children: true });
      evicted.chunk.particlesByOffset.delete(evicted.offsetX);
      const g = evicted.chunk.bordersByOffset.get(evicted.offsetX);
      g?.destroy();
      evicted.chunk.bordersByOffset.delete(evicted.offsetX);
      evicted.chunk.builtAtByOffset.delete(evicted.offsetX);
      stats.builtChunks--;
    }
  };

  // Stats (mutable; getStats returns snapshot).
  const stats: HexLayerStats = {
    totalChunks: 0,
    visibleChunks: 0,
    builtChunks: 0,
    lastCullMs: 0,
    lastBuildMs: 0,
    lastTierSwitchMs: 0,
  };

  const buildChunkOffset = (chunk: ChunkData, offsetX: number): void => {
    if (chunk.builtAtByOffset.has(offsetX)) return;
    if (!currentTier || !currentLut) return;
    if (chunk.hexes.length === 0 && chunk.edges.length === 0) {
      chunk.builtAtByOffset.set(offsetX, performance.now());
      return; // empty chunk — never builds GPU
    }

    performance.mark('chunk-build-start');
    const t0 = performance.now();
    const scale = currentHexSizeWorldPx / HEX_TEXTURE_SIDE;
    const lut = currentLut;

    // Particles (hex fills)
    const pc = new ParticleContainer({
      dynamicProperties: { position: false, scale: false, rotation: false, color: false },
    });
    pc.label = `${chunk.bbox.id}-fill-${offsetX}`;
    pc.cullable = false;

    const hexes: ReadonlyArray<HexRecord> = chunk.hexes;
    for (let i = 0; i < hexes.length; i++) {
      const h = hexes[i]!;
      // axialToPx inlined — chunk doesn't store hex world coords, recompute
      // is cheaper than O(N) extra Float32Arrays per chunk for one-time build.
      const hx = currentHexSizeWorldPx * 1.5 * h.q;
      const hy = -currentHexSizeWorldPx * SQRT_3 * (h.r + h.q / 2);
      pc.addParticle(new Particle({
        texture,
        x: hx + offsetX,
        y: hy,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: scale,
        scaleY: scale,
        tint: lut[h.countryId] ?? 0x666688,
      }));
    }

    // Borders (Graphics overlay)
    const g = new Graphics();
    g.label = `${chunk.bbox.id}-border-${offsetX}`;
    g.cullable = false;
    g.visible = bordersVisible;
    const edges = chunk.edges;
    for (let i = 0; i < edges.length; i += 4) {
      g.moveTo(edges[i]! + offsetX, edges[i + 1]!).lineTo(edges[i + 2]! + offsetX, edges[i + 3]!);
    }
    if (edges.length > 0) {
      g.stroke({ color: BORDER_COLOR, alpha: BORDER_ALPHA, width: currentBorderWidth });
    }

    chunk.particlesByOffset.set(offsetX, pc);
    chunk.bordersByOffset.set(offsetX, g);
    chunk.builtAtByOffset.set(offsetX, performance.now());
    builtOrder.push({ chunk, offsetX });
    root.addChild(pc);
    root.addChild(g);

    const dt = performance.now() - t0;
    stats.lastBuildMs = dt;
    stats.builtChunks++;
    performance.mark('chunk-build-end');
    performance.measure('chunk-build', 'chunk-build-start', 'chunk-build-end');
    evictIfNeeded();
    if (hexes.length > 50000) {
      console.warn(
        `[hex-layer] chunk ${chunk.bbox.id} built ${hexes.length} hexes in ${dt.toFixed(1)}ms (>50K threshold)`,
      );
    }
  };

  const setTier = (tier: TierData, lut: Uint32Array): void => {
    const t0 = performance.now();
    performance.mark('tier-switch-start');

    chunkGrid?.destroy();
    chunkGrid = null;
    visibleSet = new Set();
    builtOrder.length = 0;
    stats.builtChunks = 0;
    stats.visibleChunks = 0;

    currentTier = tier;
    currentLut = lut;
    currentHexSizeWorldPx = kmToWorldPx(tier.sizeKm);
    currentBorderWidth = currentHexSizeWorldPx * BORDER_WIDTH_FACTOR;

    const wrapOffsets: ReadonlyArray<number> = WRAP_TIER_NAMES.has(tier.name)
      ? [-WRAP_DISTANCE_PX, 0, WRAP_DISTANCE_PX]
      : [0];

    // World bounds: x uses WRAP_DISTANCE_PX (snapped to hex pitch — projection.ts)
    // not raw 2π·R, so chunks align with wrap seams. Y uses worldBoundsPx().
    const bounds = worldBoundsPx();
    const worldMinX = -WRAP_DISTANCE_PX / 2;
    const worldWidth = WRAP_DISTANCE_PX;
    const worldMinY = bounds.minY;
    const worldHeight = bounds.height;

    chunkGrid = createChunkGrid(
      tier,
      currentHexSizeWorldPx,
      worldMinX,
      worldMinY,
      worldWidth,
      worldHeight,
      wrapOffsets,
    );
    stats.totalChunks = chunkGrid.chunks.length;

    const dt = performance.now() - t0;
    stats.lastTierSwitchMs = dt;
    performance.mark('tier-switch-end');
    performance.measure('tier-switch', 'tier-switch-start', 'tier-switch-end');
    console.info(
      `[hex-layer] tier ${tier.name}: ${tier.hexes.length} hexes → ${chunkGrid.chunks.length} chunks ` +
      `(grid build ${dt.toFixed(1)}ms, GPU lazy)`,
    );
  };

  const setBordersVisible = (visible: boolean): void => {
    bordersVisible = visible;
    if (!chunkGrid) return;
    for (const chunk of chunkGrid.chunks) {
      for (const g of chunk.bordersByOffset.values()) g.visible = visible;
    }
  };

  const updateVisibility = (bbox: ViewportBbox): void => {
    if (!chunkGrid) return;
    const t0 = performance.now();
    performance.mark('cull-query-start');

    // 1-chunk margin (D-5) — covers cross-chunk border edges (§ 8.6) and
    // prevents flicker on micro-pan. Margin sized to chunk extent of THIS tier.
    const chunkW = chunkGrid.chunks[0]?.bbox.width ?? 0;
    const chunkH = chunkGrid.chunks[0]?.bbox.height ?? 0;
    const expanded = {
      minX: bbox.minX - chunkW,
      minY: bbox.minY - chunkH,
      maxX: bbox.maxX + chunkW,
      maxY: bbox.maxY + chunkH,
    };

    const nowEntries = chunkGrid.spatialIndex.search(expanded);
    const nowSet = new Set<ChunkEntry>(nowEntries);

    // Hide entries that left viewport (don't destroy — keeps GPU warm).
    for (const e of visibleSet) {
      if (nowSet.has(e)) continue;
      const pc = e.chunk.particlesByOffset.get(e.offsetX);
      if (pc) pc.visible = false;
      const g = e.chunk.bordersByOffset.get(e.offsetX);
      if (g) g.visible = false;
    }

    // Show entries that entered viewport (lazy-build if first time).
    for (const e of nowEntries) {
      if (!e.chunk.builtAtByOffset.has(e.offsetX)) {
        buildChunkOffset(e.chunk, e.offsetX);
      }
      const pc = e.chunk.particlesByOffset.get(e.offsetX);
      if (pc) pc.visible = true;
      const g = e.chunk.bordersByOffset.get(e.offsetX);
      if (g) g.visible = bordersVisible;
    }

    visibleSet = nowSet;
    stats.visibleChunks = nowEntries.length;
    stats.lastCullMs = performance.now() - t0;
    performance.mark('cull-query-end');
    performance.measure('cull-query', 'cull-query-start', 'cull-query-end');
  };

  const getStats = (): HexLayerStats => ({ ...stats });

  const destroy = (): void => {
    chunkGrid?.destroy();
    chunkGrid = null;
    texture.destroy();
    root.destroy({ children: true });
  };

  return { root, setTier, setBordersVisible, updateVisibility, getStats, destroy };
}
