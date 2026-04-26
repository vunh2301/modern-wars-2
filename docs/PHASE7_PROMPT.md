# Phase 7: Pre-Baked Chunked Mesh Buffers

> Eliminate Pixi v8 `addParticle` ~1.7µs/hex wall identified in Phase 6.
> Move per-hex CPU iteration from runtime → bake-time. Runtime uploads
> ready-made GPU buffers directly to `Mesh`.
>
> **Repo**: vunh2301/modern-wars-2
> **Branch**: `phase-7-prebaked-mesh` (off `main` AFTER Phase 6 merge)
> **Owner agent**: Claude Code Sonnet 4.6 (writer) + Claude Opus 4.7 (reviewer)
> **Estimated effort**: 12-18h with self-correction loop

---

## Context — what Phase 6 left behind

Phase 6 delivered (committed on `phase-6-viewport-cull`):

✅ Chunked spatial culling (visible chunks ≤ 12)
✅ Pan storm FPS p95 = 130-141 fps (target 58)
✅ Antimeridian infinite wrap @ all tiers
✅ Coordinate contract (`src/geo/wrap.ts` + 7 helpers + 10 tests)
✅ `docs/COORDINATE_SYSTEM.md` (3 invariants locked for Phase 7+ gameplay)

❌ **3 metrics fail — all from same root cause:**

| Metric | Target | Actual | Root cause |
|---|---|---|---|
| tier-switch 25→10km | < 80 ms | 714 ms | `addParticle` × 1.25M hexes |
| chunk-build p95 | < 8 ms | 66 ms | `addParticle` × ~40K hexes/chunk |
| memory peak | < 250 MB | 1873 MB | ParticleContainer holds CPU instance data |

Iter 2 of Phase 6 tried `Uint32Array hash table` → 75× regression. Lesson:
**micro-opt inside `addParticle` is futile**. The wall is Pixi v8's
particle init internals. Need different runtime approach.

---

## Mission

**Replace runtime `addParticle` loop with pre-baked GPU buffer upload.**

Bake script (Node.js, run once at build time) outputs per-chunk binary
files containing exact `Float32Array` / `Uint32Array` ready to feed to
WebGL2 buffers via Pixi v8 `Mesh` + custom `Geometry`. Runtime fetches
chunk binary → decompresses → uploads to GPU → done. **Zero per-hex
CPU iteration at runtime.**

### Performance targets (hard gates)

| Metric | Phase 6 actual | Phase 7 target | Method |
|---|---|---|---|
| tier-switch 25→10km | 714 ms | **< 50 ms** | `performance.measure('tier-switch')` |
| tier-switch 50→25km | 211 ms | **< 30 ms** | same |
| chunk-build p95 | 66 ms | **< 5 ms** | per-chunk perf.measure |
| memory peak (60s pan storm 10km) | 1873 MB | **< 250 MB** | Performance Memory API |
| FPS p95 (pan + zoom + wrap) | 130 fps | **≥ 90 fps** | regression check, must not degrade |
| Initial 50km load (cold) | 480 ms | **< 600 ms** | acceptable degradation OK |
| Bundle size (chunks total) | N/A | **< 50 MB compressed** | repo size guard |

If ANY metric fails after 3 iterations → stop, report, suggest alternative.

---

## Architectural decisions (LOCKED)

### A. Bake-time outputs

Each tier produces **per-chunk binary files** instead of single tier file:

```
public/data/chunks/
├── 50km/
│   ├── manifest.json              # chunk_id → file + size + hex_count
│   ├── c-0-0.bin.gz               # binary buffer, gzipped
│   ├── c-0-1.bin.gz
│   ├── ...
│   └── c-7-3.bin.gz               # 32 chunks total (8 cols × 4 rows)
├── 25km/  (32 chunks)
├── 10km/  (32 chunks, larger files)
├── 5km/   (32 chunks)
├── 2km/   (32 chunks)
└── 1km/   (32 chunks, lazy-load only)
```

Old monolithic `tiles/world-{tier}.bin.gz` deprecated and removed
after migration verified.

### B. Per-chunk binary format

```
Header (16 bytes):
  [0..3]   magic "MWCK" (Modern Wars Chunk)
  [4..7]   version uint32 LE = 1
  [8..9]   tier_size_km uint16 LE
  [10..11] chunk_col uint8, chunk_row uint8
  [12..15] hex_count uint32 LE

Body:
  Hex vertex buffer (Float32Array):
    For each hex: 6 vertices × 2 floats (x, y in world px relative to chunk origin)
    Layout: hex0_v0_x, hex0_v0_y, hex0_v1_x, hex0_v1_y, ..., hex0_v5_y,
            hex1_v0_x, ...
    Size: hex_count × 12 floats × 4 bytes

  Hex index buffer (Uint32Array):
    For each hex: 4 triangles × 3 indices = 12 indices (fan triangulation)
    Size: hex_count × 12 × 4 bytes

  Hex tint buffer (Uint32Array):
    For each hex: 1 RGBA tint (one per hex, replicated per-vertex via
    instanced attribute OR repeated per vertex in vertex buffer — see C below)
    Size: hex_count × 4 bytes

  Border edge buffer (Float32Array):
    [x1, y1, x2, y2, ...] — same as Phase 6 computeBorderEdges output
    Size: edge_count × 16 bytes
    Prefix: edge_count uint32 LE (4 bytes before this section)

  Chunk metadata footer (32 bytes):
    bbox_min_x, bbox_min_y, bbox_max_x, bbox_max_y (4× float32)
    centroid_x, centroid_y (2× float32)
    8 bytes reserved
```

Gzip compression on full file (header + body) before write.

### C. Vertex format choice

**Choose ONE** in Phase 7.0 architecture review and lock:

**Option C1: Per-vertex tint (simpler, slightly larger)**
```
Per vertex: x, y, r, g, b, a (6 floats = 24 bytes)
hex_count × 6 verts × 24 bytes = 144 bytes/hex
Pros: standard mesh, no instanced attribs
Cons: file 30% larger
```

**Option C2: Instanced rendering (smaller, more complex)**
```
Shared hex template: 6 vertices (24 bytes total, sent once)
Per instance: x_offset, y_offset, tint (3 floats = 12 bytes)
hex_count × 12 bytes
Pros: minimum bandwidth
Cons: requires `gl.drawArraysInstanced` + custom shader
```

Em recommend **C1** for Phase 7 (simpler, ship faster). C2 is Phase 8
candidate if C1 doesn't hit memory target.

### D. Runtime path

```
viewport.on('moved') →
  spatialQueryChunks(viewportBbox, 3 wrap zones) →
  for each visible chunk:
    if (cached) → set visible
    else → loadChunk() → uploadToGPU() → addToScene()
  hide non-visible
```

`loadChunk(name, col, row)` flow:
```ts
1. fetch /data/chunks/{tier}/c-{col}-{row}.bin.gz
2. decompress via DecompressionStream('gzip')
3. parse header (16 bytes)
4. extract Float32Array vertex view (zero-copy via ArrayBuffer)
5. extract Uint32Array index view
6. extract Uint32Array tint view
7. create Pixi Geometry with these buffers (NO ITERATION):
   const geom = new Geometry({
     attributes: {
       aPosition: { buffer: vertexF32, format: 'float32x2' },
       aColor:    { buffer: tintU32,   format: 'uint8x4-norm' },
     },
     indexBuffer: indexU32,
   });
   const mesh = new Mesh({ geometry: geom, shader: hexShader });
8. add to chunk container, position at chunk.bbox origin
```

**ZERO per-hex JS iteration**. Buffer goes from disk → GPU as opaque
bytes.

### E. Custom shader

Minimal vertex + fragment shader (~30 lines GLSL):

```glsl
// vertex
attribute vec2 aPosition;
attribute vec4 aColor;
varying vec4 vColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vColor = aColor;
}

// fragment
varying vec4 vColor;
void main() { gl_FragColor = vColor; }
```

Pixi v8 Mesh API supports custom Shader — see Pixi v8 docs.

### F. Chunk lifecycle

| State | Trigger | Action |
|---|---|---|
| `not-loaded` | initial | nothing in memory |
| `fetching` | first time visible | `fetch()` in flight |
| `decoding` | bytes received | `DecompressionStream` → ArrayBuffer |
| `uploaded` | buffers parsed | Mesh in scene, `.visible = true` |
| `cached` | leaves viewport | Mesh stays in scene tree, `.visible = false` |
| `evicted` | LRU pressure (> 24 cached chunks) | `.destroy()` GPU buffers, back to `not-loaded` |

**LRU cap = 24 chunks** keeps memory bounded. Visible set ≤ 12, cached
set ≤ 24 → most pan returns hit cache instantly.

### G. Border rendering

Borders: keep current `Graphics` approach BUT render per-chunk (each
chunk's edges in own Graphics). Border buffer pre-baked into chunk
binary (Section B). Runtime: chunk Graphics builds in 1 pass via
`moveTo`/`lineTo` over pre-baked edge array — fast since edge count
per chunk small (< 5K @ 10km tier).

NO new mesh approach for borders in Phase 7. Keep risk surface small.

---

## Implementation phases

### Phase 7.0: Architecture review (MANDATORY before code)

Read these files via repo before designing:

- `src/render/hexLayer.ts` (current Phase 6 chunked impl)
- `src/render/chunkGrid.ts` (Phase 6 spatial index)
- `src/data/tiers.ts` (current loader to replace)
- `src/data/manifest.ts` (manifest schema to extend)
- `scripts/bake-hex-tiers.ts` (existing bake to extend)
- `src/geo/wrap.ts` (coordinate helpers — DO NOT modify)
- `docs/COORDINATE_SYSTEM.md` (contract — DO NOT violate)
- `docs/phase-6-retro.md` (lessons from previous phase)
- `docs/phase-6-iter-2.md` (why hash table approach failed)

Then write `docs/phase-7-architecture.md` (400-600 lines) covering:

1. Current Phase 6 pipeline diagram (ASCII)
2. Proposed Phase 7 pipeline (ASCII) — bake-time + runtime
3. Binary format full layout with byte offsets
4. Memory model:
   - GPU buffer ownership (Pixi Geometry vs raw WebGL?)
   - Buffer lifetime (chunk lifecycle states)
   - Worst-case memory math (24 cached × max chunk size)
5. Migration path Phase 6 → Phase 7:
   - Old `tiles/world-{tier}.bin.gz` deletion order
   - Old `loadTier()` API replacement
   - Chunked manifest schema
6. Edge cases:
   - Chunk on wrap seam (split across antimeridian)
   - Hex straddling chunk boundary (assigned which chunk?)
   - Tint LUT change (currently runtime, now bake-time?)
   - Border edges across chunks (already documented Phase 6)
7. Shader strategy: custom vs Pixi default Mesh shader
8. Vertex format decision (C1 vs C2 above) with rationale
9. Risks identified + mitigation
10. Rollback plan if Phase 7 fails: keep `phase-6-viewport-cull` merge as fallback

Self-review checklist (must verify before proceeding):
- [ ] Memory leaks: every `new Mesh/Geometry/Buffer` has destroy path?
- [ ] Race conditions: chunk loading async, viewport moves during fetch?
- [ ] LRU eviction: GPU buffer release verified, not just JS GC?
- [ ] Bundle size: total `chunks/**/*.bin.gz` < 50 MB?
- [ ] Border ownership unchanged from Phase 6?
- [ ] Coordinate contract preserved (no raw neighbor ops added)?

### Phase 7.1: Bake script extension (~3h)

Extend `scripts/bake-hex-tiers.ts`:

```ts
// New function
async function bakeChunks(
  tier: TierData,
  chunkGridDef: ChunkGridDef,  // 8x4 grid bounds
  outDir: string,
): Promise<ChunkManifest> {
  for (const chunk of chunkGridDef.chunks) {
    const hexes = filterHexesInChunk(tier.hexes, chunk);
    const edges = computeBorderEdges(hexes, ..., chunk);
    const buffer = encodeChunkBinary(hexes, edges, chunk);
    const compressed = await gzip(buffer);
    fs.writeFileSync(`${outDir}/${tier.name}/c-${chunk.col}-${chunk.row}.bin.gz`, compressed);
  }
  // Write per-tier manifest mapping chunk_id → file + metadata
  return manifest;
}
```

Deliverables:
- New CLI: `pnpm bake:chunks` (separate from `pnpm bake` for incremental dev)
- Outputs: `public/data/chunks/{tier}/c-*.bin.gz` + `manifest.json`
- Output validation: `bake:verify` checks every chunk loadable + parses to expected hex count
- Bundle size report: prints total compressed size per tier

### Phase 7.2: Loader rewrite (~2h)

New file `src/data/chunks.ts`:

```ts
export interface ChunkBuffers {
  vertices: Float32Array;
  indices: Uint32Array;
  tints: Uint32Array;
  borderEdges: Float32Array;
  bbox: Rectangle;
  hexCount: number;
}

export async function loadChunk(
  tierName: string,
  col: number,
  row: number,
): Promise<ChunkBuffers> {
  // fetch + DecompressionStream + DataView parse → return zero-copy views
}

export class ChunkCache {
  private lru: LRUMap<string, ChunkBuffers>;
  private maxSize = 24;
  // ... get / set / evict logic
}
```

Old `src/data/tiers.ts::loadTier()` deprecated. Remove after callers
migrated. New `loadTierManifest()` returns chunk grid metadata only,
not hex data.

### Phase 7.3: Mesh layer (~3h)

New file `src/render/meshHexLayer.ts` (REPLACES `hexLayer.ts`):

```ts
export interface MeshHexLayer {
  root: Container;
  setTier(tierName: string): Promise<void>;
  updateVisibility(viewportBbox: Rectangle): void;
  setBordersVisible(visible: boolean): void;
  destroy(): void;
}

export function createMeshHexLayer(app: Application): MeshHexLayer {
  // ... uses Pixi Mesh + Geometry + custom shader
  // ... lazy-loads chunks via ChunkCache
  // ... wrap-aware visibility (3 zones)
}
```

Old `hexLayer.ts` kept temporarily for A/B comparison via URL param
`?engine=particles` vs `?engine=mesh`. Remove `hexLayer.ts` after
Phase 7 verified.

### Phase 7.4: Custom shader (~1.5h)

New file `src/render/hexShader.ts`:

```ts
import { Shader, GlProgram } from 'pixi.js';

export const HEX_VERTEX_GLSL = `
  attribute vec2 aPosition;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  void main() {
    gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vColor = aColor;
  }
`;

export const HEX_FRAGMENT_GLSL = `
  varying vec4 vColor;
  void main() { gl_FragColor = vColor; }
`;

export function createHexShader(): Shader {
  // Pixi v8 Shader API
}
```

Test: standalone hello-world mesh with this shader renders 1 colored
hex correctly.

### Phase 7.5: Wire-up + benchmark (~2h)

Update `src/main.ts`:
- Replace `createHexLayer` import with `createMeshHexLayer`
- A/B switch via URL `?engine=mesh` (default) | `?engine=particles` (legacy)
- Update HUD to show engine + chunk cache stats

Re-run Phase 6 benchmark scenarios:
- Pan storm 30s @ 10km → FPS p95 must ≥ 90 (not 58, that was Phase 6 floor)
- Tier switch 25→10 → < 50 ms
- Chunk build p95 → < 5 ms
- Memory peak → < 250 MB

Output `bench-results/phase-7-final.json`.

### Phase 7.6: Self-correction loop (autonomous, max 3 iterations)

Same structure as Phase 6.6 — analyze fails, ONE specific hypothesis,
ONE specific fix, retry. Stop after iteration 3.

Iteration 1 likely candidates if memory still high:
- Reduce LRU cap from 24 → 16
- Switch C1 → C2 (instanced rendering)
- Pre-allocate single huge buffer, suballocate per chunk

Iteration 2/3: stop and ask human if first iteration didn't close gap
≥ 50%.

---

## Constraints (must respect)

1. **NO breaking changes to** `src/geo/wrap.ts`, `src/data/countries.ts`,
   `docs/COORDINATE_SYSTEM.md`. Phase 7 builds ON Phase 6 contract.

2. **NO new runtime dependencies**. Pixi v8 has Mesh + Geometry + Shader
   built-in.

3. **NO gameplay code**. Phase 6 NEGATIVE list still applies (no combat,
   corps, AI, cities, etc.).

4. **Bundle size hard cap 50 MB compressed total** for all chunks. If
   exceeded → escalate to human, don't ship.

5. **Coordinate contract MUST be respected**. Any new neighbor lookup
   imports from `wrap.ts`, no raw inline.

6. **A/B switch required** via `?engine=` param. Old particle path stays
   functional during Phase 7 to allow rollback.

7. **TypeScript strict mode**. No `any` except justified WebGL/Pixi
   internals with inline comment.

---

## Reviewer checklists

### Checklist A: Memory & lifecycle
- [ ] Every `new Mesh/Geometry/Buffer/Shader` has `.destroy()` path?
- [ ] LRU eviction calls `geom.destroy()` for GPU buffer release?
- [ ] No closure leaking ChunkBuffers reference past eviction?
- [ ] Tier switch: all uploaded chunks of old tier evicted?
- [ ] `ChunkCache.lru` cleared on tier switch?

### Checklist B: Race conditions
- [ ] Chunk load in flight when viewport moves out of range — abort fetch?
- [ ] Two `setTier` calls overlapping — first one's loads cancelled?
- [ ] LRU eviction during active fetch?
- [ ] Mesh added to scene while still uploading buffer (incomplete render)?

### Checklist C: Binary format correctness
- [ ] Header magic + version validated on load?
- [ ] Buffer offsets aligned to 4-byte boundary (DataView requirement)?
- [ ] hex_count matches body size exactly (no trailing bytes)?
- [ ] Wrap seam chunks tested (col=0 and col=7 with antimeridian hexes)?
- [ ] Chunk bbox metadata accurate (used for visibility query)?

### Checklist D: Shader correctness
- [ ] Custom shader compiles on iOS Safari (test on real device)?
- [ ] `uProjectionMatrix` + `uWorldTransformMatrix` set correctly per-frame?
- [ ] Color format `uint8x4-norm` matches GLSL `vec4`?
- [ ] No precision warnings on iOS GPU?

### Checklist E: Bundle size
- [ ] Total `public/data/chunks/**/*.bin.gz` < 50 MB?
- [ ] Per-chunk size reasonable (< 2 MB at 10km, < 8 MB at 1km)?
- [ ] Gzip ratio sane (> 50% reduction vs raw)?
- [ ] Manifest JSON < 100 KB?

### Checklist F: Backward compat
- [ ] `?engine=particles` still works (Phase 6 path intact)?
- [ ] `?engine=mesh` is default?
- [ ] `window.__mwSetZoom`, `__mwCenterOn`, `__mwViewport` unchanged?
- [ ] HUD shows current engine?

If any checklist item fails → block commit, fix, retry.

---

## Self-loop budget

| Iteration | Budget |
|---|---|
| Phase 7.0 architecture review + self-review | 2h |
| Phase 7.1 bake script | 3h |
| Phase 7.2 loader | 2h |
| Phase 7.3 mesh layer | 3h |
| Phase 7.4 shader | 1.5h |
| Phase 7.5 wire-up + benchmark | 2h |
| Phase 7.6 iteration 1 | 1.5h |
| Phase 7.6 iteration 2 | 1.5h |
| Phase 7.6 iteration 3 | 1.5h |
| **Total max** | **18h** |

Stop after iteration 3 regardless. Report state for human review.

---

## Output artifacts

```
docs/
├── phase-7-architecture.md       # 7.0 output, 400-600 lines
├── phase-7-iter-1.md              # if needed
├── phase-7-iter-2.md              # if needed
├── phase-7-iter-3.md              # if needed
└── phase-7-retro.md               # final retrospective

scripts/
└── bake-hex-tiers.ts             # extended với bakeChunks()

src/data/
├── chunks.ts                     # NEW — chunk loader + LRU cache
├── manifest.ts                   # extended với chunk manifest
└── tiers.ts                      # DEPRECATED, kept for ?engine=particles

src/render/
├── meshHexLayer.ts               # NEW (~400 lines)
├── hexShader.ts                  # NEW (~80 lines)
├── hexLayer.ts                   # KEPT for A/B fallback
├── chunkGrid.ts                  # unchanged from Phase 6
└── (lod.ts, viewport.ts, stage.ts, colors.ts unchanged)

public/data/chunks/
└── {tier}/c-*.bin.gz             # NEW baked output

bench-results/
├── phase-6-final.json            # Phase 6 baseline (already exists)
└── phase-7-final.json            # Phase 7 result
```

---

## Reference: why Phase 7 should work

Phase 6 evidence: `addParticle ~1.7µs/hex` × 1.25M hexes = 2125 ms theoretical
total. Chunked into 32 chunks: ~70ms per chunk build.

Phase 7 eliminates this entirely:

```
Phase 6 chunk build:
  for hex in chunk.hexes:           // ~40K iterations
    pc.addParticle({ x, y, scale, tint, ... })  // ~1.7µs each
  total: ~70ms

Phase 7 chunk build:
  fetch + decompress: ~10ms (network + worker)
  parse header (16 bytes): ~0.01ms
  create ArrayBuffer views (Float32Array.subarray): ~0.1ms
  new Geometry({ attributes, indexBuffer }): ~1ms
  new Mesh + add to container: ~0.5ms
  total: ~12ms — 5.8× faster
```

Memory: Phase 6 stores Particle objects in JS heap (CPU-side mirror of
GPU instance data). Phase 7 stores only ArrayBuffer views + GPU buffers.
GPU buffers don't count toward JS heap → memory drop expected ~80%.

Bundle size: ~25 MB / 6 tiers / 32 chunks = ~130 KB per chunk avg gzipped
at 10km tier, scales lower at coarser tiers. Well within 50 MB cap.

---

## Begin

Start with Phase 7.0 architecture review. Do not write code until 7.0
doc reviewed (self-reviewed if no human reviewer available).

When uncertain about scope or design — **stop and ask**, don't guess.

If a benchmark fails after iteration 3 — **stop and report**, don't
infinite loop.

Phase 6 IS merged to main when this Phase 7 starts. Branch off `main`,
not `phase-6-viewport-cull`.

Good luck.
