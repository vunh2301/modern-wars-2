# Phase 8: Worker Pool Foundation + Decode Worker

> Build worker infrastructure foundation cho cả compute pipeline future.
> Decode worker là first user — pathfinding/AI workers Phase 9+ dùng cùng pool.
>
> Repo: vunh2301/modern-wars-2
> Branch: phase-8-worker-pool (off main, AFTER current state merge)
> Owner: Claude Code Sonnet 4.6 + Claude Opus 4.7 reviewer
> Estimated effort: 14-18h

---

## Context — why broad scope

Phase 7 + 7.9 đã pass tất cả gates với numbers excellent:
- FPS p95 140.8
- tier-switch 25→10: 0.1ms
- memory_settled 275MB (<300)
- memory_peak 473MB (<700 info-only)
- chunk-build p95 1.9ms

Memory peak gate đã relax từ <250 → <700 (info-only). Phase 8 KHÔNG còn
mục đích đóng gate — gate đã đóng. Phase 8 mục đích THẬT là:

**Build worker pool infrastructure cho gameplay future.**

Justin đã confirm gameplay scope: **RTS world war, AI vs AI vs Player,
200 sides chiến đấu cùng lúc**.

Compute load estimate:
- 200 sides × 4 ticks/sec = 800 AI decisions/sec
- ~400 pathfinds/sec worst case
- Pathfinding 1.25M hex grid: 5-10ms/call on main thread
- → 2800ms compute/sec needed → IMPOSSIBLE on main thread

Worker pool là **architectural requirement**, không phải optimization.

Decode worker là first concrete user. Pathfinding worker (Phase 9) +
AI worker (Phase 9) + Combat resolver worker (Phase 10+) sẽ dùng
cùng pool architecture.

---

## Mission

Build production-grade worker pool foundation reusable cho 5+ worker
types future. Migrate chunk decode (current main-thread implementation
in src/data/chunks.ts) sang first worker user.

### Hard goals

1. Worker pool infrastructure with typed message protocol
2. Decode worker fully migrate (replace current main-thread decode path)
3. Foundation interfaces ready cho pathfinding/AI workers (Phase 9 implements)
4. Memory: settled <= current 275MB ±10%, peak < 500MB
5. Performance: FPS p95 ≥ 140 (no regression vs current)
6. Latency: postMessage roundtrip < 5ms p95
7. Backward compat: ?worker=off URL param fallback to main-thread decode

### Soft goals

- Worker bundle < 50KB gzipped
- Cold boot worker pool init < 200ms (one-time cost)
- Zero memory leak after 60s pan storm + 100 chunk evictions
- Cancellation semantics work correctly (viewport moves out of range mid-fetch)

### Non-goals (Phase 9+ scope)

- Pathfinding implementation (only interface stubs)
- AI logic implementation (only interface stubs)
- Combat resolution (out of scope entirely)
- Procedural content generation

---

## Architecture decisions (LOCKED)

### A. Worker pool size

4 workers fixed pool. Reasoning:
- iPhone 16 Pro Max A18: 6 performance cores + 4 efficiency cores
- Browser limits ~10 concurrent workers/origin
- 4 workers = headroom for: decode + pathfinding + AI + combat
- Round-robin job assignment, no preemption

Pool size configurable via URL `?workers=N` for benchmark, default 4.

### B. Job types via discriminated union

src/workers/types.ts:

```ts
export type WorkerJob =
  | { type: 'decode-chunk'; id: string; tier: string; col: number; row: number }
  | { type: 'pathfind'; id: string; ... }      // Phase 9 stub
  | { type: 'ai-tick'; id: string; ... }       // Phase 9 stub
  | { type: 'combat'; id: string; ... };       // Phase 10+ stub

export type WorkerResult =
  | { type: 'decode-chunk'; id: string; ok: true; vertices: ArrayBuffer; ... }
  | { type: 'decode-chunk'; id: string; ok: false; error: string }
  | { type: 'pathfind'; id: string; ok: true; path: number[] }
  | ...;
```

Phase 8 implement decode-chunk only. Phase 9/10 add other types.

### C. Job dispatcher pattern

```ts
class WorkerPool {
  dispatch<T extends WorkerJob>(job: T): Promise<WorkerResult>;
  cancel(jobId: string): void;
  destroy(): void;
}
```

Round-robin worker assignment. Cancellation via main-side ID tracking
(workers complete but result discarded).

### D. Transferable buffer ownership

CRITICAL rule lock: ArrayBuffers in postMessage second arg are
TRANSFERRED, not copied. Worker must use slice() to create owned
buffers before transfer.

Helper utility:

```ts
function transferBuffers(payload: WorkerResult): ArrayBuffer[] {
  // extract all ArrayBuffer fields automatically
}
```

Reviewer checklist enforce.

### E. Fallback strategy

Detection at module init:
- Worker support: typeof Worker !== 'undefined'
- DecompressionStream: typeof DecompressionStream !== 'undefined'

If either missing OR ?worker=off URL param:
- Fallback to main-thread decode path (current Phase 7.9 implementation)
- Log warning, no error

### F. Module structure

```
src/workers/
├── pool.ts                   # WorkerPool class (~200 lines)
├── types.ts                  # discriminated union types (~80 lines)
├── transferUtils.ts          # ArrayBuffer extraction helpers (~40 lines)
├── decoder.worker.ts         # Decode worker entry (~150 lines)
├── decoder.ts                # Main-thread decode helpers (parser logic)
└── stubs.ts                  # Phase 9/10 worker stubs (interface only)

src/data/chunks.ts modified to delegate to pool.
```

### G. KHÔNG xóa Phase 7.9 main-thread path

Main-thread decode kept as fallback. Switchable via:
- ?worker=on (default) → use pool
- ?worker=off → main-thread (Phase 7.9 path)

Insurance + A/B benchmark capability.

---

## Implementation phases

### Phase 8.0: Architecture review (mandatory, ~2h)

Read files:
- src/data/chunks.ts (current main-thread decode)
- src/data/manifest.ts
- src/render/meshHexLayer.ts (consumer that won't change)
- docs/phase-7-retro.md (Phase 7 lessons)
- docs/phase-7-architecture.md (current architecture)
- docs/COORDINATE_SYSTEM.md (DO NOT violate)

Write docs/phase-8-architecture.md (400-600 lines):

1. Current Phase 7.9 main-thread decode pipeline diagram (ASCII)
2. Phase 8 worker pool pipeline diagram (ASCII)
3. Worker pool design:
   - Pool size rationale
   - Job dispatch flow
   - Round-robin selection
   - Cancellation semantics
4. Discriminated union message protocol:
   - All current job types (decode-chunk only)
   - Stub interfaces for Phase 9 (pathfind, ai-tick)
   - Stub interfaces for Phase 10+ (combat)
5. Transferable buffer rules:
   - Why slice() before transfer
   - Helper function design
   - Common mistakes catalog
6. Backpressure & cancellation:
   - Job queue management
   - In-flight tracking
   - LRU eviction interaction
7. Fallback strategy:
   - Detection logic
   - URL param override
   - Warning UX
8. Memory model:
   - Worker heap vs main heap
   - GC implications
   - Cumulative memory math
9. Migration path:
   - src/data/chunks.ts before/after
   - Backward compat guarantee
   - Test strategy
10. Risks + mitigation table
11. Phase 9 readiness check:
    - Pathfinding worker stub interface
    - AI worker stub interface
    - Pool capacity check (4 workers enough for 4+ types?)

Self-review checklist:
- [ ] Transferable rule documented with examples?
- [ ] Worker error propagation defined?
- [ ] Pool destroy releases all workers?
- [ ] Cancellation doesn't leak job queue?
- [ ] Bundle size accounts for worker chunk?
- [ ] Stub interfaces minimal but enough for Phase 9?

Stop and ask Justin if uncertain about scope — don't guess.

### Phase 8.1: Pool foundation (~3h)

- src/workers/types.ts — discriminated union types + stubs
- src/workers/pool.ts — WorkerPool class
  - Pool initialization (lazy spawn)
  - Round-robin dispatch
  - Job ID tracking
  - Cancellation via ID set
  - Destroy method
- src/workers/transferUtils.ts — extractTransferables() helper
- Unit test: spawn pool, dispatch 5 mock jobs, verify all complete + correct routing

### Phase 8.2: Decode worker (~3h)

- src/workers/decoder.worker.ts — worker entry
  - Listen for 'decode-chunk' jobs
  - fetch + DecompressionStream + parse logic (move from chunks.ts)
  - slice() buffers before transfer
  - postMessage with transfer list
  - Error handling
- src/workers/decoder.ts — extract pure parse helpers
  (used by both worker AND main-thread fallback)
- Vite config verify: worker imports work

### Phase 8.3: ChunkCache integration (~2h)

src/data/chunks.ts refactor:
- Detect worker support at module init
- If supported AND ?worker !== 'off': delegate to WorkerPool.dispatch
- Else: use main-thread decoder.ts directly
- Public API (loadChunk) unchanged
- Cancellation: when chunk evicted from LRU before load completes,
  call pool.cancel(jobId)

### Phase 8.4: Worker stubs for Phase 9 (~1h)

src/workers/stubs.ts:

```ts
// Phase 9 will implement these. Phase 8 only defines interfaces +
// stub workers that throw "not implemented".

export interface PathfindRequest {
  type: 'pathfind';
  id: string;
  startQ: number; startR: number;
  goalQ: number; goalR: number;
  tierKm: number;
  // ... future fields
}

export interface PathfindResult {
  type: 'pathfind';
  id: string;
  ok: boolean;
  path?: Array<[number, number]>;
  error?: string;
}

// Stub worker that returns "not implemented" error.
// Phase 9 will replace with real implementation.
```

Why include stubs in Phase 8: lock interface contracts now, Phase 9
implementer (could be Claude Code or Justin) doesn't need to design
contracts under pressure.

### Phase 8.5: Memory + performance instrumentation (~1h)

Extend HUD:
- Worker pool stats: "workers: 4 | active: 2 | queue: 0"
- Per-worker job count: "[w0:128 w1:127 w2:128 w3:127]"
- postMessage latency p95
- Decode mode indicator: "decode: worker" or "decode: main"

window.__mwBenchmark() returns extended metrics:

```ts
{
  ...existing fields,
  worker: {
    poolSize: 4,
    totalJobs: number,
    avgLatencyMs: number,
    p95LatencyMs: number,
    activeJobs: number,
    queueDepth: number,
  }
}
```

### Phase 8.6: Benchmark + regression test (~2h)

scripts/bench-phase8.ts runs:
1. Pan storm 30s @ 10km — FPS p95, memory peak/settled
2. Pinch zoom storm 60s — FPS p95
3. Antimeridian wrap pan 60s — FPS p95
4. Worker latency stress: dispatch 1000 decode jobs back-to-back

Compare against Phase 7.9 baseline (saved bench-results/phase-7-final.json).

REQUIRE: no metric regresses by > 5%. New metric (worker latency p95)
must be < 5ms.

### Phase 8.7: Self-correction loop (max 2 iterations)

Same structure as Phase 6/7. Likely candidates if fail:
- Iter 1: Adjust worker pool size (3 vs 4 vs 5)
- Iter 2: Reduce worker bundle (lazy import worker code, smaller postMessage payload)

Stop after iter 2.

---

## Constraints

1. NO breaking changes to:
   - src/geo/wrap.ts (coordinate contract)
   - docs/COORDINATE_SYSTEM.md
   - public API of src/data/chunks.ts (loadChunk signature unchanged)
2. NO new runtime dependencies. Pixi v8 + native APIs only.
3. NO gameplay code. Stubs only — no logic implementation.
4. TypeScript strict mode.
5. A/B switch required: ?worker=on (default) | ?worker=off (Phase 7.9 fallback).
6. Phase 7.9 main-thread decode path stays fully functional.
7. Worker bundle < 50KB gzipped.
8. Stop and ask Justin if architectural decision needed beyond locked Section A-G.

---

## Reviewer checklists

### A. Pool correctness
- [ ] Pool destroy releases all workers (no orphan threads)?
- [ ] Worker errors propagate to main thread?
- [ ] No worker spawn race conditions on init?
- [ ] postMessage payload validated on main thread?
- [ ] Round-robin assignment works under concurrent load?

### B. Transferable ownership
- [ ] All ArrayBuffers in transfer list match payload references?
- [ ] No detached buffer access after transfer?
- [ ] slice() used before transfer to avoid detaching parent?
- [ ] Worker doesn't reuse transferred buffers?
- [ ] extractTransferables() helper correct for all message types?

### C. Memory & lifecycle
- [ ] Settled memory <= current 275MB ±10%?
- [ ] Peak memory < 500MB?
- [ ] Worker pool destroy releases all worker threads?
- [ ] Cancelled jobs don't leak in queue?
- [ ] No memory growth across 100 chunk evictions?

### D. Performance
- [ ] postMessage roundtrip p95 < 5ms?
- [ ] FPS p95 ≥ 140 (no regression)?
- [ ] tier-switch p95 < 5ms?
- [ ] chunk-build p95 < 5ms?

### E. Fallback compat
- [ ] Detection logic correct (Worker + DecompressionStream)?
- [ ] ?worker=off forces main-thread path?
- [ ] No crash on unsupported environment?
- [ ] HUD displays current decode mode?
- [ ] Phase 7.9 path 100% identical behavior when ?worker=off?

### F. Phase 9 readiness
- [ ] Pathfinding stub interface complete?
- [ ] AI stub interface complete?
- [ ] Pool can dispatch new job types without code change?
- [ ] Discriminated union exhaustive check (TS compile error if new type added without handler)?

If ANY checkbox fails → block commit, fix, retry.

---

## Self-loop budget

| Phase | Budget |
|---|---:|
| 8.0 architecture review + self-review | 2h |
| 8.1 pool foundation | 3h |
| 8.2 decode worker | 3h |
| 8.3 ChunkCache integration | 2h |
| 8.4 stubs for Phase 9 | 1h |
| 8.5 instrumentation | 1h |
| 8.6 benchmark | 2h |
| 8.7 iter 1 | 1.5h |
| 8.7 iter 2 | 1.5h |
| Total max | 17h |

Stop after iter 2 — don't push iter 3.

---

## Output artifacts

```
docs/
├── phase-8-architecture.md       # 8.0 output
├── phase-8-iter-1.md              # if needed
├── phase-8-iter-2.md              # if needed
└── phase-8-retro.md               # final retrospective

src/workers/                      # NEW directory
├── pool.ts                       # ~200 lines
├── types.ts                      # ~80 lines
├── transferUtils.ts              # ~40 lines
├── decoder.worker.ts             # ~150 lines
├── decoder.ts                    # ~100 lines (extracted)
└── stubs.ts                      # ~80 lines

src/data/
└── chunks.ts                     # MODIFIED, public API unchanged

scripts/
└── bench-phase8.ts               # NEW

bench-results/
└── phase-8-final.json            # benchmark output
```

---

## Begin

Start với Phase 8.0 architecture review. Do not write code until 8.0
doc reviewed (self-reviewed if no human reviewer available).

REQUIRE Phase 7.9 polish merged to main BEFORE starting Phase 8.

When uncertain about scope or design — STOP AND ASK JUSTIN. Don't guess.

If a metric fails after iter 2 — STOP AND REPORT. Don't infinite loop.

Phase 8 success = foundation ready for Phase 9 to plug in pathfinding
and AI workers without infrastructure rework.

Good luck.
