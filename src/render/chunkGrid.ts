/**
 * Chunk grid — Phase 6 viewport-based culling.
 *
 * World partitioned vào COLS × ROWS = 32 logical chunks. Mỗi chunk:
 *   - Owns hexes whose centroid falls in chunk bbox (lower-bound floor rule).
 *   - Owns border edges whose MIDPOINT falls in chunk bbox.
 *
 * Pure data layer: KHÔNG construct GPU resources. ParticleContainer +
 * Graphics được hexLayer.ts allocate lazily khi chunk first becomes visible.
 *
 * Wrap copies (50km/25km tiers): single ChunkData logically, nhưng rbush
 * có 1 entry per (chunk, offsetX) để query trực tiếp. Mỗi entry GPU container
 * riêng (cùng hex/edge data, position-shifted).
 *
 * Border edges PRESERVE wrap-aware lookup (q wrap → r adjust ±halfWrap) —
 * critical để Bering-strait seam stay invisible (Justin 2026-04-26).
 */
import RBush from 'rbush';
import type { Graphics, ParticleContainer } from 'pixi.js';
import type { TierData, HexRecord } from '../data/tiers';
import { axialToPx, SQRT_3 } from '../geo/hex';
import { WRAP_HEX_COUNT_BASE, WRAP_BASE_TIER_KM } from '../geo/projection';

export const COLS = 8;
export const ROWS = 4;

// 6 axial neighbor offsets (flat-top, q-axis right, r-axis down-left).
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [+1, 0], [+1, -1], [0, -1],
  [-1, 0], [-1, +1], [0, +1],
];

const PERP_F = 0.5 / SQRT_3;

export interface ChunkBbox {
  id: string;          // 'c-3-1'
  col: number;         // 0..COLS-1
  row: number;         // 0..ROWS-1
  worldX: number;      // chunk left edge (world px, inclusive)
  worldY: number;      // chunk top edge  (world px, inclusive)
  width: number;
  height: number;
}

export interface ChunkData {
  bbox: ChunkBbox;
  hexes: HexRecord[];
  /** Edge segments owned by this chunk: [x1,y1,x2,y2, ...]. */
  edges: Float32Array;
  /** Lazy-built GPU resources, keyed by wrap offset (px). */
  particlesByOffset: Map<number, ParticleContainer>;
  bordersByOffset: Map<number, Graphics>;
  /** perf.now() when (chunk, offset) was first built; 0 = not built. */
  builtAtByOffset: Map<number, number>;
}

export interface ChunkEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  chunk: ChunkData;
  offsetX: number;
}

class ChunkRBush extends RBush<ChunkEntry> {}

export interface ChunkGrid {
  chunks: ChunkData[];
  spatialIndex: ChunkRBush;
  /** Destroys all built GPU resources (idempotent). */
  destroy(): void;
}

/**
 * Build chunk grid for tier. Pure CPU; no GPU allocation.
 *
 * @param tier            tier data (already loaded)
 * @param hexSizeWorldPx  hex side length in world px (== kmToWorldPx(tier.sizeKm))
 * @param worldMinX       world bbox left edge
 * @param worldMinY       world bbox top edge
 * @param worldWidth      total world width
 * @param worldHeight     total world height (Mercator clamped ±85°)
 * @param wrapOffsets     [-W, 0, +W] for wrap tiers, [0] for fine tiers
 */
export function createChunkGrid(
  tier: TierData,
  hexSizeWorldPx: number,
  worldMinX: number,
  worldMinY: number,
  worldWidth: number,
  worldHeight: number,
  wrapOffsets: ReadonlyArray<number>,
): ChunkGrid {
  const chunkW = worldWidth / COLS;
  const chunkH = worldHeight / ROWS;

  // Allocate empty chunks first
  const chunks: ChunkData[] = new Array(COLS * ROWS);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      chunks[row * COLS + col] = {
        bbox: {
          id: `c-${col}-${row}`,
          col,
          row,
          worldX: worldMinX + col * chunkW,
          worldY: worldMinY + row * chunkH,
          width: chunkW,
          height: chunkH,
        },
        hexes: [],
        edges: new Float32Array(0),
        particlesByOffset: new Map(),
        bordersByOffset: new Map(),
        builtAtByOffset: new Map(),
      };
    }
  }

  // Pass 1: assign hexes by centroid, build countryByKey for cross-chunk lookup.
  // Pre-compute (x, y) once per hex (reused for edges later via temp arrays).
  const N = tier.hexes.length;
  const hexX = new Float32Array(N);
  const hexY = new Float32Array(N);
  const KEY_OFFSET = 32768;
  const countryByKey = new Map<number, number>();

  for (let i = 0; i < N; i++) {
    const h = tier.hexes[i]!;
    const [x, y] = axialToPx(h.q, h.r, hexSizeWorldPx);
    hexX[i] = x;
    hexY[i] = y;
    const key = (h.q + KEY_OFFSET) * 65536 + (h.r + KEY_OFFSET);
    countryByKey.set(key, h.countryId);

    const col = clampInt((x - worldMinX) / chunkW, 0, COLS - 1);
    const row = clampInt((y - worldMinY) / chunkH, 0, ROWS - 1);
    chunks[row * COLS + col]!.hexes.push(h);
  }

  // Pass 2: compute border edges with wrap-aware lookup, partition by midpoint.
  // Wrap-aware lookup MIRRORS computeBorderEdges in old hexLayer.ts:113-119 —
  // when q wraps over wrapHexCount columns, r adjusts ±halfWrap to keep the
  // flat-top axial y-coord continuous (else Bering seam zigzags reappear).
  const wrapHexCount = WRAP_HEX_COUNT_BASE * (WRAP_BASE_TIER_KM / tier.sizeKm);
  const halfWrap = Math.floor(wrapHexCount / 2);
  const qMin = -halfWrap;
  const qMax = qMin + wrapHexCount - 1;

  const wrapLookup = (q: number, r: number): number | undefined => {
    let qq = q;
    let rr = r;
    if (qq > qMax) { qq -= wrapHexCount; rr += halfWrap; }
    else if (qq < qMin) { qq += wrapHexCount; rr -= halfWrap; }
    return countryByKey.get((qq + KEY_OFFSET) * 65536 + (rr + KEY_OFFSET));
  };

  // Per-chunk number[] buffer (push then convert to Float32Array). Avoids
  // 2-pass count-then-fill while keeping tight per-chunk locality.
  const edgeBuckets: number[][] = new Array(COLS * ROWS);
  for (let i = 0; i < edgeBuckets.length; i++) edgeBuckets[i] = [];

  for (let i = 0; i < N; i++) {
    const h = tier.hexes[i]!;
    const hx = hexX[i]!;
    const hy = hexY[i]!;
    for (let n = 0; n < 6; n++) {
      const off = NEIGHBORS[n]!;
      const nq = h.q + off[0];
      const nr = h.r + off[1];
      const neighborCountry = wrapLookup(nq, nr);

      // Skip if same country (no border) or owned by lower countryId (dedup).
      if (neighborCountry === h.countryId) continue;
      if (neighborCountry !== undefined && h.countryId > neighborCountry) continue;

      const [nx, ny] = axialToPx(nq, nr, hexSizeWorldPx);
      const mx = (hx + nx) / 2;
      const my = (hy + ny) / 2;
      const dx = nx - hx;
      const dy = ny - hy;
      const px = -dy * PERP_F;
      const py = dx * PERP_F;

      // Midpoint (mx, my) chooses owner chunk. Clamp because wrap-edges can
      // sit slightly outside [-W/2, +W/2] when nq is at wrap seam (nx beyond
      // canonical world bounds — see § 8.2 of phase-6-architecture.md).
      const col = clampInt((mx - worldMinX) / chunkW, 0, COLS - 1);
      const row = clampInt((my - worldMinY) / chunkH, 0, ROWS - 1);
      const bucket = edgeBuckets[row * COLS + col]!;
      bucket.push(mx + px, my + py, mx - px, my - py);
    }
  }

  // Convert buckets to Float32Array.
  for (let i = 0; i < chunks.length; i++) {
    chunks[i]!.edges = new Float32Array(edgeBuckets[i]!);
  }

  // Build rbush entries: 1 per (chunk, offsetX). Skip empty chunks (no hexes
  // AND no edges) — never visible work.
  const entries: ChunkEntry[] = [];
  for (const chunk of chunks) {
    if (chunk.hexes.length === 0 && chunk.edges.length === 0) continue;
    for (const offsetX of wrapOffsets) {
      entries.push({
        minX: chunk.bbox.worldX + offsetX,
        minY: chunk.bbox.worldY,
        maxX: chunk.bbox.worldX + chunk.bbox.width + offsetX,
        maxY: chunk.bbox.worldY + chunk.bbox.height,
        chunk,
        offsetX,
      });
    }
  }

  const spatialIndex = new ChunkRBush();
  spatialIndex.load(entries);

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const chunk of chunks) {
      for (const pc of chunk.particlesByOffset.values()) pc.destroy({ children: true });
      for (const g of chunk.bordersByOffset.values()) g.destroy();
      chunk.particlesByOffset.clear();
      chunk.bordersByOffset.clear();
      chunk.builtAtByOffset.clear();
    }
    spatialIndex.clear();
  };

  return { chunks, spatialIndex, destroy };
}

/** Floor + clamp to integer in [lo, hi]. */
function clampInt(v: number, lo: number, hi: number): number {
  const i = Math.floor(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}
