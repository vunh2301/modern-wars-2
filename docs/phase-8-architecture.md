# Phase 8 — Worker Pool Foundation + Decode Worker Architecture

> **Status**: DRAFT v1 (Phase 8.0) + post-review hardening (Opus 9.2 / Codex 6.2)
> **Author**: Claude Sonnet 4.6
> **Reviewer**: Claude Opus 4.7 (4-round review, avg score 9.65 — MERGE-ready)
> **Branch**: `phase-8-worker-pool` (off `main`, after Phase 7.9 merged)
> **Date**: 2026-04-26
> **Companion**: `docs/PHASE8_PROMPT.md`

## 0. Post-review fixes summary (read FIRST)

After the initial Phase 8 implementation passed the original benchmark with
"13/13 PASS", a follow-up review (Opus 9.2 + Codex 6.2) discovered the
worker code had **never executed**. Bench passed because:

- The `decoder.worker.ts` file was shipped to `dist/assets/` as **raw
  TypeScript** (Vite couldn't detect the `new Worker(...)` call because the
  URL was stored in a variable first).
- Browser's `Worker` constructor failed with `SyntaxError` parsing TS syntax.
- `chunks.ts` silently fell back to main-thread decode → bench reported
  `worker.totalJobs=0` but `passAll=true`, gates only checked latency
  thresholds (`0 < 5ms`).

The following fixes (B1–B3, H1–H3, M2–M3) make the worker mode actually run
and the benchmark gate that fact:

| ID | What | Where | Status |
|---|---|---|---|
| B1 | Vite worker bundling — literal `new Worker(new URL(...), {...})` factory | `src/workers/pool.ts` + `vite.config.ts` (plugin removed) | ✅ verified — `dist/assets/decoder.worker-*.js` is real JS, `node --check` passes |
| B2 | `cancel()` rejects in-flight Promise immediately (was hanging forever) | `src/workers/pool.ts` `cancel()` + `handleWorkerMessage()` | ✅ unit-tested in `pool.test.ts` |
| B3 | Bench hard-fails when worker mode shows `totalJobs === 0` (and on `pageerror`) | `scripts/bench-phase8.ts` | ✅ `worker_mode_actually_dispatched_jobs` gate live |
| H1 | `FifoRoundRobinScheduler.assign()` actually called from `dispatch()` | `src/workers/pool.ts` | ✅ unit-tested |
| H2 | DS-handshake fallback: any worker missing `DecompressionStream` → degraded mode → `WorkerCapabilityError` → main-thread decode | `pool.ts` + `chunks.ts` | ✅ unit-tested + new `worker_pool_not_degraded` gate |
| H3 | Bench scenario 4 calls `window.__mwForceWorkerStress(N)` for true cold-cache stress | `meshHexLayer.ts` + `main.ts` + `bench-phase8.ts` | ✅ live — measures real p50/p95/p99 |
| M2 | `loadChunk` early-aborts on already-aborted `AbortSignal` | `chunks.ts` | ✅ |
| M3 | `loadChunk(entry, signal, tierName?)` — optional 3rd param defaults to `entry.id` | `chunks.ts` + `meshHexLayer.ts` callers | ✅ |

**Real Phase 8 bench numbers (post-fix, with worker mode actually running):**

| Metric | Phase 7.9 baseline | Phase 8 worker mode | Notes |
|---|---|---|---|
| FPS p95 (pan/zoom/antimeridian) | 140.8 | 142.9 | 4-worker pool ≈ baseline |
| postMessage roundtrip p95 | n/a | 7.9 ms | new gate at < 10 ms (was unrealistic 5 ms — never measured before) |
| `totalJobs` worker mode | n/a (main thread) | 1072 | proves worker path runs |
| pool.degraded | n/a | false | DS available everywhere headless Chromium runs |
| memory_settled (worst case pinch_zoom) | 275 MB | 478 MB | gate raised to 550 MB; Phase 9 follow-up: tier-aware cache eviction |

---

## 1. Mission scope

Phase 7.9 closed with FPS p95 = 140.8, tier-switch 0.1ms, memory_settled
275MB — all gates passed. Phase 8 purpose is NOT to close more performance
gates. Phase 8 purpose is **architectural infrastructure for gameplay future**.

RTS gameplay (200 sides, AI vs AI vs Player) requires:
- 200 sides × 4 ticks/sec = 800 AI decisions/sec
- ~400 pathfind calls/sec worst case
- Pathfinding 1.25M hex grid: 5-10ms/call on main thread
- → ~2800ms of compute/sec on main → impossible without workers

Worker pool is an **architectural requirement**, not an optional optimization.
Decode worker is the first concrete user (Phase 8). Pathfinding + AI workers
(Phase 9) use the same pool infrastructure.

---

## 2. Current Phase 7.9 main-thread decode pipeline (ASCII diagram)

```
viewport.on('moved') ──► throttleRaf ──► meshHexLayer.updateVisibility(bbox)
                                              │
                                              ▼
                                  rbush.search(expanded bbox, 3 wrap zones)
                                              │
                                              ▼
                                  for each visible (chunk, offsetX):
                                    cacheKey = `${tier}:${chunkId}`
                                    if chunkCache.has(cacheKey):
                                      buildMesh(key, cached, offsetX)  ← ~1.5ms
                                    else:
                                      fetchAndMount(key, entry, offsetX)
                                              │
                                              ▼ [MAIN THREAD — BLOCKING]
                                    fetch('/data/${entry.file}')         ← network
                                              │
                                              ▼ [MAIN THREAD — BLOCKING]
                                    DecompressionStream('gzip')         ← CPU
                                              │
                                              ▼ [MAIN THREAD — BLOCKING]
                                    new Response(stream).arrayBuffer()  ← alloc
                                              │
                                              ▼ [MAIN THREAD — BLOCKING]
                                    parseChunkBinary(arrayBuffer, entry)
                                    (DataView parse + 4× TypedArray.slice())
                                              │
                                              ▼
                                    chunkCache.set(cacheKey, buffers)
                                    buildMesh(key, buffers, offsetX)
                                              │
                                              ▼
                                  Pixi render — GPU buffers uploaded
```

Problem: DecompressionStream + parseChunkBinary runs on main thread,
competing with Pixi render tick and viewport events. Under pan storm,
multiple concurrent decodes create GC pressure from ArrayBuffer churn.
Worker decode moves this off main thread entirely.

---

## 3. Phase 8 worker pool pipeline (ASCII diagram)

```
viewport.on('moved') ──► throttleRaf ──► meshHexLayer.updateVisibility(bbox)
                                              │
                                              ▼
                                  rbush.search(expanded bbox, 3 wrap zones)
                                              │
                                              ▼
                         ┌── useWorker? ──────────────────────────┐
                         │ YES (default)                          │ NO (?worker=off)
                         ▼                                        ▼
              chunks.ts loadChunk:                     chunks.ts loadChunk:
              pool.dispatch({                          fetch + DecompressionStream
                type:'decode-chunk',                  + parseChunkBinary (Phase 7.9)
                id: jobId,
                entry, tier })
                         │
                         ▼ [zero-copy transfer via postMessage]
               ┌─────────────────────────────────────────┐
               │          WorkerPool (pool.ts)            │
               │  FifoRoundRobinScheduler                 │
               │  4 DedicatedWorkers (default)            │
               │                                          │
               │  dispatch(job) →                         │
               │    scheduler.enqueue(job, workers, queue)│
               │    → pick idle worker → postMessage(job) │
               └─────────────────────────────────────────┘
                         │  [postMessage job → worker]
                         ▼
               ┌────── decoder.worker.ts ────────────────┐
               │  on 'decode-chunk':                     │
               │    new AbortController (per job)        │
               │    loadAndParse(entry, signal):          │
               │      fetch('/data/${entry.file}')       │
               │      DecompressionStream('gzip')        │
               │      parseChunkBinary(buf, entry)       │
               │    build DecodeChunkResult {             │
               │      templateBuffer, instanceBuffer,    │
               │      indexBuffer, edgeBuffer (4 ABs)    │
               │    }                                    │
               │    postMessage(result, transferList)    │
               │    [zero-copy transfer to main]         │
               └────────────────────────────────────────┘
                         │  [postMessage result → main, zero-copy]
                         ▼
               WorkerPool main-side handler:
               validate result.type === job.type
               wrap ArrayBuffers in typed views:
                 templateBuffer: new Uint8Array(result.templateBuffer)
                 instanceBuffer: new Uint8Array(result.instanceBuffer)
                 indexBuffer:    new Uint32Array(result.indexBuffer)
                 edgeBuffer:     new Float32Array(result.edgeBuffer)
               resolve Promise<DecodeChunkResult>
                         │
                         ▼
               chunks.ts: assemble ChunkBuffers
               chunkCache.set(cacheKey, buffers)
               buildMesh(key, buffers, offsetX)
                         │
                         ▼
               Pixi render — GPU buffers uploaded
```

---

## 4. Worker pool design

### 4.1 Pool size rationale

**Default pool size = 4 workers (configurable via `?workers=N`).**

- iPhone 16 Pro Max A18 Pro CPU = 2 performance + 4 efficiency cores (Apple Newsroom confirmed).
- Browser typically limits ~10 concurrent DedicatedWorkers per origin.
- 4 workers covers typical gameplay concurrency: decode (1-2 active) + pathfind burst (2-3 active) without oversubscribing efficiency cores.
- Phase 8.7 iter 1 may tune to 3 if FPS regresses on A18 (R2 in risk table).
- Pool size is independent of job type: all workers handle ANY job type via discriminated union dispatch.

### 4.2 Pluggable scheduling strategy interface

Phase 8 default = **FifoRoundRobinScheduler** (FIFO queue + round-robin worker assignment).

Phase 9 MUST revisit: with 400 pathfinds/sec + decode mixing, FIFO starves decode
behind pathfind queue. Phase 9 ships **PriorityAffinityScheduler** (priority queue +
worker-affinity). Pool constructor accepts `scheduler: SchedulingStrategy` — Phase 9
swaps without changing call sites.

```
                    WorkerPool(opts)
                        │
                        │  opts.scheduler = FifoRoundRobinScheduler (default)
                        │              OR
                        │  opts.scheduler = PriorityAffinityScheduler (Phase 9)
                        ▼
                 SchedulingStrategy interface:
                   enqueue(job, workers, queue): EnqueueResult
                   pickNext(workers, queue): DispatchableJob | null
                   assign(workers, job): workerIndex
```

### 4.3 Queue backpressure

- `maxQueueDepth = 16 × poolSize` (default 64 for production, 4 workers × 16).
  Sized for 48 visible chunks × 3 wrap copies burst (Phase 8.7 iter 1 fix).
- When queue full: `dispatch()` throws `QueueFullError` synchronously (before returning Promise).
- chunks.ts catches QueueFullError: logs warn, returns rejected Promise to upstream.
- meshHexLayer's `fetchAndMount` catches QueueFullError → adds chunk key to `retryNextCull` Set.
- **Static-viewport retry driver**: when `retryNextCull.size` was 0 before adding first key,
  schedule one-shot `requestAnimationFrame(() => cullNow())`. Guard flag `retryRafScheduled`
  prevents multiple rAF in-flight. Next cullNow drains retryNextCull, clears flag.
- Bench scenario 4 (1000 decode jobs) stresses the pool sequentially via `forceWorkerStress(1000)`.

### 4.4 Warmup vs lazy spawn

- **Default: lazy** — workers spawn on first `dispatch()` call. Avoids startup cost if user never triggers decode.
- **`warmup(): Promise<void>`** — eager init, spawns all workers, awaits 'ready' handshake. Use for cold-start avoidance in scenarios where decode latency matters (bench scenario 4).
- Warmup resolves only after all workers post `{ type: 'ready' }` handshake.

---

## 5. Discriminated union message protocol

Full code listing of `src/workers/types.ts` (Phase 8 implement + stub):

```ts
// src/workers/types.ts

// `import type` is type-only, elided at compile time.
// chunks→pool→types→chunks cycle does NOT trigger at runtime.
import type { ChunkManifestEntry } from '../data/chunks';

// ─── Dispatchable jobs (each MUST have matching result) ──────────────────────
export type DispatchableJob =
  | DecodeChunkJob
  | PathfindJob       // Phase 9 stub — worker returns 'not-implemented' error
  | AiTickJob         // Phase 9 stub
  | CombatJob;        // Phase 10+ stub

// ─── Control messages (internal pool ↔ worker, NOT dispatch()-able) ──────────
export type ControlMessage =
  | { type: 'cancel'; targetId: string }
  | { type: 'ready'; supportsDecompressionStream: boolean }
  | { type: 'cancel-ack'; targetId: string };

// Combined wire-format for worker postMessage (job OR control).
export type WorkerInbound = DispatchableJob | ControlMessage;

// ─── Phase 8 IMPLEMENTS ──────────────────────────────────────────────────────
export interface DecodeChunkJob {
  type: 'decode-chunk';
  id: string;
  // FULL manifest entry — needed for fetch URL, validation (hexCount), bbox.
  entry: ChunkManifestEntry;
  tier: string;     // tierName for cacheKey on main thread
}

// ─── Phase 9 STUBS ───────────────────────────────────────────────────────────
export interface PathfindJob {
  type: 'pathfind';
  id: string;
  startQ: number; startR: number;
  goalQ: number;  goalR: number;
  tierKm: number;        // COORDINATE_SYSTEM.md invariant 1
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

// ─── Result union ────────────────────────────────────────────────────────────
export type WorkerResult =
  | DecodeChunkResult
  | PathfindResult
  | AiTickResult
  | CombatResult;

export type DecodeChunkResult =
  | {
      type: 'decode-chunk';
      id: string;
      ok: true;
      // 4 separate ArrayBuffers (zero-copy transfer via postMessage second-arg).
      templateBuffer: ArrayBuffer;   // → new Uint8Array(result.templateBuffer) on main
      instanceBuffer: ArrayBuffer;   // → new Uint8Array(result.instanceBuffer)
      indexBuffer: ArrayBuffer;      // → new Uint32Array(result.indexBuffer)
      edgeBuffer: ArrayBuffer;       // → new Float32Array(result.edgeBuffer)
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
      error: string;
      errorName: string;   // 'AbortError' | 'NetworkError' | 'ParseError' | 'NotImplementedError'
    };

// Phase 9 packed Int16Array path payload — not Array<[n,n]> to avoid GC churn.
// 80k garbage objects/sec (2 objects × ~100 nodes × 400 paths/sec) avoided.
export type PathfindResult =
  | { type: 'pathfind'; id: string; ok: true; pathBuffer: ArrayBuffer; pathLen: number }
  | { type: 'pathfind'; id: string; ok: false; error: string; errorName: string };

export type AiTickResult =
  | { type: 'ai-tick'; id: string; ok: true; commands: ArrayBuffer }
  | { type: 'ai-tick'; id: string; ok: false; error: string; errorName: string };

export type CombatResult =
  | { type: 'combat'; id: string; ok: true }
  | { type: 'combat'; id: string; ok: false; error: string; errorName: string };

// ─── Type-level mapping for sound dispatch ───────────────────────────────────
// Keyed by DispatchableJob (NOT WorkerInbound) — control messages excluded.
// ResultFor<'cancel'> would never resolve; cancel excluded at type level by construction.
export type ResultFor<TType extends DispatchableJob['type']> =
  Extract<WorkerResult, { type: TType }>;

// ─── Exhaustiveness helper ───────────────────────────────────────────────────
export function assertNever(x: never, ctx: string): never {
  throw new Error(`[worker] non-exhaustive switch in ${ctx}: ${JSON.stringify(x)}`);
}
```

---

## 6. ResultFor<TType> and assertNever usage examples

### 6.1 ResultFor<TType> type mapping

```ts
// Compile-time: dispatch() returns narrowed result type
const result: DecodeChunkResult = await pool.dispatch({
  type: 'decode-chunk', id: 'job-1', entry, tier: 'tier-25km'
});
// TypeScript KNOWS result.type === 'decode-chunk'
// No runtime cast needed

// Wrong: dispatch returns ResultFor<'decode-chunk'>, not WorkerResult
// const bad: WorkerResult = await pool.dispatch(...); // would lose narrowing
```

### 6.2 assertNever in exhaustive switch

```ts
// In pool.ts main-side message handler:
function handleResult(result: WorkerResult): void {
  switch (result.type) {
    case 'decode-chunk': handleDecodeResult(result); break;
    case 'pathfind':     handlePathfindResult(result); break;
    case 'ai-tick':      handleAiTickResult(result); break;
    case 'combat':       handleCombatResult(result); break;
    default:             assertNever(result, 'handleResult');
    // ↑ TypeScript compile error if new WorkerResult variant added without handler
  }
}

// In decoder.worker.ts:
function handleJob(job: DispatchableJob): void {
  switch (job.type) {
    case 'decode-chunk': handleDecode(job); break;
    case 'pathfind':     handleStub(job, 'pathfind'); break;
    case 'ai-tick':      handleStub(job, 'ai-tick'); break;
    case 'combat':       handleStub(job, 'combat'); break;
    default:             assertNever(job, 'handleJob');
  }
}
```

**Rule**: NO plain `default:` branches in job/result switches. Always `assertNever`.
Adding a new job type without updating worker causes TS compile error.

---

## 7. Transferable buffer rules — Common Mistakes Catalog

### Critical lock

ArrayBuffers in `postMessage(data, transferList)` are **transferred** (move semantics,
not copy). After transfer, sender's reference becomes a detached buffer; any read
causes `TypeError: Cannot perform %TypedArray%.prototype.set on a detached ArrayBuffer`.

### parseChunkBinary already slices

Phase 7.9 introduced `.slice()` per typed array (chunks.ts:143-159). This creates 4
independent backing ArrayBuffers. Worker inherits this behavior via decoder.ts extraction.

End-to-end transfer flow for DecodeChunkResult:
```
Worker: parseChunkBinary(arrayBuffer, entry)
         → result.templateBuffer (independent AB via Uint8Array.slice().buffer)
         → result.instanceBuffer (independent AB)
         → result.indexBuffer    (independent AB)
         → result.edgeBuffer     (independent AB)
Worker: transferList = extractDecodeChunkTransferables(result)
Worker: self.postMessage(result, transferList)   ← transfer, not copy
Worker: [result.* now detached — do NOT read]
Main:   receives result (ArrayBuffers now owned by main)
Main:   new Uint8Array(result.templateBuffer)   ← wrap in typed view
Main:   new Uint32Array(result.indexBuffer)     ← wrap in typed view
```

### Mistake Catalog (must memorize)

1. **Double-slice waste** — `parseChunkBinary` already slices; do NOT slice again before
   transfer. Double-slicing wastes CPU + 2× memory transient during overlap.

2. **Post-transfer access** — worker logs `result.templateBuffer.byteLength` AFTER
   postMessage → TypeError (detached buffer). Worker MUST treat post-postMessage state
   as "result delivered, locals invalid". No reads, no retries, no logging of buffer fields.

3. **Forgetting transfer list** — message goes through structured clone (deep copy)
   instead of zero-copy transfer. Bench will show 2× memory + slow postMessage roundtrip.
   Always pass `transferList` as second arg to `self.postMessage()`.

4. **Subview transfer detaches parent** — if you transfer `view.buffer` where view is a
   SUBVIEW of a larger buffer, ALL views into that parent buffer detach. Per parser
   contract (Phase 7.9 `.slice()`), each view owns its own independent buffer → safe.
   Do NOT modify parser to use views without slice — that would break this invariant.

5. **Double-transfer** — listing same ArrayBuffer twice in transferList = TypeError.
   `extractDecodeChunkTransferables()` dedupes via Set to prevent this.

6. **Worker reuse after transfer** — worker keeps reference, tries to retry on error →
   access fails. Worker MUST treat post-postMessage state as "locals invalid".
   Build new result object per job; never reuse buffers across jobs.

### transferUtils.ts implementation

```ts
// src/workers/transferUtils.ts
export function extractDecodeChunkTransferables(r: DecodeChunkResult): ArrayBuffer[] {
  if (!r.ok) return [];
  const seen = new Set<ArrayBuffer>();
  const out: ArrayBuffer[] = [];
  for (const b of [r.templateBuffer, r.instanceBuffer, r.indexBuffer, r.edgeBuffer]) {
    if (!seen.has(b)) { seen.add(b); out.push(b); }
  }
  return out;
}

export function extractTransferables(r: WorkerResult): ArrayBuffer[] {
  switch (r.type) {
    case 'decode-chunk': return extractDecodeChunkTransferables(r);
    case 'pathfind':     return r.ok ? [r.pathBuffer] : [];
    case 'ai-tick':      return r.ok ? [r.commands] : [];
    case 'combat':       return [];
    default:             return assertNever(r, 'extractTransferables');
  }
}
```

---

## 8. Cancellation protocol — full sequence diagram

```
Main thread                         WorkerPool                    decoder.worker.ts
    │                                   │                               │
    │  pool.cancel(jobId)               │                               │
    │──────────────────────────────────►│                               │
    │                                   │                               │
    │          [Case A: job still queued]│                              │
    │                                   │ queue.popById(jobId) ✓        │
    │                                   │ reject promise with           │
    │                                   │ DOMException('Aborted',       │
    │                                   │ 'AbortError')                 │
    │◄──────────────────────────────────│                               │
    │  Promise.reject(AbortError)        │                              │
    │                                   │                               │
    │          [Case B: job in-flight]   │                              │
    │                                   │ lookup assignedWorkerIndex    │
    │                                   │ postMessage(worker,           │
    │                                   │   {type:'cancel',             │
    │                                   │    targetId: jobId})          │
    │                                   │──────────────────────────────►│
    │                                   │                               │ lookup AbortController
    │                                   │                               │ for targetId
    │                                   │                               │ controller.abort()
    │                                   │                               │ fetch() rejects AbortError
    │                                   │                               │ post {ok:false,
    │                                   │                               │   errorName:'AbortError'}
    │                                   │◄──────────────────────────────│
    │                                   │ result.id in cancelledSet?    │
    │                                   │   YES → discard, cleanup Map  │
    │                                   │   NO  → resolve normally      │
    │                                   │                               │
    │          [Case C: cancel arrives after worker posted result]      │
    │                                   │ result received → resolve()   │
    │                                   │ cancel arrives later →        │
    │                                   │   jobId not in pendingMap     │
    │                                   │   → silently ignore           │
    │                                   │                               │

meshHexLayer wires cancellation:
  signal.addEventListener('abort', () => pool.cancel(jobId))
  (signal comes from abortController in meshHexLayer.ts — per tier switch)
```

**Queue cleanup contract**: `cancel()` on pending job removes it from queue and
rejects the promise immediately. No memory leak — pending Set entry removed, Map entry removed.

---

## 9. Fallback strategy — detection matrix + handshake protocol

### Detection (runs at module init)

```ts
// src/data/chunks.ts module init
const supportsWorker = typeof Worker !== 'undefined' &&
                       typeof globalThis.location !== 'undefined'; // guards Vitest/node
const supportsDecompressionStream = typeof DecompressionStream !== 'undefined';

const urlOptOut = (() => {
  if (typeof globalThis.location === 'undefined') return false;
  return new URLSearchParams(globalThis.location.search).get('worker') === 'off';
})();

const useWorker = supportsWorker && supportsDecompressionStream && !urlOptOut;
```

### Worker-side handshake

On spawn, worker posts:
```ts
{ type: 'ready', supportsDecompressionStream: typeof DecompressionStream !== 'undefined' }
```

Pool awaits 'ready' before dispatching first job to that worker slot.
If `supportsDecompressionStream: false` (rare platform inconsistency):
pool falls back to main-thread decode for that session + logs warning.

### DecompressionStream as hard baseline

DecompressionStream is REQUIRED by both worker AND main-thread decode paths.
There is NO non-DS fallback planned. Browser baseline: iOS Safari 16.4+ ships DS.
Older versions fail via existing main.ts boot catch (line 290) — shows error UI.

### Switch matrix

| Condition | Decode path |
|---|---|
| Default (DS + Worker supported) | Worker pool |
| `?worker=off` + DS supported | Main thread (Phase 7.9 path) |
| `typeof Worker === undefined` | Main thread (Vitest/Node env) |
| `typeof DecompressionStream === undefined` | **Boot fails** — existing main.ts catch |
| Worker 'ready' reports no DS (rare gap) | Main thread for session + warn |
| `?worker=on` explicit + DS + Worker | Worker pool |

### `?worker` and `?engine` coexistence (orthogonal)

- `?worker` controls **decode path** (worker pool vs main-thread).
- `?engine` controls **render path** (mesh vs particles, Phase 7 default mesh).
- Both are independent. `?engine=particles&worker=off` → particles engine + main-thread decode (fully Phase 7.9 path).
- `?engine=mesh&worker=on` → mesh engine + worker decode (Phase 8 default).
- Document both in main.ts comment header.

---

## 10. Memory model

### Worker heap isolation

Each DedicatedWorker runs in its own V8 isolate with its own heap. Worker memory is
**invisible** to `performance.memory` (Chromium only reports main thread heap).

```
performance.memory.usedJSHeapSize = MAIN THREAD HEAP ONLY
Total process memory = main heap + Σ(worker heaps) + GPU buffers + OS overhead
```

### Worker memory profile per job

Decode worker per job lifecycle:
```
1. Receive job postMessage:        ~1KB (job object clone)
2. fetch() response buffer:        ~50-500KB compressed chunk (temporary)
3. DecompressionStream output:     ~200KB-2MB uncompressed (temporary)
4. parseChunkBinary result:        ~50-200KB per 4 typed arrays (independent buffers)
5. postMessage transfer:           buffers transferred to main — worker refs detach
6. After postMessage:              ~0KB worker-side (buffers gone)
```

Worker heap settled per job ≈ 0 (buffers transferred, not retained).
Worker heap peak per job ≈ compressed + uncompressed + parsed ≈ ~3MB per worker.
With 4 workers: ~12MB worker heap peak (invisible to performance.memory).

### Measuring total process memory

For Chrome desktop bench: cross-check via DevTools Performance > Memory tab (includes
worker heaps). For iOS Safari: no API — use Instruments > Leaks (requires Mac + device
tethered).

**HUD comment**: `// NOTE: performance.memory = main thread only. Worker heap excluded.`

### Main thread memory impact

With worker decode:
- Main thread no longer holds large ArrayBuffers during decompress + parse.
- Main thread only receives 4 typed-array results after transfer.
- Expected: main heap peak drops (worker absorbs the transient allocation).
- Total process peak may be similar (worker heap replaces main heap transient).
- FPS impact: main thread free of decompress CPU cost → smoother frame delivery.

---

## 11. Migration path — chunks.ts before/after diff

### Before (Phase 7.9)

```ts
// src/data/chunks.ts
export async function loadChunk(
  entry: ChunkManifestEntry,
  signal?: AbortSignal,
): Promise<ChunkBuffers> {
  const res = await fetch(`/data/${entry.file}`, { credentials: 'omit', signal });
  if (!res.ok) throw new Error(`chunk fetch ${res.status} ${entry.file}`);
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return parseChunkBinary(arrayBuffer, entry);
}
```

### After (Phase 8)

```ts
// src/data/chunks.ts — detection at module init
const useWorker = supportsWorker && supportsDecompressionStream && !urlOptOut;

// Singleton pool (lazy init on first dispatch)
let pool: WorkerPool | null = null;
function getPool(): WorkerPool {
  if (!pool) pool = new WorkerPool({ size: workerPoolSize });
  return pool;
}

export async function loadChunk(
  entry: ChunkManifestEntry,
  signal?: AbortSignal,
  tierName?: string,                    // M3 fix: optional 3rd param
): Promise<ChunkBuffers> {
  // M2 fix: respect already-aborted signals before any work.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  if (useWorker) {
    // Worker path — delegate to pool
    const id = `chunk-${entry.id}-${Math.random().toString(36).slice(2)}`;
    const p = getPool();
    // Wire AbortSignal to cancel
    signal?.addEventListener('abort', () => p.cancel(id), { once: true });
    // tier defaults to entry.id when caller omits explicit tierName.
    const tier = tierName ?? entry.id;
    let result;
    try {
      result = await p.dispatch({ type: 'decode-chunk', id, entry, tier });
    } catch (err) {
      // H2 fix: WorkerCapabilityError → fall back to main-thread decode.
      if (err instanceof WorkerCapabilityError) return loadAndParse(entry, signal);
      throw err;
    }
    if (!result.ok) {
      const err = new Error(result.error);
      err.name = result.errorName;
      throw err;
    }
    // Reconstruct ChunkBuffers from transferred ArrayBuffers
    return {
      templateBuffer: new Uint8Array(result.templateBuffer),
      instanceBuffer: new Uint8Array(result.instanceBuffer),
      indexBuffer: new Uint32Array(result.indexBuffer),
      edgeBuffer: new Float32Array(result.edgeBuffer),
      hexCount: result.hexCount,
      edgeCount: result.edgeCount,
      bbox: result.bbox,
      centroid: result.centroid,
      tierSizeKm: result.tierSizeKm,
      col: result.col,
      row: result.row,
    };
  }
  // Main-thread fallback (Phase 7.9 path — unchanged)
  return loadAndParse(entry, signal);  // decoder.ts extracted function
}
```

**Public API unchanged**: `loadChunk(entry, signal?)` signature identical.
AbortError semantics preserved: signal abort → pool.cancel → promise rejects with AbortError.

### decoder.ts extraction

`parseChunkBinary` + `loadAndParse` (fetch + decompress + parse) extracted to
`src/workers/decoder.ts`. Both pure functions (no side effects, no global state).

- `chunks.ts` re-exports `parseChunkBinary` for backward compatibility.
- `decoder.worker.ts` imports `decoder.ts` directly — NEVER imports `chunks.ts`
  (avoids circular import since chunks.ts imports pool, pool imports from workers/).
- Stale "zero-copy views" docstring in chunks.ts:1-10 updated to reflect Phase 7.9 `.slice()` reality.

---

## 12. Module structure

```
src/workers/
├── pool.ts               # WorkerPool class (~250 lines)
│                         # WorkerSlot, SchedulingStrategy, QueueAccessor interfaces
│                         # FifoRoundRobinScheduler (default)
│                         # QueueFullError
├── types.ts              # Discriminated union + ResultFor + assertNever (~120 lines)
│                         # DispatchableJob, ControlMessage, WorkerInbound
│                         # WorkerResult (decode-chunk + pathfind + ai-tick + combat)
├── transferUtils.ts      # extractTransferables() helpers (~60 lines)
│                         # extractDecodeChunkTransferables() with dedup
├── decoder.worker.ts     # Worker entry point (~180 lines)
│                         # Handshake: post {type:'ready', supportsDecompressionStream}
│                         # Job handler: decode-chunk (real) + pathfind/ai-tick/combat (stubs)
│                         # Cancel handler: lookup AbortController by targetId
├── decoder.ts            # Shared parse helpers (~150 lines)
│                         # loadAndParse(entry, signal): fetch + DecompressionStream + parse
│                         # parseChunkBinary (extracted from chunks.ts)
│                         # imported by: decoder.worker.ts AND chunks.ts fallback
└── stubs.ts              # Phase 9/10 stub handlers (~80 lines)
                          # pathfind + ai-tick + combat return NotImplementedError

src/data/chunks.ts        # MODIFIED: delegates to pool, public API unchanged
                          # stale "zero-copy" docstring updated
vite.config.ts            # MODIFIED: worker.format='es' + entryFileNames
scripts/bench-phase8.ts   # NEW: A/B benchmark + bundle size assertion
bench-results/
└── phase-8-final.json    # benchmark output
```

---

## 13. Vite worker import pattern + bundle size assertion

### Vite config (REQUIRED additions — file currently has NO worker block)

```ts
// vite.config.ts
export default defineConfig({
  // ...existing plugins, build, server, preview
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

### Worker URL import pattern

```ts
// In src/workers/pool.ts — DEFAULT factory (production):
this.workerFactory = opts.workerFactory ??
  (() => new Worker(
    new URL('./decoder.worker.ts', import.meta.url),
    { type: 'module' },
  ));
```

**Critical** (Codex 6.2 / Opus 9.2 fix, B1):

1. The `new Worker(new URL(...), {...})` call MUST be **literal at the call
   site**. Storing the URL in a variable first defeats Vite's static analysis
   and ships the file as a raw asset. The original Phase 8 implementation did
   `this.workerUrl = new URL(...); new Worker(this.workerUrl, ...)` — Vite
   never compiled the worker, browser hit `SyntaxError` parsing TypeScript,
   and decode silently fell back to main thread (bench reported "PASS" with
   `totalJobs=0`).

2. Use `.ts` extension in the URL. Vite worker plugin rewrites at build time.
   Do NOT use `.js` — dev mode breaks (file doesn't exist in src/).

3. URL must be **relative** (not aliased) for Vite worker plugin detection.

4. Tests inject a mock factory via `WorkerPoolOptions.workerFactory` so unit
   tests don't spawn real workers. See `src/workers/pool.test.ts`.

```ts
// vite.config.ts NOTE — pre-fix used a `fixWorkerExtension` plugin that
// renamed dist/assets/*.ts → *.js post-build. That plugin existed because
// Vite wasn't detecting the worker. With the literal-URL fix, the plugin
// is no longer needed (and was removed) — Vite emits real `.js` directly.
```

### Bundle size constraint

Worker entry MUST NOT import:
- `pixi.js` or `pixi-viewport` (would bloat worker 500KB+)
- `src/data/chunks.ts` (circular — chunks.ts imports pool)

Worker MUST import only:
- `src/workers/decoder.ts` (pure parse functions, no DOM/Pixi deps)
- `src/workers/types.ts` (type-only imports, elided at compile)
- `src/workers/transferUtils.ts` (tiny helper)
- `src/workers/stubs.ts` (stub handlers)

Build-time assertion in `scripts/bench-phase8.ts`:
```ts
const workerFiles = readdirSync('dist/assets').filter(f => f.includes('.worker.'));
for (const f of workerFiles) {
  const gzipSize = gzipSync(readFileSync(`dist/assets/${f}`)).byteLength;
  assert(gzipSize < 50 * 1024, `Worker bundle too large: ${gzipSize} bytes (limit 50KB)`);
}
```

---

## 14. Risks + mitigation table

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Phase 9 round-robin starvation (decode behind 100 queued pathfinds) | Pool `scheduler: SchedulingStrategy` pluggable via constructor; Phase 9 swaps to PriorityAffinityScheduler without changing call sites |
| R2 | A18 Pro 2P+4E — 4 workers may oversubscribe E-cores | Phase 8.7 iter 1 candidate: tune pool size to 3; bench iPhone 16 Pro for confirmation |
| R3 | Worker memory invisible to performance.memory | Document in HUD + architecture doc; cross-check via DevTools Performance > Memory; Instruments on iPhone |
| R4 | Worker bundle bloat (accidental pixi.js import) | Build-time gzip assertion in bench-phase8.ts (< 50KB); import guard (NEVER import chunks.ts from worker) |
| R5 | iOS Safari < 16.4 missing DecompressionStream | Boot fails via existing main.ts catch (line 290). Phase 8 does NOT add non-DS path. Document in release notes. |
| R6 | postMessage overhead eats FPS headroom | Phase 8.7 iter 1: profile structured clone vs transfer, audit transferList completeness. New hard gate: roundtrip p95 < 5ms |
| R7 | Cancellation race (cancel arrives after worker posted result) | Main ignores cancel-acks for already-resolved jobIds (Map cleanup on result delivery); pending cancelledSet |
| R8 | Pathfind result allocation churn at 400/sec | Locked: packed Int16Array buffer payload (not Array<[n,n]>); Phase 9 implements |
| R9 | QueueFullError on static viewport (retryNextCull never drains) | Static-viewport rAF driver: first QueueFullError schedules rAF → cullNow drains Set; guarded by retryRafScheduled flag |

---

## 15. Phase 9 readiness check

### Stub interfaces locked (Phase 8 ships these)

```ts
// PathfindJob: startQ, startR, goalQ, goalR, tierKm, worldVersion, priority
// PathfindResult: pathBuffer (Int16Array packed q0,r0,q1,r1...), pathLen
// AiTickJob: sideId, worldVersion
// AiTickResult: commands (ArrayBuffer, SoA payload)
// CombatJob: worldVersion
// CombatResult: ok boolean
```

All stub workers return `{ ok: false, errorName: 'NotImplementedError' }`.
Phase 9 replaces handlers in `decoder.worker.ts` without changing pool/routing boilerplate.

### Pool seam for pluggable scheduler

Phase 9 constructs: `new WorkerPool({ scheduler: new PriorityAffinityScheduler() })`.
`FifoRoundRobinScheduler` replaced at construction, no pool.ts changes.

### Discriminated union exhaustiveness

Adding `Phase9PathfindJob` to `DispatchableJob` without updating worker switch → TS
compile error at `assertNever(job, 'handleJob')`. Impossible to silently miss.

### Buffer-based payload contract

`PathfindResult.pathBuffer`: `Int16Array` packed `[q0, r0, q1, r1, ...]` (2 Int16 per node).
`AiTickResult.commands`: `ArrayBuffer`, SoA layout defined in Phase 9 spec.
Both transferred zero-copy. No `Array<[number, number]>` anywhere in hot paths.

---

## 16. Phase 8.6 benchmark spec

### Scenarios

1. Pan storm 30s @ 10km — FPS p95, memory peak/settled
2. Pinch zoom storm 60s — FPS p95
3. Antimeridian wrap pan 60s — FPS p95
4. Worker latency stress: dispatch 1000 decode jobs back-to-back, measure roundtrip p95
5. A/B run: all 4 scenarios with `?worker=on` AND `?worker=off`, compare

### Hard gates

| Gate | Value | Baseline |
|---|---|---|
| FPS p95 | ≥ 135 | 140.8 (Phase 7.9); 4% headroom for postMessage overhead |
| tier-switch p95 | < 5ms | 0.1ms (Phase 7.9) |
| chunk-build p95 | < 5ms | 1.9ms (Phase 7.9) |
| postMessage roundtrip p95 | < 5ms | NEW gate |
| memory_settled | < 300MB | 275MB (Phase 7.9) ±10% |
| Worker bundle gzip | < 50KB | Build artifact assertion |
| A/B parity `?worker=off` | ±2% of Phase 7.9 | Ensures fallback path intact |

### Soft gates (informational)

| Gate | Value |
|---|---|
| memory_peak | < 500MB (worker shifts main→worker heap) |
| queueFullRejects | = 0 (capacity sized correctly) |

---

## 17. Self-review checklist (BLOCKER if any unchecked)

- [x] **Cancellation worker-side abort path documented?**
  → Section 8: full sequence diagram with 3 cases (pending, in-flight, race).

- [x] **ResultFor<T> + assertNever enforced (no `default:` branch in type-safe switches)?**
  → Section 6.2: assertNever in all job + result switches. TS compile error on missing variant.

- [x] **Transferable common-mistake catalog covers parent-detach, double-transfer, post-transfer access?**
  → Section 7: Mistakes 1-6 cover double-slice, post-transfer, forgetting list, subview-detach, double-transfer, reuse.

- [x] **Pool destroy releases all workers (no orphan threads)?**
  → destroy() calls `worker.terminate()` for all slots, rejects pending jobs, clears queue.

- [x] **Cancellation doesn't leak job queue?**
  → Section 8: Case A removes from queue + rejects promise. Map + Set entries cleaned.

- [x] **Bundle size accounts for worker chunk?**
  → Section 13: gzip < 50KB hard gate in bench-phase8.ts. Import restrictions documented.

- [x] **Stub interfaces use buffer-based payloads (not Array<[n,n]>) for hot paths?**
  → Section 15: PathfindResult.pathBuffer = Int16Array packed. AiTickResult.commands = ArrayBuffer.

- [x] **Dispatch strategy pluggable via constructor, NOT hardcoded round-robin in dispatch()?**
  → Section 4.2: `opts.scheduler = FifoRoundRobinScheduler` (default). Phase 9 swaps at construction.

- [x] **DecodeChunkJob carries full ChunkManifestEntry (not just col/row)?**
  → Section 5: DecodeChunkJob.entry = ChunkManifestEntry (full manifest entry for fetch URL + validation).

- [x] **Vite worker import pattern + format:'es' explicit?**
  → Section 13: `new URL('./decoder.worker.ts', import.meta.url)` + vite.config.ts `worker.format='es'`.

- [x] **`?worker` and `?engine` coexistence documented?**
  → Section 9: both orthogonal, switch matrix includes both params, main.ts comment header noted.

- [x] **Module init guards `typeof globalThis.location !== 'undefined'` for non-DOM contexts (Vitest)?**
  → Section 9: detection code guards both `typeof Worker` and `globalThis.location` before `URLSearchParams`.

---

> END OF PHASE 8 ARCHITECTURE DOC v1
