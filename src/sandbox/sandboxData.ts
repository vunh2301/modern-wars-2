/**
 * Sandbox synthetic data — 64×64 hex grid với terrain generation.
 *
 * Mục tiêu: test bed cho texture / shader experiments + terrain palette test.
 * Bypass tier/chunk/manifest infrastructure entirely.
 *
 * Format match MWCK v2 instance shape (cx:f32, cy:f32, RGBA:u8×4) để dùng
 * chung shader (createHexShader).
 */
import { kmToWorldPx } from '../geo/projection';

export interface SandboxBuffers {
  /** 6 hex template vertices × (x:f32, y:f32) pre-scaled. */
  templateBuffer: Uint8Array;
  /** Per-hex instance attrs (cx:f32, cy:f32, RGBA:u8×4) interleaved. */
  instanceBuffer: Uint8Array;
  /** Static fan triangulation từ vertex 0 (12 uint32 = 4 triangles). */
  indexBuffer: Uint32Array;
  hexCount: number;
}

const TIER_KM = 25; // tier 2 (25km)

// Fan triangulation từ vertex 0 (4 triangles, no center vertex).
const FAN_INDICES = new Uint32Array([
  0, 1, 2,
  0, 2, 3,
  0, 3, 4,
  0, 4, 5,
]);

// ─── Terrain palette ──────────────────────────────────────────────────────────
// 6 terrain types cho modern war RTS world map. RGB tuple + future gameplay.
type RGBA = readonly [number, number, number, number];

export const enum Terrain {
  Ocean = 0,    // deep water, impassable land, naval only
  Coast = 1,    // shallow water, amphibious assault zone
  Plains = 2,   // open, fast move, no defense bonus
  Forest = 3,   // slow move, +25% defense, blocks LOS
  Mountain = 4, // very slow, +50% defense, naturally fortified
  Urban = 5,    // city blocks, +40% defense, controllable
}

// Indexed by Terrain enum value (0..5) for direct number lookup.
const TERRAIN_COLORS: ReadonlyArray<RGBA> = [
  [14, 33, 64, 255],    // 0 Ocean    #0e2140 deep blue
  [30, 69, 112, 255],   // 1 Coast    #1e4570 lighter blue
  [156, 138, 85, 255],  // 2 Plains   #9c8a55 khaki-green
  [46, 94, 44, 255],    // 3 Forest   #2e5e2c dark green
  [110, 94, 84, 255],   // 4 Mountain #6e5e54 gray-brown
  [74, 74, 74, 255],    // 5 Urban    #4a4a4a dark gray
];

// ─── Generator ────────────────────────────────────────────────────────────────

/** Generate hex grid với terrain noise. */
export function generateSandboxData(rows = 64, cols = 64, seed = 1): SandboxBuffers {
  const sizeWorldPx = kmToWorldPx(TIER_KM);

  // Template: 6 vertices around hex center, FLAT-TOP orientation (match main).
  const template = new Float32Array(12);
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    template[i * 2] = Math.cos(angle) * sizeWorldPx;
    template[i * 2 + 1] = Math.sin(angle) * sizeWorldPx;
  }

  const hexCount = rows * cols;
  const instances = new ArrayBuffer(hexCount * 12);
  const instView = new DataView(instances);

  // Generate terrain map (2 noise layers: elevation + moisture).
  const terrainMap = generateTerrainMap(rows, cols, seed);

  const halfC = Math.floor(cols / 2);
  const halfR = Math.floor(rows / 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const offset = idx * 12;

      // FLAT-TOP offset coords (odd-q vertical layout) → rectangular bounding box.
      // x = size * 1.5 * c_centered
      // y = size * √3 * r_centered + (c%2==1 ? size*√3/2 : 0)
      const cCol = c - halfC;
      const rRow = r - halfR;
      const x = sizeWorldPx * 1.5 * cCol;
      const y = sizeWorldPx * Math.sqrt(3) * rRow + (c % 2 === 1 ? sizeWorldPx * Math.sqrt(3) / 2 : 0);

      instView.setFloat32(offset, x, true);
      instView.setFloat32(offset + 4, y, true);

      const color = TERRAIN_COLORS[terrainMap[idx]!]!;
      instView.setUint8(offset + 8, color[0]);
      instView.setUint8(offset + 9, color[1]);
      instView.setUint8(offset + 10, color[2]);
      instView.setUint8(offset + 11, color[3]);
    }
  }

  return {
    templateBuffer: new Uint8Array(template.buffer),
    instanceBuffer: new Uint8Array(instances),
    indexBuffer: FAN_INDICES.slice(),
    hexCount,
  };
}

/**
 * Terrain map generator — 2-layer value noise (elevation + moisture).
 *
 * Pipeline:
 *   1. Elevation noise (3 octaves) → ocean / land / mountain
 *   2. Moisture noise (2 octaves, different seed) → forest vs plains on land
 *   3. Coast pass: land hex giáp ocean → Coast
 *   4. Urban pass: sparse random trên Plains (~3% chance)
 */
function generateTerrainMap(rows: number, cols: number, seed: number): Uint8Array {
  const map = new Uint8Array(rows * cols);

  const elevNoise = makeValueNoise(seed * 73 + 1);
  const moistNoise = makeValueNoise(seed * 1531 + 17);

  // Pass 1+2: elevation + moisture → base terrain
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      // Sample noise in 0..1 range, scale x4 for "continent-sized" features.
      const fx = c / cols;
      const fy = r / rows;
      const elevation = octaveNoise(elevNoise, fx, fy, 3, 4);
      const moisture = octaveNoise(moistNoise, fx, fy, 2, 4);

      let terrain: Terrain;
      if (elevation < 0.40) terrain = Terrain.Ocean;
      else if (elevation > 0.78) terrain = Terrain.Mountain;
      else if (moisture > 0.55) terrain = Terrain.Forest;
      else terrain = Terrain.Plains;

      map[idx] = terrain;
    }
  }

  // Pass 3: Coast — land hex giáp ocean.
  // Flat-top axial 6-neighbor offsets (approximate for offset coords).
  const NEIGHBORS = [
    [+1, 0], [-1, 0],
    [0, +1], [0, -1],
    [+1, -1], [-1, +1],
  ];
  const original = new Uint8Array(map);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (original[idx] === Terrain.Ocean) continue;
      // Skip mountains becoming coast (mountain takes priority).
      if (original[idx] === Terrain.Mountain) continue;
      for (const [dc, dr] of NEIGHBORS) {
        const nr = r + dr!;
        const nc = c + dc!;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nIdx = nr * cols + nc;
        if (original[nIdx] === Terrain.Ocean) {
          map[idx] = Terrain.Coast;
          break;
        }
      }
    }
  }

  // Pass 4: Urban — sparse random trên Plains.
  const urbanRng = mulberry32(seed * 2027 + 31);
  for (let i = 0; i < map.length; i++) {
    if (map[i] === Terrain.Plains && urbanRng() < 0.03) {
      map[i] = Terrain.Urban;
    }
  }

  return map;
}

// ─── Noise helpers ────────────────────────────────────────────────────────────

interface ValueNoise {
  sample(x: number, y: number): number;
}

/** Simple value-noise: random per integer cell, bilinear interpolated. */
function makeValueNoise(seed: number): ValueNoise {
  // Pre-generate gradient grid (32×32). For a 64×64 map this is enough.
  const GRID = 64;
  const grid = new Float32Array(GRID * GRID);
  const rng = mulberry32(seed);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  const sample = (x: number, y: number): number => {
    // x,y in 0..1 — map to grid cell.
    const fx = x * GRID;
    const fy = y * GRID;
    const x0 = Math.floor(fx) % GRID;
    const y0 = Math.floor(fy) % GRID;
    const x1 = (x0 + 1) % GRID;
    const y1 = (y0 + 1) % GRID;
    const tx = fx - Math.floor(fx);
    const ty = fy - Math.floor(fy);
    // Smoothstep ease for less linear-grid feel.
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const v00 = grid[y0 * GRID + x0]!;
    const v10 = grid[y0 * GRID + x1]!;
    const v01 = grid[y1 * GRID + x0]!;
    const v11 = grid[y1 * GRID + x1]!;
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  };

  return { sample };
}

/** Sum N octaves of noise at increasing frequency, decreasing amplitude. */
function octaveNoise(
  n: ValueNoise,
  x: number,
  y: number,
  octaves: number,
  baseFreq: number,
): number {
  let total = 0;
  let amplitude = 1;
  let freq = baseFreq;
  let ampSum = 0;
  for (let i = 0; i < octaves; i++) {
    total += n.sample(x * freq, y * freq) * amplitude;
    ampSum += amplitude;
    amplitude *= 0.5;
    freq *= 2;
  }
  return total / ampSum; // normalize to 0..1
}

/** Mulberry32 PRNG — deterministic seed (?seed=N URL param test). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
