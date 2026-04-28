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
// 7 terrain types cho modern war RTS world map. RGB tuple + future gameplay.
type RGBA = readonly [number, number, number, number];

export const enum Terrain {
  Ocean = 0,    // deep water, impassable land, naval only
  Coast = 1,    // shallow water, amphibious assault zone
  Plains = 2,   // open, fast move, no defense bonus
  Forest = 3,   // slow move, +25% defense, blocks LOS
  Mountain = 4, // very slow, +50% defense, naturally fortified
  Urban = 5,    // city blocks, +40% defense, controllable
  Desert = 6,   // arid plains, fast move, low defense, low moisture
}

// Indexed by Terrain enum value (0..6) for direct number lookup.
const TERRAIN_COLORS: ReadonlyArray<RGBA> = [
  [14, 33, 64, 255],    // 0 Ocean    #0e2140 deep blue
  [30, 69, 112, 255],   // 1 Coast    #1e4570 lighter blue
  [156, 138, 85, 255],  // 2 Plains   #9c8a55 khaki-green
  [46, 94, 44, 255],    // 3 Forest   #2e5e2c dark green
  [110, 94, 84, 255],   // 4 Mountain #6e5e54 gray-brown
  [74, 74, 74, 255],    // 5 Urban    #4a4a4a dark gray
  [196, 168, 120, 255], // 6 Desert   #c4a878 sandy yellow
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
  // 16 bytes/instance: cx:f32, cy:f32, color:unorm8x4, terrainId:u8, seed:u8, pad:u16
  const instances = new ArrayBuffer(hexCount * 16);
  const instView = new DataView(instances);

  // Generate terrain map (2 noise layers: elevation + moisture).
  const terrainMap = generateTerrainMap(rows, cols, seed);

  const halfC = Math.floor(cols / 2);
  const halfR = Math.floor(rows / 2);

  // Per-hex deterministic seed (1 byte) — drives shader procedural noise jitter.
  const seedRng = mulberry32(seed * 9001 + 7);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const offset = idx * 16;

      // FLAT-TOP offset coords (odd-q vertical layout) → rectangular bounding box.
      // x = size * 1.5 * c_centered
      // y = size * √3 * r_centered + (c%2==1 ? size*√3/2 : 0)
      const cCol = c - halfC;
      const rRow = r - halfR;
      const x = sizeWorldPx * 1.5 * cCol;
      const y = sizeWorldPx * Math.sqrt(3) * rRow + (c % 2 === 1 ? sizeWorldPx * Math.sqrt(3) / 2 : 0);

      instView.setFloat32(offset, x, true);
      instView.setFloat32(offset + 4, y, true);

      const terrainId = terrainMap[idx]!;
      const color = TERRAIN_COLORS[terrainId]!;
      instView.setUint8(offset + 8, color[0]);
      instView.setUint8(offset + 9, color[1]);
      instView.setUint8(offset + 10, color[2]);
      instView.setUint8(offset + 11, color[3]);

      // Extended bytes for shader procedural texture.
      instView.setUint8(offset + 12, terrainId);              // terrainId 0..5
      instView.setUint8(offset + 13, Math.floor(seedRng() * 256));  // per-hex seed
      // [14..15] pad — leave 0
    }
  }

  return {
    templateBuffer: new Uint8Array(template.buffer),
    instanceBuffer: new Uint8Array(instances),
    indexBuffer: FAN_INDICES.slice(),
    hexCount,
  };
}

// ─── Tunable constants ────────────────────────────────────────────────────────
// Terrain generation knobs. Tune để rebalance landmass / mountain chains / etc.
const CONTINENT_FREQ = 1.6;     // low-freq base shape (large continents). Lower = bigger landmass.
const DETAIL_FREQ = 5;          // medium-freq variation cho coastline irregularity.
const RIDGE_FREQ = 3.5;         // mountain chain freq. Higher = more chains, shorter.
const MOISTURE_FREQ = 2.5;      // moisture macro distribution.
const RADIAL_FALLOFF_WEIGHT = 0.42; // 0 = no edge bias, 1 = strong edge ocean ring.
const SEA_LEVEL = 0.50;         // landScore < this → Ocean. Tune for ocean ratio.
const RIDGE_THRESHOLD = 0.78;   // ridge field threshold cho Mountain.
const ELEVATION_MOUNTAIN_MIN = 0.55; // mountain phải elevation >= này.
const FOREST_MOISTURE = 0.58;   // moisture > này → Forest.
const DESERT_MOISTURE = 0.32;   // moisture < này → Desert.
const URBAN_PROBABILITY = 0.006; // sparse urban (< 1% of Plains/Coast).
const SMOOTHING_PASSES = 2;     // neighbor-majority smoothing iterations.
const PROXIMITY_WATER_RANGE = 8; // distance cells over which water proximity affects moisture.

/**
 * Terrain map generator — realistic macro structure.
 *
 * Pipeline:
 *   1. Compute fields: continent / elevation / ridge / raw moisture
 *   2. Initial classification: ocean vs land via landScore
 *   3. BFS distance-to-ocean cho proximityWater
 *   4. Refine land: Mountain (ridge+elev) → Forest (moist) → Desert (dry) → Plains
 *   5. Smoothing 2 passes (neighbor-majority, protect Mountain/Ocean)
 *   6. Coast pass (after smoothing) — land hex giáp ocean
 *   7. Urban sparse trên Plains/Coast
 */
function generateTerrainMap(rows: number, cols: number, seed: number): Uint8Array {
  const map = new Uint8Array(rows * cols);
  const total = rows * cols;

  // Independent noise generators — different seed multipliers cho decorrelation.
  const continentNoise = makeValueNoise(seed * 73 + 1);
  const detailNoise = makeValueNoise(seed * 211 + 7);
  const moistNoise = makeValueNoise(seed * 1531 + 17);
  const ridgeNoise = makeValueNoise(seed * 2789 + 11);

  const elevation = new Float32Array(total);
  const ridge = new Float32Array(total);
  const rawMoisture = new Float32Array(total);

  // Pass 1: compute fields per cell.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const fx = c / cols;
      const fy = r / rows;

      // Radial falloff: 1.0 at center, 0 at corners (creates continent illusion).
      const dx = (fx - 0.5) * 2;
      const dy = (fy - 0.5) * 2;
      const radial = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));

      // Continent score: low-freq + medium-freq + radial bias.
      const lowFreq = octaveNoise(continentNoise, fx, fy, 2, CONTINENT_FREQ);
      const medFreq = octaveNoise(detailNoise, fx, fy, 3, DETAIL_FREQ);
      const landScore =
        lowFreq * (1 - RADIAL_FALLOFF_WEIGHT - 0.20) +
        medFreq * 0.20 +
        radial * RADIAL_FALLOFF_WEIGHT;

      // Elevation: weighted combo (continent dominates).
      elevation[idx] = landScore * 0.72 + medFreq * 0.28;

      // Ridge field: 1 - |2*n - 1| (peaks where noise = 0.5) → ridge-like patterns.
      const rNoise = octaveNoise(ridgeNoise, fx, fy, 3, RIDGE_FREQ);
      ridge[idx] = 1 - Math.abs(2 * rNoise - 1);

      // Raw moisture noise (refined later with proximity-to-water).
      rawMoisture[idx] = octaveNoise(moistNoise, fx, fy, 2, MOISTURE_FREQ);

      // Initial ocean/land split.
      map[idx] = landScore < SEA_LEVEL ? Terrain.Ocean : Terrain.Plains;
    }
  }

  // Pass 2: BFS distance-to-ocean (Manhattan-ish via offset hex neighbors).
  const distToOcean = computeDistanceToOcean(map, rows, cols);

  // Pass 3: refine land classification.
  for (let i = 0; i < total; i++) {
    if (map[i] === Terrain.Ocean) continue;

    const elev = elevation[i]!;
    const ri = ridge[i]!;

    // Mountain — high ridge + high elevation (forms chains, not isolated dots).
    if (ri > RIDGE_THRESHOLD && elev > ELEVATION_MOUNTAIN_MIN) {
      map[i] = Terrain.Mountain;
      continue;
    }

    // Moisture: noise * 0.6 + proximity-to-water * 0.25 - elevation penalty * 0.15.
    const proximity = Math.max(0, 1 - distToOcean[i]! / PROXIMITY_WATER_RANGE);
    const moisture = rawMoisture[i]! * 0.6 + proximity * 0.25 - elev * 0.15 + 0.15;

    if (moisture > FOREST_MOISTURE) {
      map[i] = Terrain.Forest;
    } else if (moisture < DESERT_MOISTURE) {
      map[i] = Terrain.Desert;
    } else {
      map[i] = Terrain.Plains;
    }
  }

  // Pass 4: smoothing — neighbor-majority để remove 1-cell speckles.
  // Protect Ocean + Mountain (preserve macro shape).
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    smoothMap(map, rows, cols);
  }

  // Pass 5: Coast detection (after smoothing, before Urban).
  const beforeCoast = new Uint8Array(map);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (beforeCoast[idx] === Terrain.Ocean) continue;
      if (beforeCoast[idx] === Terrain.Mountain) continue;
      for (const [nc, nr] of getOffsetNeighbors(c, r)) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (beforeCoast[nr * cols + nc] === Terrain.Ocean) {
          map[idx] = Terrain.Coast;
          break;
        }
      }
    }
  }

  // Pass 6: Urban — sparse random trên Plains/Coast (rare, < 1% chance).
  const urbanRng = mulberry32(seed * 2027 + 31);
  for (let i = 0; i < total; i++) {
    if ((map[i] === Terrain.Plains || map[i] === Terrain.Coast) && urbanRng() < URBAN_PROBABILITY) {
      map[i] = Terrain.Urban;
    }
  }

  return map;
}

// ─── Topology helpers ─────────────────────────────────────────────────────────

/**
 * Flat-top odd-q offset coord 6-neighbor offsets.
 * Even col (c%2 == 0): NW(c-1,r-1), W(c-1,r), N(c,r-1), S(c,r+1), NE(c+1,r-1), E(c+1,r)
 * Odd col  (c%2 == 1): W(c-1,r), SW(c-1,r+1), N(c,r-1), S(c,r+1), E(c+1,r), SE(c+1,r+1)
 *
 * Reference: redblobgames.com/grids/hexagons (offset coordinates).
 */
function getOffsetNeighbors(c: number, r: number): ReadonlyArray<readonly [number, number]> {
  if (c % 2 === 1) {
    return [[c - 1, r], [c - 1, r + 1], [c, r - 1], [c, r + 1], [c + 1, r], [c + 1, r + 1]];
  }
  return [[c - 1, r - 1], [c - 1, r], [c, r - 1], [c, r + 1], [c + 1, r - 1], [c + 1, r]];
}

/** BFS distance from each cell to nearest Ocean (in hex-step count). */
function computeDistanceToOcean(map: Uint8Array, rows: number, cols: number): Uint8Array {
  const total = rows * cols;
  const dist = new Uint8Array(total).fill(255);
  const queue: number[] = [];

  // Seed BFS với all Ocean cells (distance 0).
  for (let i = 0; i < total; i++) {
    if (map[i] === Terrain.Ocean) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  // BFS expand.
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++]!;
    const r = (idx / cols) | 0;
    const c = idx - r * cols;
    const d = dist[idx]!;
    if (d >= 254) continue; // saturate
    for (const [nc, nr] of getOffsetNeighbors(c, r)) {
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nIdx = nr * cols + nc;
      if (dist[nIdx] > d + 1) {
        dist[nIdx] = d + 1;
        queue.push(nIdx);
      }
    }
  }

  return dist;
}

/**
 * Single-pass neighbor-majority smoothing.
 * For each cell: if dominant neighbor terrain count > self count, switch.
 * Protect Ocean and Mountain (skip — preserve macro shape).
 */
function smoothMap(map: Uint8Array, rows: number, cols: number): void {
  const original = new Uint8Array(map);
  const counts = new Uint8Array(8); // up to 7 terrain types + slack
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const self = original[idx]!;
      // Protected terrains — preserve macro structure.
      if (self === Terrain.Ocean || self === Terrain.Mountain) continue;
      counts.fill(0);
      let neighborCount = 0;
      for (const [nc, nr] of getOffsetNeighbors(c, r)) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const t = original[nr * cols + nc]!;
        counts[t]!++;
        neighborCount++;
      }
      // Find dominant neighbor terrain.
      let bestTerrain = self;
      let bestCount = 0;
      for (let t = 0; t < 8; t++) {
        if (counts[t]! > bestCount) {
          bestCount = counts[t]!;
          bestTerrain = t as Terrain;
        }
      }
      // Switch only if dominant neighbor strongly outnumbers self (>= 4 of 6).
      if (bestTerrain !== self && bestCount >= Math.ceil(neighborCount * 0.65)) {
        // Don't smooth INTO Ocean (would shrink coastlines), unless self is rare speckle.
        if (bestTerrain === Terrain.Ocean && counts[self as number]! > 0) continue;
        map[idx] = bestTerrain;
      }
    }
  }
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
