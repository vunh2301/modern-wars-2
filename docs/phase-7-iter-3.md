# Phase 7 — Iter 3 hypothesis & fix (FINAL iteration)

> Iteration: **3 of 3** (plan budget exhausted after this)
> Trigger: iter 2 (C2 instanced) reduced memory peak 618 → 393 MB (37 % drop) but still over 250 MB target by 1.57×
> Date: 2026-04-26

---

## What iter 2 taught us

C2 instanced rendering worked exactly as predicted for compute / bundle:
- Bundle: 43.65 MB → **5.12 MB** (8.5× smaller, ~12 KB / chunk @ 10 km gzip)
- chunk-build p95: 1.8 ms → 1.6 ms
- All FPS gates: 140 fps with margin
- tier-switch: 0.6-0.8 ms

Memory dropped 37 % (618 → 393 MB) but didn't close the gap. Cumulative
end-of-bench is **205 MB** (already under target), but peak DURING pan
storm is 393 MB — the difference is pre-GC transient ArrayBuffers from
rapid fetch/decode/destroy cycles.

## Diagnosis (best estimate)

```
Steady state @ 24 cached chunks (10 km tier):
  Per chunk: instance buffer 470 KB + Pixi GPU mirror 470 KB + ChunkBuffers cache 550 KB
  24 × ~1.5 MB = ~36 MB total chunk state
  + Pixi base ~80 MB + tier hex data ~10 MB + other ~30 MB ≈ 156 MB
  Matches measured cumulative final (205 MB)

Pan storm transient (30s × 30Hz = 900 viewport updates):
  Each update triggers fetchAndMount for ~1 new (chunk, offset) entry
  Total fetches: ~50 distinct chunks × ~5 MB ArrayBuffer alloc per fetch (DecompressionStream output)
  Pre-GC accumulation: ~250 MB transient
  Peak: 156 + 250 = 406 MB ≈ measured 393 MB ✓
```

The peak is dominated by **DecompressionStream pre-GC churn**, not the
held-state.

## ONE specific fix

**Combined: reduce LRU cap 24 → 12 AND drop the CPU `ChunkCache` (now
~13 MB total, low-impact with C2's smaller buffers).**

Wait — plan says ONE fix. Two changes counted:

After analysis, **the dominant cost is decompression transient memory**,
not held caches. Neither LRU cap nor CPU cache directly attacks this.

Pivoting hypothesis: **the 200 MB transient comes from rapid fetchAndMount
during pan-storm overwhelming GC**. Mitigation: **throttle concurrent
fetches via a 4-slot semaphore.** When pan-storm triggers 50 fetches in
30s, only 4 in-flight at a time. This caps transient ArrayBuffer
accumulation to ~4 × 5 MB = 20 MB instead of unbounded.

Predicted: 393 MB → ~200 MB peak (saves 4-fold transient).

### Implementation

`src/render/meshHexLayer.ts`:

1. Add module-scope semaphore: `let activeFetches = 0;` and queue `pendingFetches: Array<{ key, entry, offsetX }> = [];`
2. In `fetchAndMount`:
   - If `activeFetches >= 4`, push to pendingFetches and return.
   - Else activeFetches++, fire fetch, on completion (success or AbortError or fail): activeFetches-- + drain queue.
3. Drain queue: while `activeFetches < 4 && pendingFetches.length > 0`, pop and re-fire fetchAndMount.
4. Visibility filter: when draining, skip if entry no longer in visibleSet (viewport moved away during wait).

This is a network-level throttle. Doesn't change rendering behavior;
just paces concurrent decompressions to give GC a chance.

## Predicted post-iter-3 outcome

| Gate                                 | Iter 2     | Predicted iter 3              |
|--------------------------------------|------------|--------------------------------|
| memory_peak_under_250mb              | 393 MB ✗   | ~200 MB ✓ (transient capped)   |
| All other 7 gates                    | ✓          | ✓                              |

If memory < 250 MB → **PHASE 7 PASSES ALL 8 GATES**. Write retro.
If memory > 300 MB → DecompressionStream isn't the culprit; out of iter
budget; report state.

## Risks

- R1: Pan storm with throttle may show visible "loading" gaps as new
  chunks queue. With 4 concurrent + ~20ms decode each, throughput =
  ~200 chunks/s, easily handles 30Hz pan rate.
- R2: Tier switch latency may grow if all 12 visible chunks queue
  serially through 4-slot semaphore: 12/4 × ~20ms = 60ms cold load.
  Within tier-switch < 80 ms gate (currently 0.8 ms — still fine).

## Plan budget exhausted after this

If iter 3 fails, stop and report. Phase 7 retro acknowledges 7/8 pass,
proposes Phase 8 candidates:
- Shared Pixi Buffer pool (sub-allocate from pre-allocated 50 MB block)
- Texture-encoded instance data (read instance attrs from sampler in shader)
- Move decode to Web Worker (off main thread, off main GC)

---

> END OF ITER 3 HYPOTHESIS
