# Phase 6 — Iter 2 hypothesis & fix

> Iteration: **2 of 3**
> Trigger: iter 1 bench failed 3 of 8 gates (memory worse: 785 → 1856 MB peak; tier-switch 657 ms unchanged; chunk-build 65 ms newly visible)
> Date: 2026-04-26

---

## What iter 1 taught us

Iter 1 (LRU + bench fixes) revealed that the *visible* metrics were correct
all along — the previous "785 MB" was the post-GC settled state, not peak.
True peak during scenario churn is **~1856 MB**.

The dominant cost contributors (now measurable thanks to iter 1's
instrumentation fix):

| Component                          | Estimated cost @ 10 km tier            |
|------------------------------------|----------------------------------------|
| `countryByKey` Map (1.25 M entries)| ~190 MB heap, ~250 ms to build         |
| `chunkGrid` Float32Array edges     | ~80 MB heap, allocated eagerly         |
| Per-chunk `addParticle` × 39K      | ~65 ms / chunk-build (12 visible = 780 ms blocking after tier switch) |
| Pixi internal WebGL buffers (cumulative across LRU eviction churn) | unknown, hits ~750 MB peak     |

LRU eviction (iter 1) only caps **GPU resources** (~187 MB worth). The bulk
allocation pressure (chunkGrid build itself) is unaddressed.

## ONE specific fix

**Replace `countryByKey: Map<number, number>` with a flat `Uint32Array`
open-addressing hash table.**

Quantitative win:

| Metric                    | Map<number,number>    | Uint32Array hash    | Δ                |
|---------------------------|-----------------------|---------------------|------------------|
| Heap (1.25 M entries)     | ~190 MB               | ~10 MB (2.5 M × 4B) | **−180 MB**      |
| Set per entry             | ~150 ns               | ~10 ns              | **15× faster**   |
| Get per entry             | ~100 ns               | ~10 ns              | **10× faster**   |
| chunkGrid build (10 km)   | ~657 ms               | predict ~250 ms     | **−400 ms**      |

### Implementation plan

`src/render/chunkGrid.ts`:

1. Remove `countryByKey: Map<number, number>`.
2. Add inline open-addressing table backed by:
   - `keys: Uint32Array(tableSize)` — composite (q,r) keys, 0 = empty
   - `vals: Uint16Array(tableSize)` — countryId values
3. Table size = next power of 2 ≥ 2 × `tier.hexes.length` (load factor ~0.5).
4. Hash: composite key has good distribution; `hash(k) = k & (tableSize - 1)`.
5. Insert: linear probe on collision.
6. Lookup: linear probe until match or empty slot.
7. Empty key sentinel: 0 — but composite key 0 can collide with valid `(q=−32768, r=−32768)` hex. Add 1 to all stored keys; subtract 1 on read. Or shift sentinel to 0xFFFFFFFF.

Code shape:

```ts
const tableSize = nextPow2(tier.hexes.length * 2);
const tableMask = tableSize - 1;
const tableKeys = new Uint32Array(tableSize); // 0 = empty
const tableVals = new Uint16Array(tableSize);
const STORED_KEY_OFFSET = 1; // shift so no stored key is 0

function tableSet(rawKey: number, val: number): void {
  let i = rawKey & tableMask;
  const stored = rawKey + STORED_KEY_OFFSET;
  while (tableKeys[i] !== 0 && tableKeys[i] !== stored) {
    i = (i + 1) & tableMask;
  }
  tableKeys[i] = stored;
  tableVals[i] = val;
}

function tableGet(rawKey: number): number | undefined {
  let i = rawKey & tableMask;
  const stored = rawKey + STORED_KEY_OFFSET;
  while (tableKeys[i] !== 0) {
    if (tableKeys[i] === stored) return tableVals[i]!;
    i = (i + 1) & tableMask;
  }
  return undefined;
}
```

## Predicted post-iter-2 outcome

| Gate                                 | Pre-iter-2     | Predicted post-iter-2                       |
|--------------------------------------|----------------|---------------------------------------------|
| tier_switch_25to10_under_80ms        | 657 ms ✗       | ~250 ms ✗ (improved 60 % but still > 80 ms) |
| tier_switch_50to25_under_50ms        | 73 ms ✗        | ~25 ms ✓                                    |
| memory_peak_under_250mb              | 1856 MB ✗      | ~1500 MB ✗ (saves 180 MB; bulk still high)  |
| chunk_build_p95_under_8ms            | 65 ms ✗        | unchanged ✗ — per-chunk addParticle is the cost |
| pan_storm_10km_fps_p95_ge_58         | 140.8 fps ✓    | ✓                                           |
| pinch_zoom_fps_p95_ge_55             | 72.5 fps ✓     | ✓ improved (less GC churn)                  |
| visible_chunks_max_le_12_at_10km     | 12 ✓           | ✓                                           |
| antimeridian_pan_10km_fps_p95_ge_58  | 140.8 fps ✓    | ✓                                           |

Iter 2 fixes 50→25 tier switch, halves the 25→10 freeze, and shaves 180 MB.
But two gates remain failing (chunk_build & 25→10 tier-switch & memory).

If iter 2 cuts memory peak below ~1000 MB, iter 3 attacks chunk-build via
**frame-budgeted lazy build** (1–2 chunks per rAF, fade-in over ~6 frames).
If memory stays > 1000 MB, iter 3 attacks **chunkGrid edge eager allocation**
(defer Float32Array per-chunk to lazy build).

## Risks of this fix

- Open-addressing collision storms if hash distribution poor → degraded
  lookup. Mitigate: load factor ≤ 0.5 (table size 2× entries).
- Sentinel collision: composite key `(0, 0)` could equal sentinel `0`.
  STORED_KEY_OFFSET = 1 adds 1 before storing, subtracts on read.

## Rollback plan

Single file revert: `git revert <iter-2-commit>` → restores Map.

---

> END OF ITER 2 HYPOTHESIS
