/**
 * Sandbox synthetic data — 64×64 hex grid với 3 random country regions ở giữa.
 *
 * Mục tiêu: test bed cho texture / shader experiments. Không cần CDN fetch,
 * không tier switching, không LOD logic. Render trực tiếp 1 mesh duy nhất.
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

const NEUTRAL_COLOR: readonly [number, number, number, number] = [40, 60, 80, 255]; // ocean dark blue

interface RegionSpec {
  centerCol: number;
  centerRow: number;
  radius: number;
  color: readonly [number, number, number, number];
}

/** Generate 64×64 hex grid với 3 country regions colored random in middle. */
export function generateSandboxData(rows = 64, cols = 64, seed = 1): SandboxBuffers {
  const sizeWorldPx = kmToWorldPx(TIER_KM);

  // Template: 6 vertices around hex center, flat-top orientation.
  const template = new Float32Array(12);
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    template[i * 2] = Math.cos(angle) * sizeWorldPx;
    template[i * 2 + 1] = Math.sin(angle) * sizeWorldPx;
  }

  const hexCount = rows * cols;
  const instances = new ArrayBuffer(hexCount * 12);
  const instView = new DataView(instances);

  const halfC = Math.floor(cols / 2);
  const halfR = Math.floor(rows / 2);
  const rng = mulberry32(seed);

  // 3 random country regions ở giữa map (small jitter quanh center).
  const regions: RegionSpec[] = [
    {
      centerCol: halfC + Math.floor((rng() - 0.5) * 8),
      centerRow: halfR + Math.floor((rng() - 0.5) * 8),
      radius: 8,
      color: [220, 80, 80, 255],   // red
    },
    {
      centerCol: halfC + Math.floor((rng() - 0.5) * 14),
      centerRow: halfR + Math.floor((rng() - 0.5) * 14),
      radius: 6,
      color: [80, 200, 100, 255],  // green
    },
    {
      centerCol: halfC + Math.floor((rng() - 0.5) * 14),
      centerRow: halfR + Math.floor((rng() - 0.5) * 14),
      radius: 6,
      color: [100, 100, 230, 255], // blue
    },
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const offset = idx * 12;

      // Axial coords centered → world px (flat-top hex layout).
      const q = c - halfC;
      const rAxial = r - halfR;
      const x = sizeWorldPx * 1.5 * q;
      const y = sizeWorldPx * Math.sqrt(3) * (rAxial + q / 2);

      instView.setFloat32(offset, x, true);
      instView.setFloat32(offset + 4, y, true);

      // Pick closest region within radius, else neutral.
      let color: readonly [number, number, number, number] = NEUTRAL_COLOR;
      let bestDist = Infinity;
      for (const region of regions) {
        const dq = c - region.centerCol;
        const dr = r - region.centerRow;
        const dist = Math.sqrt(dq * dq + dr * dr);
        if (dist < region.radius && dist < bestDist) {
          bestDist = dist;
          color = region.color;
        }
      }

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
