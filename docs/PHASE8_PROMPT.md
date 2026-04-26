# Phase 8: Worker Pool Foundation + Decode Worker

> Build worker infrastructure foundation cho cả compute pipeline future.
> Decode worker là first user — pathfinding/AI workers Phase 9+ dùng cùng pool.
>
> Repo: vunh2301/modern-wars-2
> Branch: phase-8-worker-pool (off main, AFTER current state merge)
> Owner: Claude Code Sonnet 4.6 + Claude Opus 4.7 reviewer
> Estimated effort: 14-18h
> Spec rev: 2 (post-Opus + Codex review, score 9.5+ targeted)

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

## Architecture decisions (LOCKED — rev 2)

### A. Worker pool size + dispatch strategy

**Default pool size = 4 workers, configurable via `?workers=N`.**

Rationale (rev 2 corrected facts):
- **iPhone 16 Pro Max A18 Pro CPU = 2 performance + 4 efficiency cores** (per Apple Newsroom).
  Earlier draft incorrectly said 6P+4E.
- Browser limits ~10 concurrent DedicatedWorkers/origin.
- 4 workers covers typical gameplay concurrency (decode + pathfind burst + AI tick) without
  oversubscribing efficiency cores. Phase 8.7 iter 1 may tune to 3 if FPS regresses.
- Pool size kept independent of "worker types": all workers handle ANY job type. Dispatch
  strategy decides assignment (see below).

**Dispatch strategy = Round-robin in Phase 8 (simplification).**
- Phase 8 only has decode-chunk jobs → no head-of-line blocking risk.
- Phase 9 MUST revisit: with 400 pathfinds/sec + decode mixing on same workers, round-robin
  would starve decode behind queued pathfinds.
- **WorkerPool API does NOT expose round-robin internally.** Constructor accepts
  `dispatchStrategy` callback (default round-robin). Phase 9 swaps to
  priority-queue or affinity strategy without changing call sites.

```ts
type DispatchStrategy = (workers: WorkerSlot[], job: WorkerJob) => number; // returns worker index
```

**Acknowledged Phase 9 requirement (in risks table below):** dispatch strategy must support
priority/affinity. Phase 8 leaves the seam.

### B. Job types via discriminated union + exhaustive check

**Compile-time exhaustiveness is REQUIRED, not just checklist.**

src/workers/types.ts:

```ts
import type { ChunkManifestEntry } from '../data/chunks';

// ─── Job request union ─────────────────────────────────────────────────────
export type WorkerJob =
  | DecodeChunkJob
  | CancelJob
  | PathfindJob       // Phase 9 stub (interface only, worker throws "not impl")
  | AiTickJob         // Phase 9 stub
  | CombatJob;        // Phase 10+ stub

// Phase 8 IMPLEMENTS these two:
export interface DecodeChunkJob {
  type: 'decode-chunk';
  id: string;
  // FULL manifest entry — needed for fetch URL (entry.file), validation
  // (entry.hexCount), and bbox-based downstream work. NOT just (tier, col, row).
  entry: ChunkManifestEntry;
  tier: string;          // tierName, used for cacheKey on main thread
}

export interface CancelJob {
  type: 'cancel';
  id: string;            // job id this cancel targets
  targetId: string;      // id of job to cancel
}

// Phase 9 STUBS (interface locked, worker returns 'not-implemented' error):
export interface PathfindJob {
  type: 'pathfind';
  id: string;
  startQ: number; startR: number;
  goalQ: number;  goalR: number;
  tierKm: number;        // per COORDINATE_SYSTEM.md invariant 1
  maxIterations?: number;
  worldVersion: number;  // optimistic concurrency token
  priority?: 'low' | 'normal' | 'high';
}

export interface AiTickJob {
  type: 'ai-tick';
  id: string;
  sideId: number;
  worldVersion: number;
}

export interface CombatJob {
  type: 'combat';
  id: string;
  worldVersion: number;
}

// ─── Result union ──────────────────────────────────────────────────────────
export type WorkerResult =
  | DecodeChunkResult
  | PathfindResult
  | AiTickResult
  | CombatResult;

// Decode-chunk SUCCESS shape MUST match ChunkBuffers' typed-array fields
// (Pixi consumer expects Uint8Array/Uint32Array/Float32Array, NOT raw ArrayBuffer).
// We transfer the underlying ArrayBuffers and reconstruct typed views on main.
export type DecodeChunkResult =
  | {
      type: 'decode-chunk';
      id: string;
      ok: true;
      // 4 separate ArrayBuffers (one per ChunkBuffers typed-array field).
      // Transferred via postMessage second-arg list.
      templateBuffer: ArrayBuffer;   // → Uint8Array on main
      instanceBuffer: ArrayBuffer;   // → Uint8Array
      indexBuffer: ArrayBuffer;      // → Uint32Array
      edgeBuffer: ArrayBuffer;       // → Float32Array
      hexCount: number;
      edgeCount: number;
      bbox: { minX: number; minY: number; maxX: number; maxY: number };
      centroid: { x: number; y: number };
      tierSizeKm: number;
      col: number;
      row: number;
    }
  | {
      type: 'decode-chunk';
      id: string;
      ok: false;
      error: string;       // human-readable message
      errorName: string;   // 'AbortError' | 'NetworkError' | 'ParseError'
    };

export type PathfindResult =
  | { type: 'pathfind'; id: string; ok: true; pathBuffer: ArrayBuffer; pathLen: number }  // SoA: 2*pathLen Int16Array packed [q0,r0,q1,r1...]
  | { type: 'pathfind'; id: string; ok: false; error: string; errorName: string };
export type AiTickResult =
  | { type: 'ai-tick'; id: string; ok: true; commands: ArrayBuffer }   // SoA payload
  | { type: 'ai-tick'; id: string; ok: false; error: string; errorName: string };
export type CombatResult =
  | { type: 'combat'; id: string; ok: true }
  | { type: 'combat'; id: string; ok: false; error: string; errorName: string };

// ─── Type-level mapping for sound dispatch ──────────────────────────────────
export type ResultFor<TType extends WorkerJob['type']> = Extract<WorkerResult, { type: TType }>;

// ─── Exhaustiveness helper ──────────────────────────────────────────────────
export function assertNever(x: never, ctx: string): never {
  throw new Error(`[worker] non-exhaustive switch in ${ctx}: ${JSON.stringify(x)}`);
}
```

**Pathfind result design note:** `Array<[number, number]>` would allocate 2 objects per
node × ~100 nodes/path × 400 paths/sec = 80k garbage objects/sec. Use packed `Int16Array`
buffer transferred zero-copy. Phase 9 implements; Phase 8 only locks the interface shape.

### C. Job dispatcher pattern + cancellation protocol

```ts
// src/workers/pool.ts
export interface WorkerPoolOptions {
  size?: number;                     // default 4
  lazy?: boolean;                    // default true (spawn on first dispatch)
  dispatchStrategy?: DispatchStrategy;
  maxQueueDepth?: number;            // default 2 × size
  workerUrl?: URL;                   // injectable for tests
}

export class WorkerPool {
  constructor(opts?: WorkerPoolOptions);
  /** Sound dispatch: result type narrowed by job.type. */
  dispatch<TType extends WorkerJob['type']>(
    job: WorkerJob & { type: TType }
  ): Promise<ResultFor<TType>>;
  /** Cancel a pending or in-flight job. Sends 'cancel' message to assigned worker.
   * Pending: removed from queue, promise rejects with AbortError.
   * In-flight: worker's job-side cancel flag set; worker forwards to internal fetch().
   * Result discarded on completion. */
  cancel(jobId: string): void;
  /** Eager init for cold-start avoidance. */
  warmup(): Promise<void>;
  destroy(): void;
}
```

**Cancellation protocol (REPLACES vague "main-side ID tracking" of rev 1):**

1. Main: `pool.cancel(id)` → sends `{ type: 'cancel', targetId: id }` postMessage to
   the worker assigned to that job (lookup via internal Map).
2. Worker (decode-chunk handler): receives cancel, looks up its own AbortController for
   that targetId, calls `controller.abort()`. Internal `fetch()` aborts. Post a
   `decode-chunk` result with `ok: false, errorName: 'AbortError'`.
3. Pending jobs (not yet dispatched): removed from queue immediately, promise rejects
   with `DOMException('Aborted', 'AbortError')` (matches current chunks.ts semantics
   that meshHexLayer.ts:317 catches).
4. Edge: cancel arrives after worker already posted result → main sees result first,
   ignores subsequent cancel ack.

**Queue backpressure:**
- `maxQueueDepth = 2 × poolSize` (default 8).
- Dispatch when queue full → reject immediately with `{ ok: false, errorName: 'QueueFullError' }`.
- Caller (chunks.ts) treats as soft fail — chunk re-requested on next `updateVisibility`
  frame if still visible.

### D. Transferable buffer ownership (precise shape)

**Critical lock:** ArrayBuffers in postMessage second arg are **transferred** (move
semantics, not copy). After transfer, sender's reference becomes a detached buffer (any
read = TypeError).

**For DecodeChunkResult specifically:**
1. Worker calls `parseChunkBinary(arrayBuffer, entry)` (SAME pure function as main-thread
   path — see migration §G). Parser already calls `.slice()` on each typed-array view to
   create independent backing ArrayBuffers (chunks.ts:143-159).
2. Worker collects the 4 ArrayBuffers via `extractDecodeChunkTransferables(result)` helper
   and posts: `self.postMessage(result, transferList)`.
3. Main receives result, wraps each ArrayBuffer in matching typed view:
   ```ts
   const buffers: ChunkBuffers = {
     templateBuffer: new Uint8Array(result.templateBuffer),
     instanceBuffer: new Uint8Array(result.instanceBuffer),
     indexBuffer: new Uint32Array(result.indexBuffer),
     edgeBuffer: new Float32Array(result.edgeBuffer),
     // ...meta fields direct copy
   };
   ```

**Helper utility (src/workers/transferUtils.ts):**

```ts
export function extractDecodeChunkTransferables(r: DecodeChunkResult): ArrayBuffer[] {
  if (!r.ok) return [];
  // Order matters? No — postMessage transferList is a Set semantically. But dedupe
  // (same ArrayBuffer transferred twice = TypeError).
  const seen = new Set<ArrayBuffer>();
  const out: ArrayBuffer[] = [];
  for (const b of [r.templateBuffer, r.instanceBuffer, r.indexBuffer, r.edgeBuffer]) {
    if (!seen.has(b)) { seen.add(b); out.push(b); }
  }
  return out;
}

// Generic dispatch by result type.
export function extractTransferables(r: WorkerResult): ArrayBuffer[] {
  switch (r.type) {
    case 'decode-chunk': return extractDecodeChunkTransferables(r);
    case 'pathfind':     return r.ok ? [r.pathBuffer] : [];
    case 'ai-tick':      return r.ok ? [r.commands] : [];
    case 'combat':       return [];
    default: assertNever(r, 'extractTransferables');
  }
}
```

**Common mistakes catalog (must appear in phase-8-architecture.md):**
1. **Double-slice waste** — `parseChunkBinary` already slices; do NOT slice again before transfer.
2. **Post-transfer access** — worker logs `result.templateBuffer.byteLength` AFTER
   postMessage → TypeError (detached buffer).
3. **Forgetting transfer list** — message goes through structured clone (deep copy) instead
   of zero-copy transfer. Bench will show 2× memory + slow postMessage.
4. **Subview transfer detaches parent** — if you ever transfer `view.buffer` where view is
   a SUBVIEW of a larger buffer, ALL views into that buffer detach. Per parser current
   contract (Phase 7.9 `.slice()`), each view owns its buffer → safe.
5. **Double-transfer** — listing same ArrayBuffer twice in transferList = TypeError.
   Helper dedupes via Set.
6. **Worker reuse after transfer** — worker keeps reference to retry → access fails.
   Worker MUST treat post-transfer state as "result delivered, locals invalid".

### E. Fallback strategy + detection

**Detection runs BOTH on main thread (module init) AND inside worker (handshake):**

```ts
// src/data/chunks.ts module init (runs in DOM context)
const supportsWorker = typeof Worker !== 'undefined' &&
                       typeof globalThis.location !== 'undefined'; // also guards Vitest/node import
const supportsDecompressionStream = typeof DecompressionStream !== 'undefined';

const urlOptOut = (() => {
  if (typeof globalThis.location === 'undefined') return false;
  return new URLSearchParams(globalThis.location.search).get('worker') === 'off';
})();

const useWorker = supportsWorker && supportsDecompressionStream && !urlOptOut;
```

**Worker-side handshake:** worker posts `{ type: 'ready', supportsDecompressionStream: boolean }`
on spawn. Pool waits for ready before dispatching. If worker reports
`supportsDecompressionStream: false`, pool falls back to main-thread decode for THAT
session and logs warning.

**Switch matrix:**
| Condition | Decode path |
|---|---|
| Default | Worker pool |
| `?worker=off` URL param | Main thread (Phase 7.9 path) |
| `typeof Worker === undefined` | Main thread |
| Worker `ready` reports no DecompressionStream | Main thread |
| `?worker=on` explicit + module supports | Worker pool |

**Coexistence with `?engine`:** `?worker` controls **decode path** (worker vs main-thread).
`?engine` controls **render path** (mesh vs particles, Phase 7 default mesh). Both
independent and orthogonal. Document both in main.ts comment header.

### F. Module structure

```
src/workers/
├── pool.ts                   # WorkerPool class (~250 lines)
├── types.ts                  # discriminated union + ResultFor + assertNever (~120 lines)
├── transferUtils.ts          # extractTransferables() helpers (~60 lines)
├── decoder.worker.ts         # Decode worker entry (~180 lines)
├── decoder.ts                # SHARED parse helpers (used by worker AND main fallback)
└── stubs.ts                  # Phase 9/10 worker stub handlers (~80 lines)

src/data/chunks.ts            # MODIFIED: delegates to pool, public API unchanged
```

Note (Opus LOW finding): `parseChunkBinary` is already pure in chunks.ts. To avoid worker
↔ chunks.ts circular import (chunks.ts imports pool, worker would import chunks.ts), we
EXTRACT `parseChunkBinary` + helpers to `src/workers/decoder.ts`. chunks.ts re-exports for
backward compat. Worker imports `decoder.ts` directly — NEVER `chunks.ts`.

### G. KHÔNG xóa Phase 7.9 main-thread path

Main-thread decode kept as fallback. Switchable via `?worker=on|off` (default `on`).
Main-thread path uses same `decoder.ts` parse helpers — single source of truth for parse
logic. Insurance + A/B benchmark capability.

### H. Vite worker config (LOCKED)

Vite 7 worker import pattern (verified for our setup):

```ts
// In src/data/chunks.ts (or wherever the pool spawns):
const workerUrl = new URL('../workers/decoder.worker.ts', import.meta.url);
const worker = new Worker(workerUrl, { type: 'module' });
```

**`vite.config.ts` REQUIRED additions:**

```ts
export default defineConfig({
  // ...existing
  worker: {
    format: 'es',                    // ESM worker output (browser-modern)
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].worker.js',
      },
    },
  },
});
```

**Constraints (failure modes documented):**
1. Worker entry MUST NOT import from `pixi.js` or `pixi-viewport` (would bloat worker
   bundle 500KB+). Build-time check: bench-phase8.ts asserts worker chunk gzip < 50KB.
2. Worker MUST NOT import `src/data/chunks.ts` (circular). Imports `src/workers/decoder.ts`
   only.
3. URL must be **relative** (not aliased) for Vite worker plugin detection.

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

Write docs/phase-8-architecture.md (500-700 lines):

1. Current Phase 7.9 main-thread decode pipeline diagram (ASCII)
2. Phase 8 worker pool pipeline diagram (ASCII) — show:
   - Main thread loadChunk → pool.dispatch
   - Worker fetch + decompress + parse → postMessage with transferList
   - Main thread typed-view reconstruction → cache + buildMesh
3. Worker pool design: pool size rationale (with corrected A18 facts), pluggable
   dispatch strategy interface, queue backpressure (`maxQueueDepth = 2× pool size`),
   warmup() vs lazy spawn.
4. Discriminated union message protocol — full code listing of types.ts (Phase 8
   IMPLEMENT decode-chunk + cancel; STUB pathfind/ai-tick/combat).
5. ResultFor<TType> mapped type + assertNever pattern usage examples.
6. Transferable buffer rules — Common Mistakes Catalog (1-6 above), worked example
   end-to-end for DecodeChunkResult.
7. Cancellation protocol — full sequence diagram (main cancel → worker abort → result
   ignored).
8. Fallback strategy — detection matrix table, handshake protocol.
9. Memory model — worker heap separate from main heap, performance.memory main-only,
   how to measure full-process peak (Chrome DevTools Performance > Memory).
10. Migration path — chunks.ts before/after diff (loadChunk signature unchanged,
    internal delegation only). decoder.ts extraction + re-export for backward compat.
11. Risks + mitigation table (must include Phase 9 dispatch strategy, A18 perf
    headroom, worker bundle bloat).
12. Phase 9 readiness check — pathfind/ai stub interfaces locked, pool seam for
    pluggable dispatch strategy ready, packed Int16Array path payload contract.
13. Vite worker import pattern + bundle-size assertion.

Self-review checklist (BLOCKER if any unchecked):
- [ ] Cancellation worker-side abort path documented?
- [ ] ResultFor<T> + assertNever enforced (no `default:` branch in type-safe switches)?
- [ ] Transferable common-mistake catalog covers parent-detach, double-transfer, post-transfer access?
- [ ] Pool destroy releases all workers (no orphan threads)?
- [ ] Cancellation doesn't leak job queue?
- [ ] Bundle size accounts for worker chunk?
- [ ] Stub interfaces use buffer-based payloads (not Array<[n,n]>) for hot paths?
- [ ] Dispatch strategy pluggable via constructor, NOT hardcoded round-robin in dispatch()?
- [ ] DecodeChunkJob carries full ChunkManifestEntry (not just col/row)?
- [ ] Vite worker import pattern + format: 'es' explicit?
- [ ] `?worker` and `?engine` coexistence documented?
- [ ] Module init guards `typeof globalThis.location !== 'undefined'` for non-DOM contexts (Vitest)?

Stop and ask Justin if uncertain about scope — don't guess.

### Phase 8.1: Pool foundation (~3h)

- src/workers/types.ts — full discriminated union + ResultFor + assertNever (per §B above)
- src/workers/pool.ts — WorkerPool class
  - Lazy spawn (default) + `warmup()` for eager init
  - Configurable dispatchStrategy (default round-robin)
  - Job ID → worker index map (for cancel routing)
  - Queue cap with QueueFullError rejection
  - Cancel protocol (sends `{type:'cancel'}` to assigned worker)
  - destroy(): terminate all workers, reject pending jobs
- src/workers/transferUtils.ts — extractTransferables() (per §D above)
- Unit test: spawn pool, dispatch 5 mock jobs (mock worker echoes), verify all complete +
  correct routing + cancel kills both pending and in-flight + queue cap rejects.

### Phase 8.2: Decode worker (~3h)

- src/workers/decoder.ts — extract `parseChunkBinary` + `loadAndParse` (fetch + decompress
  + parse) from chunks.ts. PURE functions (no side effects).
- src/workers/decoder.worker.ts — worker entry
  - Handshake: post `{ type: 'ready', supportsDecompressionStream }` on spawn.
  - Listen for `decode-chunk`: create AbortController, call decoder.ts, build
    DecodeChunkResult with 4 ArrayBuffers, postMessage(result, extractTransferables(...)).
  - Listen for `cancel`: lookup AbortController by targetId, call .abort().
  - Error handling: catch all → post `{ ok: false, error, errorName }`.
- Vite worker config (vite.config.ts updates per §H).
- Build assertion: bench-phase8.ts reads dist/assets/*.worker.js gzip size, fails if > 50KB.

### Phase 8.3: ChunkCache integration (~2h)

src/data/chunks.ts refactor:
- Detect worker support at module init (per §E).
- If `useWorker`: instantiate WorkerPool (singleton, lazy spawn), `loadChunk` delegates to
  `pool.dispatch({ type: 'decode-chunk', id, entry, tier: tierName })`. On result, wrap
  ArrayBuffers in typed views to match ChunkBuffers shape (per §D), return.
- Else: use main-thread decoder.ts directly (current Phase 7.9 path).
- Public API (`loadChunk(entry, signal?)` signature) unchanged. AbortError semantics
  preserved (signal triggers pool.cancel(jobId), promise rejects with DOMException).
- Cancellation: meshHexLayer.ts already passes signal — pool.cancel called via
  `signal.addEventListener('abort', () => pool.cancel(id))`.

### Phase 8.4: Worker stubs for Phase 9 (~1h)

src/workers/stubs.ts:

Stub handlers for `pathfind`, `ai-tick`, `combat` job types in decoder.worker.ts. Each
returns `{ ok: false, errorName: 'NotImplementedError', error: 'Phase 9 will implement' }`.
Phase 9 replaces these with real handlers — worker entry boilerplate (handshake, job
routing, cancel) stays unchanged.

Test: dispatch a pathfind job, expect NotImplementedError result. Verifies routing works.

### Phase 8.5: Memory + performance instrumentation (~1h)

Extend HUD (3 lines, ~80 chars wide):
- Line 4: `decode: worker(4) | active: 2 | queue: 0 | post p95: 1.8ms`
- HUD displays decode mode (`worker(N)` or `main`), active workers, queue depth, p95
  postMessage roundtrip latency (sampled main-thread perf.now between dispatch and result).

window.__mwBenchmark() returns extended metrics:

```ts
{
  ...existing fields,
  worker: {
    mode: 'worker' | 'main',
    poolSize: number,
    totalJobs: number,
    avgLatencyMs: number,
    p95LatencyMs: number,
    activeJobs: number,
    queueDepth: number,
    queueFullRejects: number,
    cancellations: number,
  }
}
```

**Worker memory caveat (must be in HUD comment + phase-8-architecture.md):**
`performance.memory` reads MAIN thread heap only. Worker heap is invisible. Total process
peak = main + Σ(worker heaps). For Chrome desktop bench: cross-check with DevTools
Performance > Memory tab (includes worker heaps). For iOS Safari: no API at all.

### Phase 8.6: Benchmark + regression test (~2h)

scripts/bench-phase8.ts runs:
1. Pan storm 30s @ 10km — FPS p95, memory peak/settled
2. Pinch zoom storm 60s — FPS p95
3. Antimeridian wrap pan 60s — FPS p95
4. Worker latency stress: dispatch 1000 decode jobs back-to-back, measure roundtrip p95
5. **A/B run:** all 4 scenarios with `?worker=on` (default) AND `?worker=off`. Compare.

Hard gates (rev 2 — resolve FPS contradiction):
- **FPS p95 ≥ 135** (was 140 — gives ~4% headroom from 140.8 baseline). Acknowledge
  worker postMessage overhead trade-off.
- tier-switch p95 < 5ms (cache hit path, no regression)
- chunk-build p95 < 5ms (no regression)
- postMessage roundtrip p95 < 5ms (worker latency hard gate)
- memory_settled < 300MB (Phase 7.9 baseline 275MB ±10% allowance)
- Worker bundle gzip < 50KB (built artifact assertion)
- A/B parity: `?worker=off` results match Phase 7.9 baseline ±2%

Soft (informational):
- memory_peak < 500MB (worker may shift peak from main to worker heap)
- queueFullRejects across all scenarios = 0 (capacity sized correctly)

REQUIRE: no hard gate regresses. New gates (worker latency, bundle size) must pass.

### Phase 8.7: Self-correction loop (max 2 iterations)

Likely candidates if fail (rev 2 — postMessage profiling FIRST):
- Iter 1: Profile postMessage overhead. If structured clone (not transfer) detected,
  audit transferList completeness. If GC churn from short-lived ArrayBuffers, batch
  transfers. Worker bundle audit — strip unused code paths.
- Iter 2: Pool size tune (3 vs 4 vs 5). Or: prefetch path migration to worker (warmer
  cache before user reaches tier).

Stop after iter 2.

---

## Constraints

1. NO breaking changes to:
   - src/geo/wrap.ts (coordinate contract)
   - docs/COORDINATE_SYSTEM.md
   - public API of src/data/chunks.ts (loadChunk signature unchanged, AbortError semantics
     preserved)
2. NO new runtime dependencies. Pixi v8 + native APIs only.
3. NO gameplay code. Stubs only — interface contracts locked, handlers throw NotImplementedError.
4. TypeScript strict mode. Discriminated union exhaustiveness MUST be compile-enforced via
   `assertNever` in default branch (no plain `default:` allowed in worker job/result switches).
5. A/B switch required: `?worker=on` (default) | `?worker=off` (Phase 7.9 fallback).
6. Phase 7.9 main-thread decode path stays fully functional (used by `?worker=off` AND
   environments without DecompressionStream).
7. Worker bundle < 50KB gzipped. Build-time assertion.
8. Cleanup task: stale "zero-copy" comments in chunks.ts (e.g. line 18-25 docstring) →
   update to reflect Phase 7.9 `.slice()` reality during decoder extraction.
9. Stop and ask Justin if architectural decision needed beyond locked Section A-H.

---

## Reviewer checklists

### A. Pool correctness
- [ ] Pool destroy releases all workers (no orphan threads)?
- [ ] Worker errors propagate to main thread (postMessage with error result)?
- [ ] No worker spawn race conditions on init (handshake awaited before first dispatch)?
- [ ] postMessage payload validated on main thread (discriminated union narrowing)?
- [ ] Round-robin dispatch implemented as DEFAULT strategy via constructor option (not hardcoded)?
- [ ] Queue depth cap enforced + QueueFullError rejection path?
- [ ] Cancel protocol works for both pending (queue removal) AND in-flight (worker AbortController)?

### B. Transferable ownership
- [ ] All ArrayBuffers in transfer list match payload references?
- [ ] No detached buffer access after transfer (worker doesn't read result.* after postMessage)?
- [ ] Helper dedupes ArrayBuffers (no double-transfer TypeError)?
- [ ] Worker doesn't reuse transferred buffers (treats post-postMessage state as locals invalid)?
- [ ] extractTransferables() correct for all message types (decode-chunk, pathfind, ai-tick, combat)?
- [ ] Common Mistakes Catalog (6 items) in phase-8-architecture.md?

### C. Memory & lifecycle
- [ ] Settled memory < 300MB (Phase 7.9 baseline 275MB +10% allowance)?
- [ ] Peak memory < 500MB?
- [ ] Worker pool destroy releases all worker threads (terminate())?
- [ ] Cancelled jobs don't leak in queue (verified via test)?
- [ ] No memory growth across 100 chunk evictions (60s pan storm)?
- [ ] Worker memory caveat documented (main-only performance.memory blind spot)?

### D. Performance
- [ ] postMessage roundtrip p95 < 5ms?
- [ ] FPS p95 ≥ 135 (Phase 7.9 baseline 140.8, 4% headroom for worker overhead)?
- [ ] tier-switch p95 < 5ms?
- [ ] chunk-build p95 < 5ms?
- [ ] Worker bundle gzip < 50KB (build assertion)?

### E. Fallback compat
- [ ] Detection logic correct (Worker + DecompressionStream + URL param + worker handshake)?
- [ ] ?worker=off forces main-thread path?
- [ ] No crash on unsupported environment (typeof Worker undefined, Vitest non-DOM)?
- [ ] HUD displays current decode mode (`worker(N)` or `main`)?
- [ ] Phase 7.9 path 100% identical behavior when ?worker=off (A/B bench parity ±2%)?
- [ ] ?engine and ?worker coexist orthogonally?

### F. Phase 9 readiness
- [ ] Pathfind stub interface complete + uses buffer-based payload (Int16Array packed, not Array<[n,n]>)?
- [ ] AI-tick stub interface complete + uses buffer-based payload?
- [ ] Pool can dispatch new job types without code change to pool.ts (just type union extension)?
- [ ] Discriminated union exhaustive check (`assertNever` enforces — TS compile error if new type added without handler)?
- [ ] Pluggable dispatch strategy seam ready (Phase 9 swaps round-robin for priority queue)?
- [ ] Risks table acknowledges Phase 9 dispatch revisit?

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

## Risks + mitigation

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Phase 9 round-robin starvation (decode behind 100 queued pathfinds) | Pool dispatchStrategy pluggable via constructor; Phase 9 swaps to priority queue |
| R2 | A18 Pro 2P+4E only — 4 workers may oversubscribe E-cores | Phase 8.7 iter 1 candidate: tune pool size to 3; bench iPhone for confirmation |
| R3 | Worker memory invisible to performance.memory | Document in HUD + phase-8-architecture.md; cross-check via DevTools Performance > Memory |
| R4 | Worker bundle bloat (accidental pixi.js import) | Build-time assertion in bench-phase8.ts (gzip < 50KB) |
| R5 | iOS Safari < 16.4 missing DecompressionStream | Worker handshake reports support → fall back to main-thread for that session |
| R6 | postMessage overhead eats FPS headroom | Phase 8.7 iter 1: profile clone vs transfer, audit transferList completeness |
| R7 | Cancellation race (cancel arrives after worker posted result) | Main ignores cancel-acks for already-resolved jobIds (Map cleanup on result delivery) |
| R8 | Pathfind result allocation churn at 400/sec | Locked: packed Int16Array buffer payload (not Array<[n,n]>) |

---

## Output artifacts

```
docs/
├── phase-8-architecture.md       # 8.0 output (500-700 lines)
├── phase-8-iter-1.md              # if needed
├── phase-8-iter-2.md              # if needed
└── phase-8-retro.md               # final retrospective

src/workers/                      # NEW directory
├── pool.ts                       # ~250 lines
├── types.ts                      # ~120 lines
├── transferUtils.ts              # ~60 lines
├── decoder.worker.ts             # ~180 lines
├── decoder.ts                    # ~150 lines (extracted from chunks.ts)
└── stubs.ts                      # ~80 lines

src/data/
└── chunks.ts                     # MODIFIED, public API unchanged + stale comments updated

vite.config.ts                    # MODIFIED: worker.format='es' + entryFileNames

scripts/
└── bench-phase8.ts               # NEW (with bundle-size + A/B assertion)

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
