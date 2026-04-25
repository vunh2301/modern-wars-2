/**
 * Country borders layer (z=2). SPEC Section 5.3 borders block.
 *
 * Phase 1a emits a compact segment list `{ segments: number[6 × N], segmentCount,
 * countryCount }` rather than the long-form `BorderTierFile` (vertices/indices/
 * segmentTable). Each segment record packs `[x0, y0, x1, y1, leftIdx, rightIdx]`
 * (rightIdx = -1 for coastlines). We render this as plain GL_LINES via a
 * single `Mesh` so the geometry is uploaded exactly once at boot.
 *
 * Color comes from a per-country LUT updated when `ownershipVersion` bumps.
 * Defer the full ribbon strip + per-vertex `(countryLeft, countryRight)`
 * shader to Phase 7 optimization — this MVP path satisfies the visual
 * acceptance for Phase 1b (borders visible, tint per-country, zero geometry
 * mutation per capture).
 */
import {
  Buffer,
  BufferUsage,
  Geometry,
  Mesh,
  Shader,
  Texture,
  TextureSource,
} from 'pixi.js';
import type { WorldData } from '../../data/types';
import { hexToRgba } from '../../style/palette';
import { useOwnership } from '../../state/store';
import { trackTexture, untrackTexture } from '../textureRegistry';

// Phase 1a `BorderTierFile` MVP shape (compact). Cast at boundary so the
// loader can stay strict on the spec shape; we accept either at runtime.
type CompactBorder = {
  segments: number[];
  segmentCount: number;
  countryCount: number;
};

const BORDER_VERT = `
in vec2 aPosition;
in float aCountryIdx;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform sampler2D uColorLut;
uniform float uCountryCount;
out vec3 vColor;
void main() {
  // Sample LUT at integer pixel index.
  float u = (aCountryIdx + 0.5) / max(uCountryCount, 1.0);
  vColor = texture(uColorLut, vec2(u, 0.5)).rgb;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;

const BORDER_FRAG = `
in vec3 vColor;
out vec4 finalColor;
void main() { finalColor = vec4(vColor, 1.0); }`;

export type BordersLayer = {
  mesh: Mesh;
  bind: () => () => void;
  destroy: () => void;
};

export function createBordersLayer(world: WorldData): BordersLayer {
  // Re-shape the loaded payload into the compact MVP form.
  const raw = world.borders.tier1 as unknown as CompactBorder;
  const segs = raw.segments ?? [];
  const segCount = raw.segmentCount ?? Math.floor(segs.length / 6);
  const countryCount = raw.countryCount ?? Object.keys(world.countries).length;

  // Two vertices per segment, each contributing (x, y, countryIdx).
  // For coastlines (right === -1) we just reuse the left index.
  const positions = new Float32Array(segCount * 4);
  const countryIdx = new Float32Array(segCount * 2);
  const indices = new Uint32Array(segCount * 2);
  for (let i = 0; i < segCount; i++) {
    const off = i * 6;
    const x0 = segs[off]!, y0 = segs[off + 1]!;
    const x1 = segs[off + 2]!, y1 = segs[off + 3]!;
    const li = segs[off + 4]!;
    const ri = segs[off + 5] ?? -1;
    const drawIdx = li >= 0 ? li : Math.max(ri, 0);
    positions[i * 4] = x0;
    positions[i * 4 + 1] = y0;
    positions[i * 4 + 2] = x1;
    positions[i * 4 + 3] = y1;
    countryIdx[i * 2] = drawIdx;
    countryIdx[i * 2 + 1] = drawIdx;
    indices[i * 2] = i * 2;
    indices[i * 2 + 1] = i * 2 + 1;
  }

  // Build LUT texture (1 × countryCount, RGBA).
  const lutPixels = new Uint8Array(countryCount * 4);
  const codeToIdx = new Map<string, number>();
  const sortedCodes = Object.keys(world.countries).sort();
  sortedCodes.forEach((c, i) => codeToIdx.set(c, i));
  for (const c of sortedCodes) {
    const meta = world.countries[c]!;
    const i = codeToIdx.get(c)!;
    const [r, g, b, a] = hexToRgba(meta.defaultColor);
    lutPixels[i * 4] = r;
    lutPixels[i * 4 + 1] = g;
    lutPixels[i * 4 + 2] = b;
    lutPixels[i * 4 + 3] = a;
  }
  const lutSource = new TextureSource({
    resource: lutPixels,
    width: countryCount,
    height: 1,
    format: 'rgba8unorm',
    autoGenerateMipmaps: false,
  });
  trackTexture(lutSource);
  const lutTexture = new Texture({ source: lutSource });

  const shader = Shader.from({
    gl: {
      vertex: BORDER_VERT,
      fragment: BORDER_FRAG,
    },
    resources: {
      uColorLut: lutTexture.source,
      uniforms: {
        uCountryCount: { value: countryCount, type: 'f32' },
      },
    },
  });

  const positionBuf = new Buffer({ data: positions, usage: BufferUsage.VERTEX });
  const idxBuf = new Buffer({ data: countryIdx, usage: BufferUsage.VERTEX });
  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: positionBuf, format: 'float32x2' },
      aCountryIdx: { buffer: idxBuf, format: 'float32' },
    },
    indexBuffer: indices,
    topology: 'line-list',
  });

  // Pixi v8's `Mesh` constructor type defaults to `<MeshGeometry, TextureShader>`.
  // We deliberately pass a plain `Geometry` + custom `Shader`, which Pixi
  // accepts at runtime; the generic constraint is overly tight in v8.6.6 typings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mesh: Mesh = new (Mesh as any)({ geometry, shader, texture: Texture.WHITE });
  mesh.label = 'borders';
  mesh.cullable = false; // borders span the whole world; cull off

  function refreshLut(): void {
    const { ownerOf } = useOwnership.getState();
    for (const code of sortedCodes) {
      const owner = ownerOf[code] ?? code;
      const ownerMeta = world.countries[owner];
      if (!ownerMeta) continue;
      const i = codeToIdx.get(code)!;
      const [r, g, b, a] = hexToRgba(ownerMeta.defaultColor);
      lutPixels[i * 4] = r;
      lutPixels[i * 4 + 1] = g;
      lutPixels[i * 4 + 2] = b;
      lutPixels[i * 4 + 3] = a;
    }
    lutSource.update();
  }

  function bind(): () => void {
    let lastVersion = -1;
    return useOwnership.subscribe((s) => {
      if (s.ownershipVersion === lastVersion) return;
      lastVersion = s.ownershipVersion;
      refreshLut();
    });
  }

  function destroy(): void {
    untrackTexture(lutSource);
    mesh.destroy({ children: true });
    lutSource.destroy();
  }

  return { mesh, bind, destroy };
}
