# Phase 7 — Iter 1 hypothesis & fix

> Iteration: **1 of 3**
> Trigger: Phase 7.5 bench (`bench-results/phase-6-final.json`) — 7 of 8 gates pass; only `memory_peak_under_250mb` fails (618 MB vs target 250 MB)
> Date: 2026-04-26

---

## Failure (verbatim)

```
✗  memory_peak_under_250mb  618.2 MB (cum=333.9)  (target: < 250 MB)
```

7 other gates passing — including all FPS gates and the killer
tier-switch gates that Phase 6 failed catastrophically (714 ms → 0.9 ms).

## Diagnosis

Peak memory comes from **duplicate ArrayBuffer retention**:

```
Per chunk @ 10 km tier:
  ChunkBuffers (CPU cache, 24 max): vertex 2.8 MB + index 1.9 MB + edges 80 KB ≈ 4.8 MB
  PixiBuffer GPU upload (24 active meshes): another ~4.8 MB JS-side mirror
  Per-chunk JS overhead: ~9.6 MB

24 chunks × 9.6 MB = ~230 MB at steady state
+ pre-GC churn from rapid pan (chunks fetched then evicted before GC) ≈ 200 MB
+ Pixi base state ≈ 80 MB
+ tier hex data + countries + manifest + scenarios overhead ≈ 100 MB

Total: ~610 MB peak — matches measurement (618 MB)
```

`ChunkCache` was added in Phase 7.2 to allow fast re-mount when a chunk
re-enters viewport (avoids re-fetch). Tradeoff: holds extra ~5 MB / chunk.

## ONE specific fix

**Remove ChunkCache from `meshHexLayer`. Mesh holds GPU buffer only;
re-visit triggers re-fetch (~10 ms network) instead of cache-hit (~1 ms).**

Predicted memory savings:
- Drop CPU cache for 24 chunks: ~120 MB JS heap freed
- Mesh-only retention: ~24 × 5 MB GPU mirror still present (~120 MB)
- New steady state: ~120 MB GPU + ~80 MB Pixi base + ~50 MB other = ~250 MB
- Pan-storm peak (pre-GC churn): ~250 + 100 churn = ~350 MB

Still over 250 MB target but much closer. **Iter 2 candidate** if this
doesn't close gap: reduce LRU cap from 24 → 16 (memory ÷ 1.5).

### UX cost

Pan back to recently-visited chunk: 10 ms fetch + 1 ms parse + 1 ms upload
= ~12 ms blocking. At 60 fps, that's < 1 frame impact per re-visit.

Acceptable for the memory savings.

### Implementation

`src/render/meshHexLayer.ts`:

1. Remove `chunkCache` member.
2. Remove `chunkCache.set(...)` and `chunkCache.get(...)` calls in
   `fetchAndMount`, `handleLoaded`, `updateVisibility`.
3. Always go through `fetchAndMount` for non-built chunks.
4. Remove `import { ChunkCache } from '../data/chunks'`.

Optional cleanup:
5. ChunkCache class still useful for future iter 2/3; leave it in
   `chunks.ts` as exported but unused.

## Predicted post-iter-1 outcome

| Gate                                 | Pre-iter-1     | Predicted post-iter-1                     |
|--------------------------------------|----------------|-------------------------------------------|
| memory_peak_under_250mb              | 618 MB ✗       | ~350 MB ✗ (still over, but ~45 % drop)    |
| All other 7 gates                    | ✓              | ✓ (cache miss adds 10 ms but FPS p95 OK)  |

If memory < 350 MB → progress; iter 2 closes remaining gap.
If memory > 500 MB → cache wasn't the dominant factor; investigate Pixi
internal buffer retention.

## Actual outcome — REVERTED

```
✗  memory_peak_under_250mb  710.2 MB (cum=635.7) (target: < 250 MB)
```

**Memory got slightly WORSE** (618 → 710 MB peak; 333 → 635 MB cumulative).
All other 7 gates still pass.

Hypothesis invalidated. CPU `ChunkCache` was not the dominant memory cost
— removing it actually increased peak (re-fetch churn under pan-storm
created more transient ArrayBuffers pre-GC than the cache held).

Per plan branch ("If memory > 500 MB → investigate Pixi internal buffer
retention"), iter 2 pivots to **C2 instanced rendering** (arch § 2.1
fallback) — bypasses C1's per-vertex tint duplication entirely, expected
to drop GPU+CPU footprint ~10×.

**Action**: reverted `meshHexLayer.ts` to baseline via
`git checkout HEAD -- src/render/meshHexLayer.ts` (uncommitted change
discarded). This `phase-7-iter-1.md` retained as learning artefact.

## Risks

- Pan-back UX: 10 ms fetch latency on re-visit = brief gap. With LRU 24
  and visible 12, only chunks evicted long ago (24 chunks crossed since
  last visit) re-fetch. Bench harness pans aggressively → may touch this.
- If pan storm benchmark FPS p95 drops below 90 fps gate, iter 2 is
  forced even if memory passed.

## Rollback plan

`git revert <iter-1-commit>` → restores CPU cache.

---

> END OF ITER 1 HYPOTHESIS
