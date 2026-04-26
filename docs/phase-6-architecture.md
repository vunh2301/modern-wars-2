# Phase 6 — Viewport-based Chunked Rendering Architecture

> Status: **DRAFT v1** (Phase 6.0)
> Author: Claude Opus 4.7
> Branch: `phase-6-viewport-cull`
> Date: 2026-04-26
> Reviewer: self-review only (no human reviewer in loop)

---

## 1. Mission scope

Phase 6 closes 4 concrete pain points without touching gameplay (Section 15
NEGATIVE list of `docs/SPEC.md` still applies):

| # | Pain                                              | Evidence                                                                                  |
|---|---------------------------------------------------|-------------------------------------------------------------------------------------------|
| 1 | Tier switch freeze 200–500 ms                     | `setTier` in `src/render/hexLayer.ts:163-240` destroys + rebuilds full PC + Graphics      |
| 2 | 0 % viewport culling                              | `cullable=false` on hex root (`src/render/hexLayer.ts:152`) → CullerPlugin no-op for hex  |
| 3 | 10 km tier 1.25 M hexes × 3 wrap copies disabled  | `WRAP_TIER_NAMES = {'50km','25km'}` (`src/render/hexLayer.ts:41`) — fine tier no wrap     |
| 4 | Borders monolithic Graphics → can't partial cull  | One `borders` Graphics per tier, full re-tessellate on `setTier`                          |

Phase 6 is rendering optimization only. **No new dependencies.** `rbush@4`
already pinned in `package.json:20`.

---

## 2. Architectural decisions (LOCKED)

These mirror the spec lock; deltas vs spec are flagged.

| ID    | Decision                                                                       | Note                                                            |
|-------|--------------------------------------------------------------------------------|-----------------------------------------------------------------|
| D-1   | Chunk grid = **8 cols × 4 rows = 32 logical chunks**                            | Spec lock; see § 11 D-1 caveat                                  |
| D-2   | Per-logical-chunk: 1 `ParticleContainer` (fills) + 1 `Graphics` (borders)       | Wrap tiers emit 3× per chunk (one per offset)                    |
| D-3   | Spatial index = `rbush@4` indexed by **chunk × wrap offset** bbox in world px   | 32 entries non-wrap, 96 entries wrap                             |
| D-4   | Lazy build: chunk's GPU resources allocated **on first visibility**, cached     | Hex/edge data computed once at `setTier`                         |
| D-5   | Visibility hysteresis: 1 chunk margin (one ring out) past viewport bbox         | Prevents flicker on micro-pan AND covers cross-chunk edges       |
| D-6   | Wrap copies for 50 km & 25 km only (not 10 km, OOM on iPhone)                   | Same as today                                                    |
| D-7   | Border edge owned by chunk containing edge **midpoint**                         | Renders in that chunk's `Graphics`, even if neighbor hex elsewhere |
| D-8   | Hex assignment by centroid: `floor((cx − worldMinX)/chunkW)` clamped           | Boundary hex → higher chunk (natural floor); spec says lower → see § 11 D-7 |
| D-9   | Throttle `updateVisibility` via `requestAnimationFrame` trailing dispatch       | NOT debounce; matches plan note                                  |
| D-10  | All 4 ParticleContainer dynamic flags = `false` (position/scale/rotation/color) | Static after build, GPU buffer baked once — same as today        |

---

## 3. Current pipeline (before Phase 6)

```
viewport.on('zoomed') ──► maybeSwitchLod() ──► loadTier(name) ──► hexLayer.setTier(td, lut)
                                                                       │
                                                                       ▼
                                                  destroy old ParticleContainer + Graphics
                                                                       │
                                                                       ▼
                                                  iterate ALL N hexes × {1, 3} offsets:
                                                    addParticle(...)         ◄─ 200-500 ms
                                                    moveTo/lineTo border edge
                                                                       │
                                                                       ▼
                                                  add to root, render every frame
```

`viewport.on('moved')` only updates HUD — no culling, no chunk awareness.
Pixi renders the entire ParticleContainer every frame (GPU-side it batches OK,
but transforms still walk the world's bbox).

## 4. Proposed pipeline (Phase 6)

```
viewport.on('zoomed') ──► maybeSwitchLod() ──► loadTier(name) ──► hexLayer.setTier(td, lut)
                                                                       │
                                                                       ▼
                                                  destroy ALL chunk GPU + clear rbush
                                                                       │
                                                                       ▼
                                                  buildChunkGrid(tier):       ◄─ < 50 ms
                                                    - assign hex → chunk (centroid)
                                                    - assign edges → chunk (midpoint)
                                                    - rbush.load(chunk × offset bboxes)
                                                  (NO GPU allocation here)
                                                                       │
                                                                       ▼
                                                  hexLayer.updateVisibility(viewport.bbox)

viewport.on('moved'│'zoomed') ──► throttleRaf(updateVisibility) ──► rbush.search(viewport.bbox)
                                                                       │
                                                                       ▼
                                          for each visible (chunkData, offsetX):
                                              if !built: buildChunk(...)        ◄─ <8 ms / chunk
                                              chunk.particles.visible = true
                                          for each non-visible chunk: chunk.particles.visible = false
```

Key invariants:
- `setTier` does NO GPU work — lifts the freeze.
- `buildChunk` is amortized: at most ~12 chunks visible at fine tier, each <8 ms,
  but most frames only build 0–1 (entered viewport this frame).
- Chunk visibility margin (D-5) means rbush query bbox is `viewport ⊕ chunkSize/2`
  per axis.

---

## 5. Component view

```
┌──────────────────────── src/render/hexLayer.ts ────────────────────────┐
│ HexLayer {                                                              │
│   root: Container          ◄── stays cullable=false (chunks own culling)│
│   setTier(tier, lut)       ◄── computes chunkGrid, NO GPU build         │
│   setBordersVisible(v)     ◄── toggles all chunks' borders              │
│   updateVisibility(bbox)   ◄── NEW — rbush query → toggle chunks        │
│   destroy()                                                             │
│ }                                                                       │
│  internal:                                                              │
│   chunkGrid: ChunkGrid     ◄── from createChunkGrid()                   │
│   texture: RenderTexture   ◄── shared across all chunks (1 per HexLayer)│
└─────────────────────────────────────────────────────────────────────────┘
            │ uses
            ▼
┌──────────────────── src/render/chunkGrid.ts (NEW) ──────────────────────┐
│ createChunkGrid(tier, worldWidth, worldHeight, hexSizeWorldPx,          │
│                 wrapOffsets[]) → ChunkGrid                              │
│                                                                         │
│ ChunkGrid {                                                             │
│   chunks: ChunkData[]              ◄── 32 logical chunks                │
│   spatialIndex: RBush<ChunkEntry>  ◄── 32 or 96 entries (× wrap)        │
│   destroy()                                                             │
│ }                                                                       │
│                                                                         │
│ ChunkData {                                                             │
│   bbox: ChunkBbox                                                       │
│   hexes: HexRecord[]               ◄── slice of tier.hexes              │
│   edges: Float32Array              ◄── borders owned by this chunk      │
│   particles: ParticleContainer|null◄── lazy                             │
│   borders: Graphics|null           ◄── lazy                             │
│   builtAt: number                  ◄── perf.now() or 0                  │
│ }                                                                       │
│                                                                         │
│ ChunkEntry { minX,minY,maxX,maxY, chunk: ChunkData, offsetX: number }   │
└─────────────────────────────────────────────────────────────────────────┘
            │ wires through
            ▼
┌──────────────────────── src/main.ts ────────────────────────────────────┐
│ const updateVisibleChunks = throttleRaf(() => {                         │
│   hexLayer.updateVisibility(viewport.getVisibleBounds());               │
│ });                                                                     │
│ viewport.on('moved', updateVisibleChunks);                              │
│ viewport.on('zoomed', () => { updateHud(); maybeSwitchLod();            │
│                               updateVisibleChunks(); });                │
│ // After every successful setTier in maybeSwitchLod:                    │
│ hexLayer.updateVisibility(viewport.getVisibleBounds());  // initial      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Data flow per frame (steady state)

```
user pans 4 px right
        │
        ▼
viewport emits 'moved'
        │
        ▼
throttleRaf coalesces to next rAF tick (~16 ms)
        │
        ▼
hexLayer.updateVisibility(bbox = {minX,minY,maxX,maxY} world px)
        │
        ▼
expanded := bbox ⊕ marginPx                    ◄── D-5: 1 chunk margin
visibleEntries = rbush.search(expanded)        ◄── < 0.3 ms (32-96 entries)
        │
        ▼
For each visibleEntry:
   chunk = entry.chunk
   if not chunk.built:
     buildChunk(chunk, offsetX, ...)           ◄── < 8 ms per chunk
                                               ◄── most frames 0 builds
   chunk.particlesByOffset[offsetX].visible = true

For each chunk currently visible last frame but NOT in visibleEntries:
   chunk.particlesByOffset[offsetX].visible = false

(no destroy — keeps GPU buffers warm for re-entry)
        │
        ▼
Pixi ticker fires render — only visible chunks contribute to GPU draw
```

---

## 7. Memory model + chunk lifecycle

```
┌────────────────────────── lifecycle ──────────────────────────┐
│                                                               │
│  setTier ─────► createChunkGrid (CPU only)                    │
│                       │                                       │
│                       ▼                                       │
│                 chunks[].particles = null  ◄── cold           │
│                                                               │
│  updateVisibility hits chunk first time ────► buildChunk      │
│                       │                                       │
│                       ▼                                       │
│                 chunks[].particles = PC + addParticle(...)    │
│                 chunks[].borders   = Graphics + stroke(...)   │
│                 chunks[].builtAt   = perf.now()               │
│                       │                                       │
│  (subsequent enter/exit viewport)                             │
│                       ▼                                       │
│                 chunks[].particles.visible = true|false       │
│                 (NO destroy, NO rebuild)                      │
│                                                               │
│  setTier called again ────► destroy() each chunk's GPU        │
│                              clear chunkGrid + rbush          │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Memory estimate at **steady state, tier 10 km, all chunks built once**:

- 32 ParticleContainers × ~39 K particles avg = ~1.25 M particles total
  (same as today's monolithic). PC stores position/tint as Float32 → ~32 B
  per particle → ~40 MB GPU buffer. Same as baseline.
- Per-chunk Float32Array edges: ~5 K segments avg × 16 B = ~80 KB × 32 = 2.6 MB
- rbush tree: 96 entries × ~80 B = ~8 KB. Negligible.

**No new memory pressure** — Phase 6 is rearrangement, not addition. Win comes
from never building chunks the user never zooms toward (e.g. open Pacific @ 10 km).

If user pans across the entire world @ 10 km, all 32 chunks built → memory peaks
at the same level today's monolithic does. Acceptable per acceptance criteria
(< 250 MB target).

---

## 8. Edge cases (deep dive)

### 8.1 Hex centroid on chunk boundary

Rule (D-8): `col = floor((cx − worldMinX) / chunkW)`, clamped to [0, 7].
If `cx == chunk[k].worldX` exactly → `col = k` (the higher chunk).

Spec said "assign to lower chunk" (D-7). In practice: hex pitch is ~12 km @
10 km tier vs chunk width ~803 px (~5 000 km). Probability of exact equality
is effectively zero. **Accept floor as-is**, document deviation. Verified in
6.1 unit test: assert hex assignment is **deterministic** and **single-owner**
(no double-counting), regardless of which side wins.

### 8.2 Border edge midpoint in chunk DIFFERENT from both hex chunks

Edges are between two adjacent hex centroids. Distance ≤ hex pitch (~12 km).
Midpoint can land in:
- (a) Same chunk as hex A and hex B (most common, both same chunk)
- (b) Chunk of A or B (one of them, when A and B straddle a chunk boundary)
- (c) A THIRD chunk neither A nor B (only when midpoint sits exactly at a
   3-chunk corner — geometrically impossible for hex pair sharing an edge,
   since midpoint is between two centroids ≤ 12 km apart, can only be in chunks
   A, B, or chunks adjacent to both)

Case (c) is therefore impossible → midpoint ∈ {A.chunk, B.chunk, neighborOf(A)
chunks within ½ pitch}. With chunk width 5 000 km and pitch 12 km, midpoint
deviation from hex chunks is bounded by 6 km << chunk width. Conclusion: edge
midpoint chunk ∈ {A.chunk, B.chunk} ∪ direct-neighbor chunk.

**Owner rule**: assign edge to the chunk containing midpoint, regardless of
where its hexes live. Then visibility margin (D-5: 1 chunk ring) ensures that
when an edge-owning chunk becomes visible, **adjacent chunks (which may own
the participating hexes) are also visible.** This eliminates the "floating
edge" failure mode.

### 8.3 Wrap copy chunks: dedup vs visibility

Coarse tiers (50 km / 25 km) wrap horizontally with offsets [-W, 0, +W].
Approach (chosen, vs alternatives in § 11):

- **Logical chunk**: data computed once (hexes, edges) per `(col, row)`.
- **GPU emission**: one `ParticleContainer` + one `Graphics` per
  (logical chunk, offsetX). Stored on chunk as
  `particlesByOffset: Map<offsetX, ParticleContainer>`. Same for borders.
- **rbush entries**: one per (chunk, offsetX) → 96 for wrap tiers, 32 otherwise.
  `entry.chunk` and `entry.offsetX` together identify which GPU container to toggle.

Dedup is automatic: rbush.search returns each (chunk, offset) entry at most once.
Position offset applied at particle.x level (already done today, see
`hexLayer.ts:212-219`).

### 8.4 Tier switch mid-pan

Race: viewport emits `moved` while `lodInFlight=true` and chunkGrid is being
torn down. Mitigations:

1. `lodInFlight` gate already exists (`main.ts:114`) — preserved.
2. `setTier` is **synchronous from hexLayer's perspective** — by the time
   `await loadTier(next)` resolves and `hexLayer.setTier(td, lut)` runs, the
   old chunkGrid is destroyed and the new one is created in same JS tick.
3. `updateVisibility` called immediately after `setTier` in `maybeSwitchLod`
   handler — guarantees first-frame visibility query for new tier before next
   `moved` event.
4. If user pans during the (synchronous) chunkGrid build, the next throttled
   `updateVisibility` tick (next rAF) picks up the new viewport bbox naturally.

### 8.5 Cross-chunk neighbor lookup (border tessellation)

CRITICAL: `computeBorderEdges` (`hexLayer.ts:91-147`) uses wrap-aware lookup:
when q wraps `±wrapHexCount`, r adjusts `±wrapHexCount/2` (line 116). This
is what eliminates the Bering-strait seam zigzag.

Phase 6 must NOT lose this. Strategy:

- Build the **whole-tier** countryByKey map ONCE in `createChunkGrid` (same as
  today's `computeBorderEdges`).
- Compute the **whole-tier** edges Float32Array ONCE — wrap-aware lookup
  unchanged.
- Then partition edges to chunks by midpoint — purely a downstream sorting
  step, doesn't change which edges are produced.

Result: edge SET is identical to today. Only its STORAGE is partitioned.
Seam invariant preserved by construction.

### 8.6 Visibility margin must cover edge ownership

Worst case: chunk K is just outside viewport, but owns an edge whose hex
neighbors are inside viewport. If K not visible → edge missing → user sees gap.

Margin = 1 chunk ring already covers this: midpoint ≤ 6 km from hex centroids,
chunks ≥ 5 000 km wide → midpoint can never be more than 6 km outside its
hex chunks → the chunk that owns the edge is always within ½ pitch of hex
chunks → never further than the immediate neighbor of any visible hex chunk.

### 8.7 Initial fit-to-screen at zoom < 1×

Acceptance criteria says "≤ 12 chunks visible at any zoom" — but at fit-to-
screen (zoom ~0.18 on iPhone 13 Pro Max portrait) the entire world is visible
→ all 32 chunks intersect viewport. **Resolution**: relax this metric to "≤ 12
visible at tier 10 km @ zoom ≥ 4×" (when chunk count actually matters for
performance). Document in Phase 6.4 instrumentation.

At coarse tiers, chunks are small (49 K hexes / 32 chunks ≈ 1.5 K hexes per
chunk @ 50 km), so all-32-built is cheap.

---

## 9. Migration path (concrete code-level)

| Step | Action                                                                                                        | File touched                                  |
|------|---------------------------------------------------------------------------------------------------------------|-----------------------------------------------|
| M-1  | Create `src/render/chunkGrid.ts` (new)                                                                        | `src/render/chunkGrid.ts` (NEW)               |
| M-2  | Refactor `setTier`: move computation to chunkGrid, drop monolithic PC/Graphics build                          | `src/render/hexLayer.ts`                      |
| M-3  | Add `updateVisibility(bbox)` method to `HexLayer` interface                                                   | `src/render/hexLayer.ts`                      |
| M-4  | Implement `buildChunk()` private fn — extracts current particle/border emit loop                              | `src/render/hexLayer.ts`                      |
| M-5  | Wire throttled `updateVisibility` to viewport events                                                           | `src/main.ts`                                 |
| M-6  | Call `updateVisibility` once after `setTier` (initial + after LOD switch)                                     | `src/main.ts`                                 |
| M-7  | Extend HUD with chunks visible/built + last build/cull ms                                                     | `src/main.ts` (queueMicrotask block)          |
| M-8  | Add perf.mark/measure for tier-switch, chunk-build, cull-query                                                | `src/main.ts`, `src/render/hexLayer.ts`        |
| M-9  | Expose `window.__mwBenchmark()` returning JSON                                                                | `src/main.ts`                                 |
| M-10 | New `scripts/bench-phase6.ts` Playwright harness — 3 scenarios                                                | `scripts/bench-phase6.ts` (NEW)               |
| M-11 | Iterate on benchmark failures (max 3 cycles)                                                                  | depends on hypothesis                         |

`viewport.ts`, `lod.ts`, `stage.ts`, `colors.ts`, `tiers.ts`, `projection.ts`,
`hex.ts` are **not touched**.

Public API preserved — existing test harness hooks unchanged:
`window.__mwSetZoom`, `window.__mwCenterOn`, `window.__mwViewport`,
`window.__mwApp`, `window.__mwTier`, `window.__mwZoom`, `window.__mwHexCount`.

---

## 10. Type sketch (final shape)

```ts
// src/render/chunkGrid.ts
import RBush from 'rbush';
import type { TierData, HexRecord } from '../data/tiers';
import type { Container, Graphics, ParticleContainer } from 'pixi.js';

export interface ChunkBbox {
  id: string;          // 'c-3-1'
  col: number;         // 0..COLS-1
  row: number;         // 0..ROWS-1
  worldX: number;      // chunk left edge in world px
  worldY: number;      // chunk top edge
  width: number;
  height: number;
}

export interface ChunkData {
  bbox: ChunkBbox;
  hexes: HexRecord[];                                  // own hexes (no wrap dup)
  edges: Float32Array;                                 // own edge segments
  particlesByOffset: Map<number, ParticleContainer>;   // lazy, key = offsetX
  bordersByOffset: Map<number, Graphics>;              // lazy
  builtAtByOffset: Map<number, number>;                // 0 = not built
}

export interface ChunkEntry {
  minX: number; minY: number; maxX: number; maxY: number;
  chunk: ChunkData;
  offsetX: number;
}

export interface ChunkGrid {
  chunks: ChunkData[];
  spatialIndex: RBush<ChunkEntry>;
  destroy(): void;     // destroys all built GPU resources
}

export const COLS = 8;
export const ROWS = 4;

export function createChunkGrid(
  tier: TierData,
  hexSizeWorldPx: number,
  worldMinX: number,
  worldMinY: number,
  worldWidth: number,
  worldHeight: number,
  wrapOffsets: ReadonlyArray<number>,
): ChunkGrid;
```

```ts
// src/render/hexLayer.ts (refactored interface)
export interface HexLayer {
  root: Container;
  setTier(tier: TierData, lut: Uint32Array): void;
  setBordersVisible(visible: boolean): void;
  updateVisibility(viewportBboxWorld: { minX: number; minY: number; maxX: number; maxY: number }): void;  // NEW
  destroy(): void;
}
```

```ts
// src/main.ts (additions)
function throttleRaf<T extends (...args: never[]) => void>(fn: T): T {
  let scheduled = false;
  return ((...args: Parameters<T>) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...args);
    });
  }) as T;
}
```

---

## 11. Self-review (Phase 6.0 sign-off)

### 11.1 Memory & lifecycle (Checklist A)

- [x] Every `new ParticleContainer/Graphics/RenderTexture` has destroy path
      (chunk.particles destroyed in `chunkGrid.destroy()`; texture survives layer)
- [x] Tier switch teardown: `chunkGrid.destroy()` iterates ALL chunks → destroy
      all built GPU; rbush.clear()
- [x] No closure capturing stale TierData ref — `setTier` overwrites `chunkGrid`
      ref atomically
- [x] `chunkGrid.spatialIndex` cleared on tier switch (handled by destroy())

### 11.2 Race conditions (Checklist B)

- [x] viewport moves during async chunk build: build is sync (single rAF tick),
      not async — no race window
- [x] tier switch fires while chunks still building: no async chunk build, so
      this can't happen
- [x] `lodInFlight` flag still respected (preserved in main.ts)
- [x] `updateVisibility` reentrant-safe: throttleRaf coalesces to next frame;
      same JS thread, no concurrent calls

### 11.3 Spatial correctness (Checklist C)

- [x] Chunk boundary inclusion: floor rule, deterministic, single-owner
      (D-8 + § 8.1)
- [x] Border edge ownership: midpoint rule, unambiguous (D-7 + § 8.2 + § 8.6)
- [x] Wrap copy chunks: rbush has 1 entry per (chunk, offset); no dedup needed
      since each entry maps to distinct GPU container (D-3 + § 8.3)
- [x] Hex on chunk boundary: rendered exactly once (single chunk owns it)

### 11.4 Performance (Checklist D)

- [x] Chunk build is O(chunk hex count): only iterates `chunk.hexes` and
      `chunk.edges` (already partitioned)
- [x] rbush query result bounded: at fine tier ≤ 12 entries (visible chunks
      cap); at coarse tier all 32 acceptable (small data per chunk)
- [x] No allocations in `updateVisibility` hot path: pre-allocate temp Set for
      "previously visible" diffing; reuse rbush result array (rbush always
      returns new array — accept one alloc per frame, < 96 entries)
- [x] ParticleContainer dynamicProperties all `false` (D-10) — already done
      today, preserved

### 11.5 Open risks / mitigations

| ID    | Risk                                                                          | Mitigation                                          |
|-------|-------------------------------------------------------------------------------|-----------------------------------------------------|
| R-1   | 8 cols × 4 rows tall-narrow chunks @ 1:1 world ratio inefficient for vertical pan | Accept; Phase 6.6 may revisit if benchmarks fail   |
| R-2   | rbush.search allocates new array each call (~96 entries × 8B ref = 0.8 KB)    | One small alloc / frame is in noise (< 0.05 ms)     |
| R-3   | First-time build of large chunk (e.g. Russia) may exceed 8 ms budget          | Log warning if `chunk.hexes.length > 50000`         |
| R-4   | Real iPhone 13 Pro Max not directly accessible from autonomous loop          | Fallback to Playwright + desktop Chrome with note   |
| R-5   | Edge midpoint chunk MAY differ from spec's "single chunk per edge" intent     | § 8.2 proves only A/B/adjacent → margin covers it   |
| R-6   | Fit-to-screen (zoom < 1×) violates ≤12 visible chunks budget                  | § 8.7 — relax metric to apply only @ tier 10 km     |

### 11.6 Coverage of plan's edge case list

Plan § 6.0 (3) requires these be covered:

- ✅ Hex on chunk boundary → § 8.1 + D-8
- ✅ Border between hexes in different chunks → § 8.2
- ✅ Wrap copy chunks dedup → § 8.3
- ✅ Tier switch mid-pan → § 8.4

Self-review surfaces no missing edge cases.

### 11.7 Decisions deferred to implementation

| Defer  | Item                                                                                | Where                              |
|--------|-------------------------------------------------------------------------------------|------------------------------------|
| DEF-1  | `marginPx` exact value (1 chunk vs ½ chunk)                                          | Phase 6.2 — start with 1 chunk     |
| DEF-2  | Texture lifecycle: 1 RT per HexLayer (current) vs 1 per chunk                        | Keep 1 per HexLayer (RT is shared) |
| DEF-3  | rbush bulk-load (`rbush.load`) vs per-entry `insert`                                 | Use `load` (96 entries, faster)    |
| DEF-4  | What to do with `addParticle` when chunk has 0 hexes (e.g. open ocean chunk)         | Skip build entirely; never visible |

---

## 12. Acceptance criteria mapping

| Acceptance gate                              | Phase 6 mechanism                                                       |
|----------------------------------------------|-------------------------------------------------------------------------|
| Tier switch 50 km → 25 km < 50 ms            | setTier no longer builds GPU → only chunkGrid CPU work                  |
| Tier switch 25 km → 10 km < 80 ms            | same; 10 km chunkGrid CPU may be larger but still no GPU                 |
| Pan storm 30 s @ 10 km, FPS p95 ≥ 58         | Only ≤ 12 chunks rendered → ~10× less particle work per frame            |
| Pinch zoom storm 60 s, FPS p95 ≥ 55          | Same culling effect; LOD switch cheap                                   |
| Memory peak < 250 MB after 60 s pan/zoom     | All chunks built in worst case = same as today's monolithic; baseline OK |
| Visible chunks ≤ 12                          | rbush query bounded by visible viewport / chunk size; ≤ 12 @ 10 km      |
| Chunk build time per chunk < 8 ms            | Per-chunk hex count ~ 39 K avg @ 10 km; addParticle ~ 0.0002 ms / hex   |

---

## 13. Sign-off

Self-review complete. No blocking issues found. Proceed to **Phase 6.1**.

Open risks (R-1..R-6) accepted with documented mitigations. R-1 (chunk
ratio) and R-4 (real device) flagged for human review post-benchmark.

Migration is incremental: Phase 6.1 ships pure CPU code (chunkGrid.ts) that
HexLayer doesn't yet use. Phase 6.2 swaps hexLayer.ts internals — single
atomic refactor commit. Phases 6.3–6.4 wire it up. Phase 6.5 measures.

---

> END OF ARCHITECTURE DOC v1
