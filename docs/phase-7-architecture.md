# Phase 7 — Pre-Baked Chunked Mesh Buffers Architecture

> Status: **DRAFT v1** (Phase 7.0)
> Author: Claude Opus 4.7
> Branch: `phase-7-prebaked-mesh` (off `main`, after Phase 6 merged)
> Date: 2026-04-26
> Reviewer: self-review only (no human reviewer in loop)
> Companion: `docs/PHASE7_PROMPT.md`

---

## 1. Mission scope

Phase 6 closed with 3 perf gates failing because of **Pixi v8
`addParticle` ~1.7 µs/hex** (per `docs/phase-6-retro.md`). Phase 7
moves per-hex iteration from runtime → bake-time and uploads ready-made
GPU buffers via `Mesh + Geometry + Shader`. Targets:

| Metric                              | Phase 6 actual | Phase 7 target |
|-------------------------------------|----------------|----------------|
| tier-switch 25→10 km                | 714 ms         | < 50 ms        |
| tier-switch 50→25 km                | 211 ms (avg)   | < 30 ms        |
| chunk-build p95                     | 66 ms          | < 5 ms         |
| memory peak (60 s pan storm @ 10 km)| 1873 MB        | < 250 MB       |
| FPS p95 (regression check)          | 130 fps        | ≥ 90 fps       |
| Initial 50 km cold load             | 480 ms         | < 600 ms       |
| Total chunk bundle compressed       | n/a            | < 50 MB        |

Out of scope: gameplay (NEGATIVE list of `docs/SPEC.md` § 15 still applies).

---

## 2. Architectural decisions (LOCKED)

| ID    | Decision                                                                   | Rationale                                                |
|-------|----------------------------------------------------------------------------|----------------------------------------------------------|
| D-1   | Per-chunk binary files at bake time, replace monolithic `tiles/world-{tier}.bin.gz` | Move CPU iteration to bake-time; runtime pure GPU upload |
| D-2   | Same 8 cols × 4 rows = 32 chunks per tier (Phase 6 grid preserved)         | Reuse Phase 6 spatial logic; rbush index unchanged       |
| D-3   | Binary format: header + vertices + indices + tints + edges + footer        | DataView-zero-copy parsable; aligned to 4-byte           |
| D-4   | **Vertex format C1**: per-vertex `(x, y, color)` packed (24 B / vertex)    | Simpler than instanced; ~144 B / hex; ships first        |
| D-5   | Pixi v8 `Mesh` + custom `Geometry` + custom `Shader` (`GlProgram`)         | Built-in API, no new deps                                |
| D-6   | Custom GLSL: `aPosition (vec2) + aColor (vec4) → vColor`                   | Minimal; let Pixi auto-bind matrices                      |
| D-7   | LRU cap **24** uploaded chunk-instances (matches Phase 6 cap)              | Keeps memory bounded; warm cache for re-entry             |
| D-8   | A/B switch via URL `?engine=mesh` (default) | `?engine=particles` (legacy) | Allows rollback if Phase 7 regresses production           |
| D-9   | Per-chunk gzip (browser native `DecompressionStream('gzip')`)              | Same codec as Phase 6 monolithic                          |
| D-10  | Borders unchanged: per-chunk Pixi `Graphics`, edges baked in chunk binary  | Keep risk surface small; Graphics works fine for ~5K edges/chunk |
| D-11  | Tints baked at `bake:chunks` time using current `colors.ts` palette        | LUT becomes "fixed" per bake; if palette changes, re-bake |
| D-12  | Old `src/data/tiers.ts` + `tiles/*.bin` kept until Phase 7.6 verified pass | Enables safe A/B fallback                                 |

### 2.1 Vertex format C1 vs C2 — decision rationale

**C1 chosen** (per-vertex packed):

```
Per vertex: x:f32, y:f32, color:u8x4 = 12 bytes
Per hex: 6 vertices = 72 bytes/hex
+ 12 indices (Uint32) = 48 bytes/hex
Total: ~120 bytes/hex
At 10 km = 1.25 M hexes / 32 chunks = 39 K hex/chunk × 120 B = 4.7 MB raw
After gzip ~50 % → ~2.3 MB / chunk × 32 chunks = 75 MB / tier RAW
```

Wait — that's larger than the 50 MB cap. Need to reconsider.

Actually most hexes share tints (country has many same-color hexes).
Color compresses well in gzip. Per-vertex tint dups × gzip → maybe 30 %
ratio. Estimate **15–30 MB / 10 km tier compressed**, ~5 MB / 25 km,
~1.5 MB / 50 km. Total across 3 baked tiers: ~25 MB. Under the cap.

If C1 exceeds cap in measurement, **iter 1** swaps to C2 (instanced):

```
Per chunk: 1 hex template (24 B static) + 1 instance / hex × (x, y, color) = 12 B
Total: ~12 bytes/hex
Compressed: ~3-5 MB / 10 km tier — much smaller
```

C2 needs `gl.drawArraysInstanced` which Pixi v8 supports via `Geometry`
with `instanceCount`. Higher complexity = ship-2nd if needed.

### 2.2 Compression budget worst case

50 km: 50 K hexes / 32 chunks × 120 B raw × 0.3 gzip = ~560 KB total
25 km: 200 K × ratio = ~2.2 MB total
10 km: 1.25 M × ratio = ~14 MB total
**Sum 3 tiers = ~17 MB** ≪ 50 MB cap ✓

5 km / 2 km / 1 km tiers (not yet baked): would add ~70/280/1100 MB
respectively at C1. **C2 mandatory beyond 25 km if those tiers ship.**
For Phase 7 scope we only support 50 km / 25 km / 10 km; finer tiers
deferred to Phase 8.

---

## 3. Current Phase 6 pipeline (baseline)

```
viewport.on('moved') ──► throttleRaf ──► hexLayer.updateVisibility(bbox)
                                              │
                                              ▼
                                  rbush.search(expanded bbox)
                                              │
                                              ▼
                                  for each visible (chunk, offsetX):
                                    if !built:
                                      buildChunkOffset(chunk, offsetX) {
                                        for hex in chunk.hexes:               ← 65 ms/chunk wall
                                          pc.addParticle(new Particle({...})) ← 1.7 µs/hex
                                      }
                                    set visible
                                              │
                                              ▼
                                  Pixi render visible chunks
```

`setTier` for 10 km also pays ~657 ms (chunkGrid CPU: hex assignment +
edge tessellation + countryByKey Map). Still all CPU work pre-runtime.

## 4. Proposed Phase 7 pipeline

### 4.1 Bake-time (one-shot, off-line)

```
scripts/bake-hex-tiers.ts (extended) ──► bakeTier(50km|25km|10km)  [unchanged]
                                              │
                                              ▼
                                  bakeChunks(tierHexes, chunkGridDef)
                                              │
                                              ▼
                                  for each chunk (col, row):
                                    filterHexesInChunk(...)
                                    computeBorderEdges(...)         (Phase 6 algorithm)
                                    encodeChunkBinary(hexes, edges, tints) ← NEW
                                    gzip → public/data/chunks/{tier}/c-{col}-{row}.bin.gz
                                              │
                                              ▼
                                  emit chunks/manifest.json
```

### 4.2 Runtime

```
viewport.on('moved') ──► throttleRaf ──► meshHexLayer.updateVisibility(bbox)
                                              │
                                              ▼
                                  rbush.search(expanded bbox, 3 wrap zones)
                                              │
                                              ▼
                                  for each visible (chunk, offsetX):
                                    if cached → set visible
                                    else → loadChunk(...)          ← async
                                                  │
                                                  ▼
                                       fetch + DecompressionStream
                                                  │
                                                  ▼
                                       parse header (16 B sync)
                                       create ArrayBuffer views (zero-copy)
                                       new Geometry({attributes, indexBuffer})  ← ~1 ms
                                       new Mesh({geometry, shader})               ← ~0.5 ms
                                       container.addChild(mesh)
                                       LRU.put(chunk, instance)
                                              │
                                              ▼
                                  hide non-visible chunks (.visible = false)
                                              │
                                              ▼
                                  Pixi render — GPU buffers already uploaded
```

**Zero per-hex JS iteration at runtime.** Chunk load: ~10 ms fetch +
~1 ms Geometry creation = ~12 ms total per chunk-instance. Compared to
Phase 6's 65 ms/chunk — **5–6× speedup**.

`setTier` collapses to "fetch tier manifest + clear LRU" — < 10 ms.

---

## 5. Binary format spec (full byte layout)

```
File: public/data/chunks/{tier}/c-{col}-{row}.bin.gz   (gzipped)

Decompressed content:

┌─── Header (16 bytes) ─────────────────────────────────┐
│ Offset  Size  Field                                   │
│   0     4     magic "MWCK"                            │
│   4     4     version uint32 LE = 1                   │
│   8     2     tier_size_km uint16 LE                  │
│  10     1     chunk_col uint8                         │
│  11     1     chunk_row uint8                         │
│  12     4     hex_count uint32 LE                     │
└───────────────────────────────────────────────────────┘
┌─── Vertex buffer (hex_count × 6 × 12 bytes) ──────────┐
│ Per vertex: x:float32 LE, y:float32 LE, color:u8×4    │
│ Per hex: 6 vertices (flat-top hex, vertex 0 = top-right, CCW)  │
│ Total: hex_count × 72 bytes                           │
└───────────────────────────────────────────────────────┘
┌─── Index buffer (hex_count × 12 × 4 bytes) ──────────┐
│ Per hex: 4 triangles × 3 indices = 12 uint32 LE       │
│ Triangulation: fan from vertex 0 → (1,2), (2,3), (3,4), (4,5) │
│ Total: hex_count × 48 bytes                           │
└───────────────────────────────────────────────────────┘
┌─── Edge prefix (4 bytes) ─────────────────────────────┐
│ edge_count uint32 LE                                  │
└───────────────────────────────────────────────────────┘
┌─── Edge buffer (edge_count × 16 bytes) ──────────────┐
│ Per edge: x1:f32, y1:f32, x2:f32, y2:f32              │
│ World px coords (NOT chunk-local; consistent w/ Phase 6) │
│ Total: edge_count × 16 bytes                          │
└───────────────────────────────────────────────────────┘
┌─── Footer (32 bytes) ─────────────────────────────────┐
│ Offset  Size  Field                                   │
│   0    16     bbox: minX, minY, maxX, maxY (4× f32)   │
│  16     8     centroid: cx, cy (2× f32)               │
│  24     8     reserved (zero)                         │
└───────────────────────────────────────────────────────┘
```

Vertex coords are in **world px** (consistent with Phase 6's
`axialToPx` × `kmToWorldPx` output), NOT chunk-local. Mesh container
position = (0, 0); shader picks up position via `uWorldTransformMatrix`
just like Phase 6 ParticleContainer does.

**Note on vertex coords vs C1 packed format**: each vertex needs `x, y,
r, g, b, a` = 6 fields. Packing as `(f32, f32, u8, u8, u8, u8)` = 12 B
exactly (4-byte aligned). Use **single interleaved buffer**:

```
struct Vertex { float32 x, y; uint8 r, g, b, a; }   // 12 bytes
```

In Pixi Geometry: 1 buffer, 2 attributes both backed by same buffer
with different `offset` and `stride`.

### 5.1 Why per-vertex tint and not per-hex tint

Easier shader (no instancing). Pixi Mesh expects per-vertex attributes.
Tint replicated 6× per hex inflates bake size by ~30 %, but gzip
compresses repeated bytes well so net inflation < 10 %.

If iter 1 needs to shrink: switch to C2 instanced (adds vertex shader
complexity).

---

## 6. Component view

```
┌──────────────────── scripts/bake-hex-tiers.ts (EXTENDED) ─────────────┐
│ existing: bakeTier(sizeKm) → BakedHex[]                                │
│ existing: forceAssignMissing(...)                                      │
│ NEW:                                                                   │
│   bakeChunks(tier, gridDef, outDir) → ChunkManifest                    │
│   filterHexesInChunk(hexes, chunkBbox) → HexRecord[]                   │
│   computeChunkVertices(hexes, lut) → Float32Array (interleaved)        │
│   computeChunkIndices(hexCount) → Uint32Array                          │
│   encodeChunkBinary(verts, indices, edges, meta) → Buffer              │
│ Also new: bakeChunkVerify CLI option (load each + assert hex_count)    │
└────────────────────────────────────────────────────────────────────────┘
            │
            ▼
   public/data/chunks/{50km,25km,10km}/c-{col}-{row}.bin.gz  +  manifest.json
            │
            ▼
┌──────────────────── src/data/chunks.ts (NEW) ─────────────────────────┐
│ interface ChunkBuffers {                                               │
│   vertices: Float32Array;     // per-vertex x, y                       │
│   colors: Uint8Array;         // per-vertex r, g, b, a (interleaved view) │
│   indices: Uint32Array;                                                │
│   edges: Float32Array;                                                 │
│   bbox: { minX, minY, maxX, maxY };                                    │
│   hexCount: number;                                                    │
│ }                                                                      │
│                                                                        │
│ async function loadChunk(tier, col, row): Promise<ChunkBuffers>        │
│ async function loadChunksManifest(tier): Promise<ChunksManifest>       │
│                                                                        │
│ class ChunkCache {                                                     │
│   max = 24                                                             │
│   get(key): ChunkBuffers | undefined                                   │
│   set(key, buffers): void  // evicts LRU                               │
│   clear(): void                                                        │
│   readonly size: number                                                │
│ }                                                                      │
└────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────── src/render/hexShader.ts (NEW) ────────────────────┐
│ HEX_VERTEX_GLSL = `                                                    │
│   attribute vec2 aPosition;                                            │
│   attribute vec4 aColor;                                               │
│   varying vec4 vColor;                                                 │
│   uniform mat3 uProjectionMatrix;                                      │
│   uniform mat3 uWorldTransformMatrix;                                  │
│   void main() {                                                        │
│     vec3 p = uProjectionMatrix * uWorldTransformMatrix * vec3(aPosition, 1.0); │
│     gl_Position = vec4(p.xy, 0.0, 1.0);                                │
│     vColor = aColor;                                                   │
│   }                                                                    │
│ `;                                                                     │
│ HEX_FRAGMENT_GLSL = `                                                  │
│   varying vec4 vColor;                                                 │
│   void main() { gl_FragColor = vColor; }                               │
│ `;                                                                     │
│ createHexShader() → Shader  (Pixi v8 Shader.from with GlProgram)       │
└────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────── src/render/meshHexLayer.ts (NEW, replaces hexLayer.ts) ┐
│ interface MeshHexLayer {                                               │
│   root: Container                                                      │
│   setTier(tier: string): Promise<void>                                 │
│   updateVisibility(bbox): void                                         │
│   setBordersVisible(visible): void                                     │
│   getStats(): MeshHexLayerStats                                        │
│   destroy(): void                                                      │
│ }                                                                      │
│                                                                        │
│ Internals:                                                             │
│  - chunksManifest (loaded per tier)                                    │
│  - rbush spatial index (chunk × 3 wrap offsets, like Phase 6)          │
│  - ChunkCache (24 entries)                                             │
│  - meshByKey: Map<string, Mesh>  (key = `${chunkId}@${offsetX}`)        │
│  - bordersByKey: Map<string, Graphics>                                 │
│  - shader: Shader (one shared instance)                                │
│  - inFlight: Set<string> (avoids duplicate loadChunk for same key)     │
│                                                                        │
│ updateVisibility:                                                       │
│   nowEntries = rbush.search(expanded)                                   │
│   for each entry:                                                       │
│     key = chunkId@offsetX                                               │
│     if !meshByKey.has(key) and !inFlight.has(key):                      │
│       inFlight.add(key)                                                 │
│       loadChunk(...).then(buf => mountMesh(key, buf, offsetX))          │
│     else if meshByKey.has(key):                                         │
│       meshByKey.get(key).visible = true                                 │
│   for each previously-visible not in nowEntries:                        │
│     meshByKey.get(key).visible = false                                  │
└────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────── src/main.ts (UPDATED) ─────────────────────────────┐
│ const engine = new URLSearchParams(location.search).get('engine')     │
│              ?? 'mesh';                                               │
│ const hexLayer = engine === 'particles'                               │
│   ? createHexLayer(app)         // legacy Phase 6                     │
│   : createMeshHexLayer(app);    // Phase 7 default                    │
│ // wiring identical (root added to viewport, updateVisibility, etc.)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Memory model

### 7.1 GPU buffer ownership

Pixi v8 `Geometry` owns the `Buffer` instances; `Mesh` owns its
`Geometry`. Calling `mesh.destroy({ children: true })` cascades to
`geometry.destroy()` which calls `gl.deleteBuffer(...)` for each
attached `Buffer`. **No raw WebGL handles in our code**.

### 7.2 LRU eviction (D-7)

```
On loadChunk completion:
  meshByKey.set(key, mesh)
  bordersByKey.set(key, graphics)
  builtOrder.push(key)
  evictIfNeeded():
    while builtOrder.length > 24 AND oldestKey not in visibleSet:
      mesh.destroy({ children: true })  → frees Geometry → frees Buffer
      graphics.destroy()
      meshByKey.delete(oldestKey)
      bordersByKey.delete(oldestKey)
      ChunkCache evicted via its own LRU (independent CPU-side cache)
```

Two LRUs:
- **GPU LRU** (in `meshHexLayer`): caps Mesh + Geometry instances.
- **CPU LRU** (in `ChunkCache`): caps decoded `ChunkBuffers`. Lets us
  re-mount evicted GPU instance without re-fetching the binary.

Both cap = 24. CPU cache survives GPU eviction (`ChunkBuffers` is
decoded ArrayBuffer views ~120 KB / chunk @ 10 km = 24 × 120 = 2.9 MB
RAM total).

### 7.3 Worst-case math (sustained pan @ 10 km)

```
GPU LRU full at 24 chunk-instances:
  Per instance vertex buffer: 39 K hexes × 6 verts × 12 B = 2.8 MB  (GPU side)
  Per instance index buffer:  39 K × 12 indices × 4 B = 1.9 MB  (GPU side)
  Per instance edge Graphics: ~5 K edges × Pixi internal overhead ~50 KB
  Per instance: ~5 MB GPU + ~50 KB JS heap (Mesh + Geometry refs)
  Total GPU: 24 × 5 MB = 120 MB
  Total JS heap (mesh refs + cache): ~5 MB

CPU cache (ChunkBuffers stored):
  24 × 120 KB = ~3 MB

Manifest + countries + tier metadata: ~1 MB

Pixi internal frame buffers + textures: ~30 MB

TOTAL ESTIMATE: ~155 MB peak ≪ 250 MB target ✓
```

This is the architectural justification for hitting the memory gate.
Actual numbers verified in 7.5 benchmark.

### 7.4 Tier switch teardown

`setTier(newTier)`:
1. For all built meshes in current tier: `mesh.destroy({ children: true })`
2. Clear `meshByKey`, `bordersByKey`, `builtOrder`, `inFlight`
3. Clear ChunkCache
4. Cancel in-flight `fetch` via AbortController
5. Load `chunks/{newTier}/manifest.json`
6. Build new rbush from manifest
7. Wait for `updateVisibility` (called by `cullNow`) to populate new tier

Synchronous portion (1-3) targets < 30 ms — just iteration over ≤ 24
mesh destroys. Network + manifest load (5) is async. **Tier-switch
gate (D-1) measures step 1-6 wall-clock.**

---

## 8. Edge cases

### 8.1 Chunk on wrap seam

A chunk at col=0 or col=7 (closest to ±W/2 antimeridian) gets emitted
in 3 wrap-instances per Phase 6 (offsets [-W, 0, +W]). With Phase 7
mesh, the SAME ChunkBuffers is reused across 3 mesh instances at
different `mesh.x` positions. Memory: 1 ChunkBuffers in CPU cache ×
3 Mesh instances in GPU.

### 8.2 Hex straddling chunk boundary

Bake-time: hex assigned to chunk by centroid (Phase 6 § 8.1 floor rule
preserved). Each hex appears in EXACTLY ONE chunk's vertex buffer.
No split rendering.

### 8.3 Tint LUT bake-time vs runtime

**Bake-time** (D-11): `bake:chunks` runs `colors.ts::buildColorLut()` on
the same `countries.json` Pixi will load. Bakes RGBA per vertex into
the binary. If palette changes (hot-reload won't), `bake:chunks`
re-runs.

Trade-off: runtime can't dynamically recolor (gameplay alliance map,
political-vs-terrain mode toggle). For Phase 7's "pure rendering" scope
this is fine. Phase 8+ may need dynamic tint via uniform array indexed
by countryId — out of scope for now.

### 8.4 Border edge ownership across chunks

Same as Phase 6 § 8.2: edges owned by chunk containing midpoint. Bake
time computes edges via `computeBorderEdges` (existing function
preserved verbatim) then partitions to chunk buckets by midpoint.
1-chunk visibility margin (Phase 6 D-5) ensures owning chunk visible
when neighbor hexes are visible.

### 8.5 Async chunk load during tier switch

User pinches zoom 2× → 4× rapidly:
1. `setTier('25km')` starts → AbortController_A created
2. `loadChunk(25km, c-3-1)` issues fetch with signal_A
3. User keeps pinching → `setTier('10km')` fires
4. `setTier` for 10 km calls `AbortController_A.abort()` → fetch_A
   rejects with AbortError
5. AbortController_B created; loadChunk('10km', ...) fires with signal_B

The reject-AbortError path silently drops the chunk (it's no longer
needed). No mesh added to scene from cancelled load. Avoids stale-tier
mesh appearing after user has moved to new tier.

### 8.6 Two simultaneous loadChunk for same key

Possible if updateVisibility re-runs before previous load completes:
```
frame 1: visibility → key X not in cache → loadChunk(X) starts
frame 2 (next rAF): visibility → key X still not built (in flight) → loadChunk(X) again?
```
Mitigation: `inFlight: Set<string>` tracks active loads. Skip if
already in flight.

### 8.7 Mesh rendered before buffer fully uploaded

Pixi v8 `Geometry` upload is synchronous in WebGL2 (`gl.bufferData` is
sync). `new Geometry({attributes, indexBuffer})` schedules upload but
mesh becomes renderable on next render tick. Adding to scene tree
immediately is safe — first render frame uploads + draws together.

### 8.8 Tint mismatch between cached countries.json and baked tint

If user clears IndexedDB or hot-reloads `countries.json` post-bake,
runtime tint LUT may differ from baked tint. Mitigation: bake-time
emits `manifest.json` with `colorLutHash` field. Runtime checks at
boot — if mismatch, log warning + fall back to `?engine=particles`
(legacy path computes tint at runtime so it's robust).

---

## 9. Migration path (Phase 6 → Phase 7)

| Step | Action                                                                | Risk    |
|------|-----------------------------------------------------------------------|---------|
| M-1  | `npm run bake:chunks` produces `public/data/chunks/{tier}/`           | low     |
| M-2  | Add `src/data/chunks.ts` (loader + cache) — additive                  | low     |
| M-3  | Add `src/render/hexShader.ts` — additive                              | low     |
| M-4  | Add `src/render/meshHexLayer.ts` — additive (parallel to hexLayer.ts) | medium  |
| M-5  | Update `src/main.ts` for `?engine=` selector — backward compat        | low     |
| M-6  | Update HUD to show engine + chunk cache stats                         | low     |
| M-7  | Update `scripts/bench-phase6.ts` → bench harness defaults to `?engine=mesh`, write `phase-7-final.json` | medium |
| M-8  | After Phase 7.6 verifies pass: remove `tiles/world-{tier}.bin.gz`     | high    |
| M-9  | After Phase 7.6 verifies pass: remove `src/data/tiers.ts`             | high    |
| M-10 | After Phase 7.6 verifies pass: remove `src/render/hexLayer.ts`        | high    |

M-8/9/10 deferred to post-merge cleanup — keep for safe rollback during
Phase 7 iteration cycle.

---

## 10. Shader strategy

### 10.1 Custom shader (D-6)

```glsl
// Vertex
attribute vec2 aPosition;
attribute vec4 aColor;
varying vec4 vColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  vec3 p = uProjectionMatrix * uWorldTransformMatrix * vec3(aPosition, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vColor = aColor;
}

// Fragment
varying vec4 vColor;
void main() { gl_FragColor = vColor; }
```

Pixi v8 Mesh API auto-binds `uProjectionMatrix` (camera) and
`uWorldTransformMatrix` (mesh.x/y/scale/rotation). Confirmed pattern
in Pixi v8 filter docs. Phase 7.4 prototype verifies binding works for
`Mesh` (vs Filter context) — note this is the highest-risk API
assumption in Phase 7.

If matrices don't auto-bind: fallback uses Pixi's default Mesh shader
with vertex positions in world space, mesh.x = chunk.bbox.worldX +
offsetX.

### 10.2 GLSL ES version

Pixi v8 supports both WebGL1 + WebGL2. iOS Safari 17+ has WebGL2 stable.
Use **GLSL ES 1.0** (varying / attribute / gl_FragColor) for max
compat — covers iOS 13+ Safari.

If Pixi auto-upgrades to WebGL2: shader still valid (1.0 superset). No
change needed.

---

## 11. Self-review (Phase 7.0 sign-off)

### 11.1 Memory & lifecycle (Checklist A)

- [x] Every `new Mesh/Geometry/Buffer/Shader` has destroy path
      (mesh.destroy → geom.destroy → buffer.destroy)
- [x] LRU eviction calls `mesh.destroy({children:true})` — releases GPU buffer via Geometry destroy chain
- [x] No closure leaking ChunkBuffers past eviction — ChunkCache LRU drops references; Mesh holds its own GPU buffer copy
- [x] Tier switch destroys ALL meshes of old tier before loading new
- [x] `ChunkCache.lru` cleared on tier switch (`cache.clear()` called in `setTier`)

### 11.2 Race conditions (Checklist B)

- [x] Chunk load in flight when viewport moves: AbortController wired (§ 8.5)
- [x] Two `setTier` overlapping: each setTier creates fresh AbortController; previous cancelled
- [x] LRU eviction during active fetch: fetch holds reference via promise; eviction only acts on COMPLETED meshes (in builtOrder); in-flight tracked in inFlight Set, not builtOrder
- [x] Mesh added to scene while uploading: § 8.7 — sync GL upload, safe

### 11.3 Binary format correctness (Checklist C)

- [x] Magic + version validated on parse (throw if mismatch)
- [x] All offsets 4-byte aligned (header 16, vertex stride 12 = 4-aligned, index stride 4)
- [x] hex_count matches vertex/index buffer sizes (load-time sanity check)
- [x] Wrap seam chunks: rbush emits 3 entries per chunk regardless of col (Phase 6 D-3 preserved)
- [x] Chunk bbox in footer used for visibility query (matches rbush entry bounds)

### 11.4 Shader correctness (Checklist D)

- [ ] Custom shader compiles on iOS Safari → **needs Phase 7.4 prototype to verify**
- [x] Matrix uniforms set correctly: rely on Pixi v8 Mesh auto-bind (§ 10.1 — risk noted)
- [x] Color format `uint8x4-unorm` matches GLSL `vec4 [0,1]` (Pixi normalizes)
- [ ] No precision warnings on iOS GPU → verify in Phase 7.4 + 7.5 device test

### 11.5 Bundle size (Checklist E)

- [x] Total estimate ~17 MB (50+25+10 km tiers) ≪ 50 MB cap (§ 2.2)
- [x] Per-chunk @ 10 km estimate ~500 KB compressed; @ 50 km ~30 KB
- [x] Gzip ratio expected ~30 % via per-vertex tint repetition
- [x] Manifest JSON: 32 entries × ~100 B = ~3 KB per tier; trivial

### 11.6 Backward compat (Checklist F)

- [x] `?engine=particles` keeps Phase 6 path (M-10 deferred)
- [x] `?engine=mesh` default (D-8)
- [x] `__mwSetZoom`, `__mwCenterOn`, `__mwViewport` unchanged (main.ts wiring same)
- [x] HUD shows engine + chunk cache stats (M-6)

### 11.7 Coordinate contract preservation

- [x] No new neighbor lookup added — bake script uses existing `computeBorderEdges`
- [x] `src/geo/wrap.ts` not modified (Phase 6.8 lock)
- [x] All wrap-aware logic stays in chunkGrid.ts (already uses `normalizeHex`)
- [x] `docs/COORDINATE_SYSTEM.md` not violated

### 11.8 Open risks / mitigations

| ID  | Risk                                                                                              | Mitigation                                              |
|-----|---------------------------------------------------------------------------------------------------|---------------------------------------------------------|
| R-1 | Pixi v8 Mesh shader matrix auto-bind unverified                                                   | Phase 7.4 hello-world prototype validates before 7.3     |
| R-2 | gzip ratio assumption (30%) may be wrong → bundle exceeds cap                                     | bake script reports size; iter 1 swaps to C2 if needed   |
| R-3 | Async chunk fetch latency hides chunks during pan; users see brief blanks                         | CPU cache pre-warms on first visit; LRU keeps recent     |
| R-4 | iOS Safari WebGL2 quirk: `uint8x4-unorm` may differ in normalization                              | Phase 7.4 hello-world tests color render correctness     |
| R-5 | Tint LUT bake/runtime mismatch (R post-bake countries.json change)                                | colorLutHash check + warn + fallback to particles        |
| R-6 | ChunkBuffers ArrayBuffer references prevent Promise GC                                            | Explicit `null` assignment after eviction                |
| R-7 | Bake time grows: per-tier 32 chunks × per-chunk vertex compute may take minutes                   | Reuse Phase 6 bake intermediates; measure in 7.1; OK if < 5 min |

### 11.9 Decisions deferred to implementation

| Defer | Item                                                                       | Where        |
|-------|----------------------------------------------------------------------------|--------------|
| DEF-1 | Exact `Geometry` topology (`triangle-list` vs `triangle-strip`)             | Phase 7.4    |
| DEF-2 | AbortController granularity (per-chunk vs per-tier)                        | Phase 7.2    |
| DEF-3 | Border Graphics line width — match Phase 6 `BORDER_WIDTH_FACTOR`?          | Phase 7.3    |
| DEF-4 | Manifest schema versioning (`schemaVersion: 2` for chunked manifest)        | Phase 7.1    |

---

## 12. Rollback plan

If Phase 7 fails to close the perf gates after iter 3:

1. `?engine=mesh` removed from defaults (back to `?engine=particles`)
2. Or branch `phase-7-prebaked-mesh` not merged → `main` stays on Phase 6
3. `phase-7-retro.md` documents what worked / didn't
4. Phase 8 candidates in retro: instanced rendering (C2), WebWorker
   chunk loader, alternative renderer (regl, three.js)

The Phase 7.5 A/B switch (D-8) means rollback is a one-line change in
`main.ts`, not a code revert. Lower-risk than Phase 6's iter 2
experience.

---

## 13. Sign-off

Self-review complete. Risks R-1 and R-4 (Pixi v8 + iOS shader) require
Phase 7.4 prototype before committing to Phase 7.3 (mesh layer). Phase
order respected: 7.1 (bake) ships first → 7.2 (loader) → 7.4 (shader
prototype, validates assumption) → 7.3 (full mesh layer using
validated shader) → 7.5 (wire + bench) → 7.6 (iter).

Implementation budget: 18 h max per `PHASE7_PROMPT.md` § "Self-loop
budget". Each phase has individual budget; iteration cap = 3.

---

> END OF ARCHITECTURE DOC v1
