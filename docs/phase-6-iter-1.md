# Phase 6 — Iter 1 hypothesis & fix

> Iteration: **1 of 3**
> Trigger: Phase 6.5 initial benchmark `bench-results/phase-6-final.json` failed 4 of 8 gates
> Date: 2026-04-26

---

## Failures (verbatim from initial bench)

```
✗  tier_switch_50to25_under_50ms                         65.3 ms (target: < 50 ms)
✗  tier_switch_25to10_under_80ms                          657 ms (target: < 80 ms)
✗  memory_peak_under_250mb                                785 MB (target: < 250 MB)
✗  chunk_build_p95_under_8ms                     0 ms (max 0 ms) (target: < 8 ms)
```

## Diagnosis

**Memory (785 MB)** is the largest gap (3× over). Hypothesis: chunks built
across scenarios 1–3 (pan storm + pinch zoom + pan world) accumulate without
eviction. With wrap × 3 enabled for 10 km (D-6 extension), pan-around-world
60 s touches all 32 logical chunks × 3 offsets = 96 chunk-instances. Each at
~39 K particles ≈ 200 B/particle (Pixi v8 Particle object) → 96 × 39 K × 200 B
= ~750 MB. **Matches measured 785 MB exactly.**

Architecture doc § 14 worst-case calc only modeled "peak at one moment"
(24 instances), not "cumulative across world-pan", which D-4 lazy-build
permits to grow unbounded.

**tier-switch 25→10 (657 ms)** has a different root cause — see iter 2 if
this iter passes memory but not tier-switch. Triage: memory is acceptance-
critical; tier-switch is UX-critical. Fix memory first.

**chunk-build = 0 ms** is an instrumentation bug, not a perf issue:
`benchmark.reset()` at start of each scenario clears `chunkBuildBuf` along
with `fpsBuf`. By final scenario, no chunks built (all cached) → empty
buffer. Trivial fix; bundled with iter 1 as a non-iter bug-fix.

## ONE specific fix

**LRU eviction of chunk GPU resources, capped at 24 built chunk-instances.**

Why 24: matches arch § 14 worst-case (12 visible × 2 wrap copies straddling
seam). Always satisfies "currently visible" set + small warm cache for
re-entry.

### Implementation plan

`src/render/hexLayer.ts`:

1. Add `private builtOrder: ChunkEntry[]` queue (insert at end on build).
2. After `buildChunkOffset` succeeds, if `builtOrder.length > MAX_BUILT`,
   pop oldest entries until back at MAX_BUILT. For each popped entry: only
   evict if NOT in current `visibleSet` (never evict actively-rendered
   chunks). If all entries are visible, accept transient over-cap.
3. Eviction = `chunk.particlesByOffset.get(offsetX)?.destroy({children:true})`
   + `chunk.bordersByOffset.get(offsetX)?.destroy()` + delete from all 3 Maps.
4. Re-entry of evicted chunk triggers fresh `buildChunkOffset` (same code
   path — no new state needed).

`src/render/benchmark.ts`:

5. `reset()` keeps `chunkBuildBuf` (only clears fpsBuf + visibleBuf).

`scripts/bench-phase6.ts`:

6. Sample `memoryMb` per scenario via `performance.memory.usedJSHeapSize`.
   Track per-scenario `memory_max` in result JSON (currently only cumulative).

## Predicted post-iter-1 outcome

| Gate                                 | Pre-iter-1   | Predicted post-iter-1                        |
|--------------------------------------|--------------|----------------------------------------------|
| memory_peak_under_250mb              | 785 MB ✗     | ~150 MB ✓ (24 instances × 39K × 200B = 187MB)|
| chunk_build_p95_under_8ms            | 0 (bug) ✗    | populated; expect p95 ≈ 5–10 ms ?            |
| tier_switch_25to10_under_80ms        | 657 ms ✗     | unchanged ✗ — tier-switch root cause untouched |
| tier_switch_50to25_under_50ms        | 65.3 ms ✗    | unchanged ✗                                  |
| pan_storm_10km_fps_p95_ge_58         | 140.8 fps ✓  | ✓ (eviction adds <1ms/eviction)              |
| pinch_zoom_fps_p95_ge_55             | 126.6 fps ✓  | ✓                                            |
| visible_chunks_max_le_12_at_10km     | 12 ✓         | ✓                                            |
| antimeridian_pan_10km_fps_p95_ge_58  | 140.8 fps ✓  | ✓                                            |

If memory passes → progress. tier-switch likely needs iter 2.
If memory still fails → real leak (re-investigate; do NOT proceed).

## Risks of this fix

- LRU eviction destroys ParticleContainers; re-entry pays full build cost
  (~10 ms per chunk per arch budget). User panning slowly across world will
  see continuous 10ms hits per new chunk → may dent FPS.
- Mitigated by 24-cap being generous: only thrashes if user pans through
  > 24 distinct (chunk, offset) within seconds.

## Rollback plan

Single file revert: `git revert <iter-1-commit>` → restores unbounded warm
cache (passes FPS, fails memory).

---

> END OF ITER 1 HYPOTHESIS
