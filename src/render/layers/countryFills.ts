/**
 * Country fills layer (z=1). SPEC Section 5.3 + Section 4.6.
 *
 * One `Container` per country with N `Mesh` children (1 per disjoint
 * sub-polygon). Geometry uploaded once at boot — owner change only mutates
 * `container.tint` which cascades to children (Pixi >= 8.6.6, Section 5.3).
 *
 * Culling: each container is `cullable=true` with `cullArea` set to the
 * country bbox. SplitBBox handling registers two cull areas for antimeridian
 * crossers (RU/US/FJ/NZ/KI) by adding a duplicate display-clone container
 * with the eastern bbox while the primary container claims the western one.
 */
import {
  Container,
  Geometry,
  Mesh,
  Rectangle,
  Shader,
  Texture,
} from 'pixi.js';
import type { CountryMeta, WorldData } from '../../data/types';
import { hexToPixiTint, palette } from '../../style/palette';
import { useOwnership } from '../../state/store';
import { trackTexture } from '../textureRegistry';

/**
 * Trivial vertex/fragment pair so the Mesh constructor is satisfied. The
 * tint comes from `Container.tint` cascade — no per-vertex color required.
 */
const FILL_VERT = `
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;

const FILL_FRAG = `
uniform vec4 uColor;
out vec4 finalColor;
void main() { finalColor = uColor; }`;

let sharedShader: Shader | null = null;
function getShader(): Shader {
  if (sharedShader) return sharedShader;
  sharedShader = Shader.from({
    gl: { vertex: FILL_VERT, fragment: FILL_FRAG },
    resources: {
      uniforms: { uColor: { value: new Float32Array([1, 1, 1, 1]), type: 'vec4<f32>' } },
    },
  });
  return sharedShader;
}

type CountryEntry = {
  code: string;
  container: Container;
  /** Companion container for split-bbox crossers (east half); null otherwise. */
  splitMirror: Container | null;
};

export type CountryFillsLayer = {
  root: Container;
  /** Re-tint all countries from current store state (called once at boot). */
  retintAll: () => void;
  /** Subscribe to ownershipVersion bumps; returns unsubscribe. */
  bind: () => () => void;
  destroy: () => void;
};

function bboxToRect(bbox: CountryMeta['bbox'], half?: 'west' | 'east'): Rectangle {
  if (bbox.kind === 'single') {
    const [x0, y0] = bbox.min;
    const [x1, y1] = bbox.max;
    return new Rectangle(x0, y0, x1 - x0, y1 - y0);
  }
  const side = half === 'east' ? bbox.east : bbox.west;
  const [x0, y0] = side.min;
  const [x1, y1] = side.max;
  return new Rectangle(x0, y0, x1 - x0, y1 - y0);
}

export function createCountryFillsLayer(world: WorldData): CountryFillsLayer {
  const root = new Container();
  root.label = 'country-fills';

  const entries: Record<string, CountryEntry> = {};

  // Texture.WHITE is shared globally; track it so the VRAM estimator sees it.
  trackTexture(Texture.WHITE.source);

  for (const code of Object.keys(world.countries).sort()) {
    const meta = world.countries[code];
    if (!meta) continue;
    const tier1 = world.polygons.tier1[code];
    if (!tier1) continue;

    const container = new Container();
    container.label = `country-${code}`;
    container.tint = hexToPixiTint(meta.defaultColor);
    container.cullable = true;
    container.cullArea =
      meta.bbox.kind === 'single' ? bboxToRect(meta.bbox) : bboxToRect(meta.bbox, 'west');

    for (const sub of tier1.subMeshes) {
      // Phase 1a emits Float64-interleaved verts + Uint32 indices in plain arrays.
      const verts = new Float32Array(sub.vertices);
      const idxArr =
        tier1.indexType === 'uint32'
          ? new Uint32Array(sub.indices)
          : new Uint16Array(sub.indices);
      const geometry = new Geometry({
        attributes: { aPosition: { buffer: verts, format: 'float32x2' } },
        indexBuffer: idxArr,
      });
      const mesh = new Mesh({ geometry, shader: getShader(), texture: Texture.WHITE });
      mesh.cullable = false; // parent culls
      container.addChild(mesh);
    }
    root.addChild(container);

    let splitMirror: Container | null = null;
    if (meta.bbox.kind === 'split') {
      // Render geometry twice — culling decides which half is on screen.
      // Cheap because vertices are shared via Geometry references.
      splitMirror = new Container();
      splitMirror.label = `country-${code}-east`;
      splitMirror.tint = container.tint;
      splitMirror.cullable = true;
      splitMirror.cullArea = bboxToRect(meta.bbox, 'east');
      for (const child of container.children) {
        if (child instanceof Mesh) {
          const clone = new Mesh({ geometry: child.geometry, shader: child.shader, texture: child.texture });
          clone.cullable = false;
          splitMirror.addChild(clone);
        }
      }
      root.addChild(splitMirror);
    }

    entries[code] = { code, container, splitMirror };
  }

  const factionTints: Record<string, number> = {};
  function tintFor(ownerCode: string): number {
    const meta = world.countries[ownerCode];
    if (!meta) return 0xffffff;
    let t = factionTints[ownerCode];
    if (t == null) {
      t = hexToPixiTint(meta.defaultColor);
      factionTints[ownerCode] = t;
    }
    return t;
  }

  function retintAll(): void {
    const { ownerOf } = useOwnership.getState();
    for (const code of Object.keys(entries)) {
      const owner = ownerOf[code] ?? code;
      const t = tintFor(owner);
      const e = entries[code]!;
      e.container.tint = t;
      if (e.splitMirror) e.splitMirror.tint = t;
    }
  }

  function bind(): () => void {
    let lastVersion = -1;
    return useOwnership.subscribe((s) => {
      if (s.ownershipVersion === lastVersion) return;
      lastVersion = s.ownershipVersion;
      retintAll();
    });
  }

  function destroy(): void {
    root.destroy({ children: true });
  }

  return { root, retintAll, bind, destroy };
}

void palette;
