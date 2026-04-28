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
// 9 terrain types cho modern war RTS world map. RGB tuple + future gameplay.
// Phase 1 worldgen upgrade: + Hill (smooth mountain↔plain) + Swamp (wet lowland).
type RGBA = readonly [number, number, number, number];

export const enum Terrain {
  Ocean = 0,    // deep water, impassable land, naval only
  Coast = 1,    // shallow water, amphibious assault zone
  Plains = 2,   // open, fast move, no defense bonus
  Forest = 3,   // slow move, +25% defense, blocks LOS
  Mountain = 4, // very slow, +50% defense, naturally fortified
  Urban = 5,    // city blocks, +40% defense, controllable
  Desert = 6,   // arid plains, fast move, low defense, low moisture
  Hill = 7,     // elev band below mountain, +20% defense, transition biome
  Swamp = 8,    // wet lowland, slow move, +15% defense, near coast
}

// Indexed by Terrain enum value (0..8) for direct number lookup.
const TERRAIN_COLORS: ReadonlyArray<RGBA> = [
  [14, 33, 64, 255],    // 0 Ocean    #0e2140 deep blue
  [30, 69, 112, 255],   // 1 Coast    #1e4570 lighter blue
  [156, 138, 85, 255],  // 2 Plains   #9c8a55 khaki-green
  [46, 94, 44, 255],    // 3 Forest   #2e5e2c dark green
  [110, 94, 84, 255],   // 4 Mountain #6e5e54 gray-brown
  [74, 74, 74, 255],    // 5 Urban    #4a4a4a dark gray
  [196, 168, 120, 255], // 6 Desert   #c4a878 sandy yellow
  [138, 138, 74, 255],  // 7 Hill     #8a8a4a olive-brown
  [61, 82, 64, 255],    // 8 Swamp    #3d5240 dark moss green
];

// ─── Generator ────────────────────────────────────────────────────────────────

/** Generate hex grid với terrain noise. */
export function generateSandboxData(
  rows = 64,
  cols = 64,
  seed = 1,
  params: WorldgenParams = DEFAULT_WORLDGEN_PARAMS,
): SandboxBuffers {
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

  // Generate terrain map với params.
  const terrainMap = generateTerrainMap(rows, cols, seed, params);

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

// ─── Tunable params interface — cho live editing từ debug panel UI ────────────
export interface WorldgenParams {
  // Noise frequencies (calibrated cho 128 minDim grid).
  elevationFreq: number;
  elevationOctaves: number;
  moistureFreq: number;
  moistureOctaves: number;
  moistureBias: number;
  temperatureFreq: number;
  temperatureOctaves: number;
  // Field combination weights.
  radialFalloffWeight: number;
  elevNoiseWeight: number;
  elevFalloffPower: number;
  elevCurvePower: number;
  temperatureLatitudeWeight: number;
  temperatureNoiseWeight: number;
  temperatureElevPenalty: number;
  // Classification thresholds.
  seaLevel: number;
  coastBand: number;
  mountainLevel: number;
  hillBand: number;
  swampMoisture: number;
  swampElevBand: number;
  forestMoisture: number;
  desertMoisture: number;
  desertTemperature: number;
  urbanProbability: number;
  // Macro cohesion (Phase 1.5).
  smoothingPasses: number;
  oceanFillNeighbors: number;
  elevBlurPasses: number;
  moistureBlurPasses: number;
  minComponentSize: number;
}

export const DEFAULT_WORLDGEN_PARAMS: WorldgenParams = {
  elevationFreq: 1.8,
  elevationOctaves: 5,
  moistureFreq: 3,
  moistureOctaves: 4,
  moistureBias: 0,
  temperatureFreq: 3,
  temperatureOctaves: 2,
  radialFalloffWeight: 0.20,
  elevNoiseWeight: 0.80,
  elevFalloffPower: 1.5,
  elevCurvePower: 0.90,
  temperatureLatitudeWeight: 0.85,
  temperatureNoiseWeight: 0.15,
  temperatureElevPenalty: 0.4,
  seaLevel: 0.40,
  coastBand: 0.05,
  mountainLevel: 0.70,
  hillBand: 0.14,
  swampMoisture: 0.70,
  swampElevBand: 0.18,
  forestMoisture: 0.55,
  desertMoisture: 0.35,
  desertTemperature: 0.55,
  urbanProbability: 0.006,
  smoothingPasses: 5,
  oceanFillNeighbors: 4,
  elevBlurPasses: 3,
  moistureBlurPasses: 3,
  minComponentSize: 12,
};

// ─── Presets (multiple realistic configurations) ──────────────────────────────
export const WORLDGEN_PRESETS: Record<string, { name: string; description: string; params: Partial<WorldgenParams> }> = {
  balanced: {
    name: 'Balanced',
    description: 'Cân bằng đất/nước/rừng/núi mặc định',
    params: {},
  },
  dry: {
    name: 'Dry Continent',
    description: 'Lục địa khô — nhiều sa mạc, ít rừng',
    params: {
      seaLevel: 0.32,
      moistureBias: -0.20,
      desertMoisture: 0.42,
      forestMoisture: 0.65,
    },
  },
  wet: {
    name: 'Wet World',
    description: 'Thế giới ẩm — nhiều rừng, nhiều đầm lầy, ít sa mạc',
    params: {
      seaLevel: 0.45,
      moistureBias: +0.18,
      forestMoisture: 0.45,
      swampMoisture: 0.60,
      desertMoisture: 0.20,
    },
  },
  mountainous: {
    name: 'Mountainous',
    description: 'Nhiều núi cao — dãy núi rộng + nhiều đồi',
    params: {
      mountainLevel: 0.55,
      hillBand: 0.20,
      elevCurvePower: 0.75,
    },
  },
  archipelago: {
    name: 'Archipelago',
    description: 'Quần đảo — nhiều đảo nhỏ rời rạc',
    params: {
      seaLevel: 0.55,
      radialFalloffWeight: 0.10,
      minComponentSize: 4,
      elevBlurPasses: 1,
    },
  },
  pangaea: {
    name: 'Pangaea',
    description: 'Siêu lục địa — đất chiếm phần lớn map',
    params: {
      seaLevel: 0.30,
      radialFalloffWeight: 0.35,
      coastBand: 0.04,
    },
  },
  tropical: {
    name: 'Tropical',
    description: 'Vùng nhiệt đới — toàn cầu nóng, rừng dày, không sa mạc lạnh',
    params: {
      moistureBias: +0.10,
      desertTemperature: 0.75,
      forestMoisture: 0.50,
      temperatureLatitudeWeight: 0.50,
    },
  },
  arctic: {
    name: 'Arctic',
    description: 'Vùng cực lạnh — sa mạc rất hiếm, rừng chiếm ưu thế',
    params: {
      desertTemperature: 0.85,
      moistureBias: +0.05,
      temperatureLatitudeWeight: 1.0,
    },
  },
};

/**
 * Phase 1 worldgen — V2 reference (demo/index.html) ported.
 *
 * Pipeline:
 *   1. Compute fields per cell:
 *      - elevation = fbm(6 oct) * 0.7 + radialFalloff^2.4 * 0.3, then ^0.85
 *      - moisture  = fbm(4 oct) + bias
 *      - temperature = (1 - latitude) * 0.85 + fbm(3 oct) * 0.15 - elev penalty
 *   2. Classify per cell (priority order):
 *      - Ocean       elev < SEA_LEVEL
 *      - Coast       elev < SEA_LEVEL + COAST_BAND  (deterministic, no BFS)
 *      - Swamp       moist > 0.68 + low elev
 *      - Mountain    elev > MOUNTAIN_LEVEL
 *      - Hill        elev > MOUNTAIN_LEVEL - HILL_BAND
 *      - Desert      moist < 0.38 + temp > 0.50  (block polar deserts)
 *      - Forest      moist > 0.55
 *      - Plains      default
 *   3. Smoothing 3 passes (neighbor-majority, Ocean-fill protection cho Mountain).
 *   4. Urban sparse overlay trên Plains/Coast (rare).
 *
 * Coast as elev band (no BFS) = simpler + deterministic per V2 reference.
 */
function generateTerrainMap(rows: number, cols: number, seed: number, params: WorldgenParams): Uint8Array {
  const map = new Uint8Array(rows * cols);
  const total = rows * cols;

  // Independent noise generators — different seed multipliers cho decorrelation.
  const elevNoise = makeValueNoise(seed * 73 + 1);
  const moistureNoise = makeValueNoise(seed * 1531 + 17);
  const tempNoise = makeValueNoise(seed * 2789 + 11);

  const elevation = new Float32Array(total);
  const moisture = new Float32Array(total);
  const temperature = new Float32Array(total);

  // Pass 1: compute fields per cell using V2 demo formula.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const fx = c / cols;
      const fy = r / rows;

      // Radial falloff cho continent shape.
      const ndx = (fx - 0.5) * 2;
      const ndy = (fy - 0.5) * 2;
      const dist = Math.sqrt(ndx * ndx + ndy * ndy);
      const radial = Math.max(0, 1 - Math.pow(dist, params.elevFalloffPower));

      // Elevation: fbm * weight + radial * weight, ^curve.
      let elev = octaveNoise(elevNoise, fx, fy, params.elevationOctaves, params.elevationFreq);
      elev = elev * params.elevNoiseWeight + radial * params.radialFalloffWeight;
      elev = Math.pow(Math.max(0, Math.min(1, elev)), params.elevCurvePower);
      elevation[idx] = elev;

      // Moisture: fbm + bias.
      let moist = octaveNoise(moistureNoise, fx, fy, params.moistureOctaves, params.moistureFreq);
      moist = Math.max(0, Math.min(1, moist + params.moistureBias));
      moisture[idx] = moist;

      // Temperature: latitude-based + small noise + elev penalty.
      const lat = Math.abs(fy - 0.5) * 2;
      const tn = octaveNoise(tempNoise, fx, fy, params.temperatureOctaves, params.temperatureFreq);
      let temp = (1 - lat) * params.temperatureLatitudeWeight + tn * params.temperatureNoiseWeight;
      temp -= Math.max(0, elev - params.seaLevel) * params.temperatureElevPenalty;
      temperature[idx] = Math.max(0, Math.min(1, temp));
    }
  }

  // Pass 1.5: blur elevation + moisture fields BEFORE classification.
  for (let pass = 0; pass < params.elevBlurPasses; pass++) {
    boxBlur(elevation, rows, cols);
  }
  for (let pass = 0; pass < params.moistureBlurPasses; pass++) {
    boxBlur(moisture, rows, cols);
  }

  // Pass 2: classify per cell theo priority order.
  for (let i = 0; i < total; i++) {
    const elev = elevation[i]!;
    const moist = moisture[i]!;
    const temp = temperature[i]!;

    if (elev < params.seaLevel) {
      map[i] = Terrain.Ocean;
    } else if (elev < params.seaLevel + params.coastBand) {
      map[i] = Terrain.Coast;
    } else if (moist > params.swampMoisture && elev < params.seaLevel + params.swampElevBand) {
      map[i] = Terrain.Swamp;
    } else if (elev > params.mountainLevel) {
      map[i] = Terrain.Mountain;
    } else if (elev > params.mountainLevel - params.hillBand) {
      map[i] = Terrain.Hill;
    } else if (moist < params.desertMoisture && temp > params.desertTemperature) {
      map[i] = Terrain.Desert;
    } else if (moist > params.forestMoisture) {
      map[i] = Terrain.Forest;
    } else {
      map[i] = Terrain.Plains;
    }
  }

  // Pass 3: smoothing — neighbor-majority để remove 1-cell speckles.
  for (let pass = 0; pass < params.smoothingPasses; pass++) {
    smoothMap(map, rows, cols, params.oceanFillNeighbors);
  }

  // Pass 3.5: flood-fill component cleanup.
  mergeSmallComponents(map, rows, cols, params.minComponentSize);

  // Pass 4: Urban sparse overlay trên Plains/Coast/Hill.
  const urbanRng = mulberry32(seed * 2027 + 31);
  for (let i = 0; i < total; i++) {
    const t = map[i];
    if ((t === Terrain.Plains || t === Terrain.Coast || t === Terrain.Hill) && urbanRng() < params.urbanProbability) {
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

/**
 * Single-pass neighbor-majority smoothing.
 *
 * Logic:
 *   - Ocean cell với ≥ OCEAN_FILL_NEIGHBORS land neighbors (5 of 6) → fill with majority
 *     land terrain (closes lakes inside continents, kills ocean speckle in landmass)
 *   - Mountain protected (preserve chain structure)
 *   - Other land cell: switch to dominant neighbor if outnumbered ≥ 65%
 *   - Block conversion INTO Ocean unless self has zero same-terrain neighbors (peninsula erosion)
 */
function smoothMap(map: Uint8Array, rows: number, cols: number, oceanFillNeighbors: number): void {
  const original = new Uint8Array(map);
  const counts = new Uint8Array(8);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const self = original[idx]!;
      if (self === Terrain.Mountain) continue; // chains protected

      counts.fill(0);
      let neighborCount = 0;
      let landNeighborCount = 0;
      for (const [nc, nr] of getOffsetNeighbors(c, r)) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const t = original[nr * cols + nc]!;
        counts[t]!++;
        neighborCount++;
        if (t !== Terrain.Ocean) landNeighborCount++;
      }

      // Special case: Ocean cell surrounded by land → fill (kill ocean speckle inside continent).
      if (self === Terrain.Ocean) {
        if (landNeighborCount >= oceanFillNeighbors) {
          // Pick most common LAND neighbor terrain.
          let bestLand: Terrain = Terrain.Plains;
          let bestCount = 0;
          for (let t = 0; t < 8; t++) {
            if (t === Terrain.Ocean) continue;
            if (counts[t]! > bestCount) {
              bestCount = counts[t]!;
              bestLand = t as Terrain;
            }
          }
          map[idx] = bestLand;
        }
        continue;
      }

      // Standard land smoothing: switch to dominant neighbor if outnumbered.
      let bestTerrain = self;
      let bestCount = 0;
      for (let t = 0; t < 8; t++) {
        if (counts[t]! > bestCount) {
          bestCount = counts[t]!;
          bestTerrain = t as Terrain;
        }
      }
      if (bestTerrain !== self && bestCount >= Math.ceil(neighborCount * 0.65)) {
        // Block conversion to Ocean unless self has zero same-terrain neighbors (true peninsula).
        if (bestTerrain === Terrain.Ocean && counts[self as number]! > 0) continue;
        map[idx] = bestTerrain;
      }
    }
  }
}

// ─── Phase 1.5 macro region helpers ───────────────────────────────────────────

/** Box blur Float32Array field in-place. 4-direction Manhattan (cheap, sufficient). */
function boxBlur(field: Float32Array, rows: number, cols: number): void {
  const original = new Float32Array(field);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      let sum = original[idx]!;
      let count = 1;
      if (r > 0)        { sum += original[idx - cols]!; count++; }
      if (r < rows - 1) { sum += original[idx + cols]!; count++; }
      if (c > 0)        { sum += original[idx - 1]!;    count++; }
      if (c < cols - 1) { sum += original[idx + 1]!;    count++; }
      field[idx] = sum / count;
    }
  }
}

/**
 * Flood-fill component cleanup — merge small connected regions into dominant
 * neighbor terrain. Kills speckle that survives smoothing.
 *
 * Algorithm:
 *   1. Visit each unvisited cell; flood-fill same-terrain connected component.
 *   2. If component.size < minSize: count border-neighbor terrain frequencies,
 *      replace all component cells với dominant neighbor terrain.
 *   3. Otherwise: leave intact (large region, preserve macro).
 *
 * Skip protection: Ocean components không merge (ocean speckle in continent
 * already handled by Ocean-fill smoothing). Mountain components > 1 preserved.
 */
function mergeSmallComponents(
  map: Uint8Array,
  rows: number,
  cols: number,
  minSize: number,
): void {
  const total = rows * cols;
  const visited = new Uint8Array(total);
  const stack: number[] = [];
  const component: number[] = [];
  const counts = new Uint8Array(9); // 9 terrain types

  for (let start = 0; start < total; start++) {
    if (visited[start]) continue;
    const terrain = map[start]!;

    // Flood-fill collect connected component.
    component.length = 0;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      component.push(idx);
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      for (const [nc, nr] of getOffsetNeighbors(c, r)) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nIdx = nr * cols + nc;
        if (!visited[nIdx] && map[nIdx] === terrain) {
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }

    // Skip large components (preserve macro shape).
    if (component.length >= minSize) continue;
    // Skip Ocean cleanup (handled by smoothing's Ocean-fill).
    if (terrain === Terrain.Ocean) continue;

    // Count border-neighbor terrains.
    counts.fill(0);
    for (const cellIdx of component) {
      const r = (cellIdx / cols) | 0;
      const c = cellIdx - r * cols;
      for (const [nc, nr] of getOffsetNeighbors(c, r)) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const t = map[nr * cols + nc]!;
        if (t !== terrain) counts[t]!++;
      }
    }

    // Find dominant non-self neighbor terrain.
    let bestTerrain: Terrain = terrain;
    let bestCount = 0;
    for (let t = 0; t < 9; t++) {
      if (counts[t]! > bestCount) {
        bestCount = counts[t]!;
        bestTerrain = t as Terrain;
      }
    }
    if (bestCount === 0) continue; // isolated (shouldn't happen on bounded map)

    // Replace component cells với dominant neighbor.
    for (const cellIdx of component) {
      map[cellIdx] = bestTerrain;
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
