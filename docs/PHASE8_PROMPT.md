# Phase 8: Web Worker Chunk Decode (CONDITIONAL)

> **STATUS: BLOCKED — pending iOS Safari real-device memory verification.**
>
> Phase 7 closed 4/5 hard gates. Remaining `memory_peak < 250 MB` failure
> is GC-noise-dominated artifact in Chromium desktop measurements.
> Phase 8 should ONLY execute if iOS Safari real-device measurements
> confirm memory_peak still > 250 MB after Phase 7.
>
> **Repo**: vunh2301/modern-wars-2
> **Branch**: `phase-8-worker-decode` (off `main` AFTER Phase 7 merge)
> **Owner agent**: Claude Code Sonnet 4.6 (writer) + Claude Opus 4.7 (reviewer)
> **Estimated effort**: 8-12h with self-correction loop
> **Activation gate**: Justin posts iOS bench result showing peak > 250 MB

---

## Context — what Phase 7 left

Phase 7 delivered (committed on `phase-7-prebaked-mesh`):

✅ Pre-baked Mesh approach replaces `addParticle` runtime loop
✅ C2 instanced rendering kept (iter 2 win)
✅ tier-switch 25→10km < 50 ms (was 714 ms)
✅ chunk-build p95 < 5 ms (was 66 ms)
✅ FPS p95 ≥ 90 fps (no regression from Phase 6's 130 fps)
✅ Memory **cumulative settled** 205-230 MB (was 1873 MB)

⚠ Memory **pre-GC peak** 393-519 MB on Chromium desktop, ±32% variance.

Phase 7 retro § 7 hypothesis: **iOS Safari aggressive GC likely shows
peak in cumulative settled range (205-230 MB)** — i.e., iOS may not need
Phase 8 at all. Verification required before activation.

---

## Activation criteria

Phase 8 executes ONLY if **all 3** confirmed by Justin:

1. iPhone 16 Pro Max real-device test run with Safari Web Inspector
2. 60s pan storm @ 10km tier
3. Peak `usedJSHeapSize` measured > 250 MB across 3 reruns

If iOS peak < 250 MB → Phase 8 cancelled, mark this prompt DEPRECATED,
move to Phase 9 (gameplay) instead.

---

## Mission (if activated)

Move chunk decode pipeline off main thread to eliminate pre-GC peak
spikes from main-thread heap.

```
BEFORE (Phase 7):
  main thread:
    fetch → DecompressionStream → ArrayBuffer → DataView parse → Geometry → GPU upload
    ↑ All allocations on main thread heap, GC pressure spikes pre-GC
       sample
AFTER (Phase 8):
  worker thread:
    fetch → DecompressionStream → ArrayBuffer → DataView parse
    → postMessage(transferable: [vertexBuf, indexBuf, tintBuf, edgeBuf])
  main thread:
    receive transferred ArrayBuffers (zero-copy ownership transfer)
    → Geometry from buffers → GPU upload
    ↑ Only Geometry allocation on main thread, far less GC pressure
```

**Key insight**: ArrayBuffer transfer (not copy) via `postMessage` second
argument moves ownership without serialization. Worker decodes 1.25M
hex tier without main thread seeing any of the intermediate allocations.

### Performance targets (hard gates)

| Metric | Phase 7 actual | Phase 8 target | Method |
|---|---:|---:|---|
| memory peak (60s pan @ 10km, iOS Safari) | (TBD from Step 2) | **< 250 MB** | Safari Web Inspector |
| memory peak variance across 3 reruns | ±32% | **< ±10%** | same |
| tier-switch 25→10km | < 50 ms | **< 60 ms** | acceptable degradation |
| chunk-build p95 | < 5 ms | **< 10 ms** | acceptable degradation |
| FPS p95 (pan + zoom + wrap) | ≥ 90 fps | **≥ 85 fps** | no major regression |
| Worker init time | N/A | **< 100 ms** | one-time cost |
| Worker bundle size | N/A | **< 50 KB gzipped** | bundle guard |

Trade-offs accepted:
- Slight latency increase (postMessage overhead ~1-3ms per chunk)
- Worker bundle adds ~50 KB to initial load
- Worker spinup cost ~100ms one-time

---

## Architectural decisions (LOCKED)

### A. Worker entry point

New file `src/workers/chunkDecoder.worker.ts`:

```ts
import type { ChunkRequest, ChunkResponse } from './chunkDecoder.types';

self.onmessage = async (e: MessageEvent<ChunkRequest>) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
    const decompressed = await new Response(stream).arrayBuffer();

    // Parse header + extract typed array views
    const view = new DataView(decompressed);
    // ... validate magic, version, parse offsets
    const vertexBuf = decompressed.slice(...);  // copy into own buffer for transfer
    const indexBuf = decompressed.slice(...);
    const tintBuf = decompressed.slice(...);
    const edgeBuf = decompressed.slice(...);

    const response: ChunkResponse = {
      id,
      ok: true,
      vertices: vertexBuf,
      indices: indexBuf,
      tints: tintBuf,
      borderEdges: edgeBuf,
      bbox: { ... },
      hexCount: ...,
    };

    // Transfer ownership (zero-copy)
    self.postMessage(response, [vertexBuf, indexBuf, tintBuf, edgeBuf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
```

Vite supports worker imports via `?worker` suffix:
```ts
import ChunkDecoderWorker from './workers/chunkDecoder.worker.ts?worker';
const worker = new ChunkDecoderWorker();
```

### B. Worker pool

Single worker insufficient — concurrent chunk decodes block each other.
Spawn pool of N workers, round-robin job assignment:

```ts
class WorkerPool {
  private workers: Worker[];
  private jobQueue: Map<string, { resolve: (b: ChunkBuffers) => void; reject: (e: Error) => void }>;
  private nextWorker = 0;

  constructor(size: number) {
    this.workers = Array.from({ length: size }, () => new ChunkDecoderWorker());
    this.workers.forEach(w => {
      w.onmessage = (e) => this.handleResponse(e.data);
    });
  }

  decode(url: string): Promise<ChunkBuffers> {
    return new Promise((resolve, reject) => {
      const id = `${url}-${Date.now()}`;
      this.jobQueue.set(id, { resolve, reject });
      const worker = this.workers[this.nextWorker];
      this.nextWorker = (this.nextWorker + 1) % this.workers.length;
      worker.postMessage({ id, url });
    });
  }

  destroy() { ... }
}
```

**Pool size**: 2 workers. Enough for 12 visible chunks max (~6 concurrent
loads when entering new viewport region). More workers = more memory
overhead, no benefit since most chunks already cached.

### C. Backpressure & abort

If viewport moves out of range while chunk decoding:
- Mark job as `cancelled` in jobQueue
- Worker still completes (can't cancel mid-fetch reliably) but main
  thread discards result
- LRU cache discards if worker returns chunk no longer in cache window

```ts
const abortController = new AbortController();
worker.postMessage({ id, url, signal: abortController.signal });
// Note: AbortSignal doesn't transfer to worker context — workaround:
// main thread tracks cancelled IDs, ignores responses
```

### D. ChunkCache integration

`src/data/chunks.ts` interface unchanged externally:
```ts
export async function loadChunk(tier: string, col: number, row: number): Promise<ChunkBuffers>;
```

Internal change: `loadChunkInner()` delegates to `WorkerPool.decode(url)`
instead of inline fetch+decompress+parse.

LRU cache logic unchanged.

### E. Fallback for unsupported environments

Web Workers + DecompressionStream both have wide support, but:
- Old iOS (< 14): no DecompressionStream
- Old Safari: no Worker module type

Fallback: detect at module init, fall back to Phase 7 main-thread path
if either missing. Log warning.

```ts
const HAS_WORKER_DECODE_SUPPORT =
  typeof Worker !== 'undefined' &&
  typeof DecompressionStream !== 'undefined';

export const loadChunk = HAS_WORKER_DECODE_SUPPORT
  ? loadChunkViaWorker
  : loadChunkMainThread;  // Phase 7 implementation kept as fallback
```

### F. Transfer ownership rule

**CRITICAL**: ArrayBuffers in `postMessage` second arg are TRANSFERRED,
not copied. After transfer, sender's reference becomes detached (length
0). Worker must use `slice()` or new allocations to create owned buffers
before transferring.

```ts
// CORRECT — slice before transfer (creates own buffer)
const vertexBuf = decompressed.slice(headerSize, headerSize + vertexSize);
self.postMessage({ vertices: vertexBuf }, [vertexBuf]);

// WRONG — would detach decompressed buffer mid-parse
const vertexBuf = new Float32Array(decompressed, headerSize, vertexCount);
self.postMessage({ vertices: vertexBuf.buffer }, [vertexBuf.buffer]);
// ↑ buffer is now detached, subsequent parsing fails
```

Reviewer checklist must verify this.

---

## Implementation phases

### Phase 8.0: Architecture review (MANDATORY before code)

Read these files via repo before designing:

- `docs/phase-7-retro.md` (current memory peak diagnosis)
- `src/data/chunks.ts` (Phase 7 main-thread loader to delegate from)
- `src/render/meshHexLayer.ts` (consumer that won't change)
- `vite.config.ts` (worker config check)

Then write `docs/phase-8-architecture.md` (300-500 lines) covering:

1. Phase 7 main-thread pipeline diagram
2. Phase 8 worker pipeline diagram
3. Transfer ownership rule explanation with code examples
4. Worker pool design + concurrency model
5. Backpressure / cancellation semantics
6. Fallback strategy for unsupported browsers
7. Memory model: where allocations land (worker heap vs main heap)
8. iOS Safari specifics: aggressive GC behavior, transferable support
9. Risk: postMessage latency vs cumulative gain
10. Rollback plan: keep `chunkDecoder.worker.ts` deletable, restore main-thread default

Self-review checklist:
- [ ] Transferable rule respected everywhere?
- [ ] Worker errors propagate to main thread (no orphan rejects)?
- [ ] Worker pool destroy releases all workers?
- [ ] Cancellation doesn't leak job queue entries?
- [ ] Bundle size accounts for worker chunk?
- [ ] Fallback path tested?

### Phase 8.1: Worker scaffold (~2h)

- Create `src/workers/chunkDecoder.worker.ts`
- Create `src/workers/chunkDecoder.types.ts` (shared types)
- Vite config verify worker plugin support
- Standalone test: spawn worker, decode 1 chunk URL, verify output

### Phase 8.2: Worker pool (~2h)

- `src/workers/workerPool.ts` with round-robin + jobQueue
- Cancellation via main-side ID tracking
- Tests: concurrent decode 5 chunks, all return correctly

### Phase 8.3: ChunkCache integration (~1.5h)

- Refactor `src/data/chunks.ts::loadChunkInner` → delegate to worker pool
- Keep main-thread fallback as `loadChunkMainThread`
- Detect support, pick at module init
- A/B switch via `?decode=worker|main` for fallback testing

### Phase 8.4: Memory profiling harness (~1h)

Extend HUD with both pre-GC and settled memory:
```
mem: 230MB used | 519MB peak (last 5s) | 215MB settled
```

Sample at:
- Pre-GC: every 100ms (current)
- Settled: every 2000ms (assume GC ran by then)

Bench script `scripts/bench-phase8-memory.mjs` runs 60s pan storm,
records both numbers, outputs JSON.

### Phase 8.5: Real-device verification (~1h)

REQUIRES Justin to:
1. Run `pnpm dev`
2. Connect iPhone to Mac via cable
3. Enable Web Inspector (Safari → Develop → iPhone → page)
4. Open Memory tab in Web Inspector
5. Run pan storm scenario for 60s
6. Record 3 measurements: peak, settled, post-GC

Claude Code outputs script to automate scenario reproduction. Justin
runs script + posts numbers back.

### Phase 8.6: Self-correction (autonomous, max 2 iterations)

Iteration cap reduced from 3 → 2 (Phase 8 lower priority, don't burn
budget if marginal gains).

Likely candidates if memory still high:
- iter 1: Reduce LRU cap 24 → 16
- iter 2: Stop, propose Phase 9 alternative (e.g., texture atlas hex)

---

## Constraints (must respect)

1. **NO breaking changes** to `src/geo/wrap.ts`, `docs/COORDINATE_SYSTEM.md`
2. **NO new runtime dependencies** beyond what's in package.json
3. **NO gameplay code** (Phase 6 NEGATIVE list still applies)
4. **TypeScript strict mode**
5. **A/B switch required**: `?decode=worker` (default) | `?decode=main` (fallback)
6. **Worker bundle < 50 KB gzipped**
7. **Phase 7 main-thread path stays functional** as fallback
8. **NO premature optimization**: if iOS test shows memory OK in Phase 7,
   STOP and don't ship Phase 8 — explicitly mark prompt DEPRECATED

---

## Reviewer checklists

### Checklist A: Worker correctness
- [ ] Worker properly destroyed on app unmount?
- [ ] Worker errors caught and propagated to main thread?
- [ ] No worker spawn race conditions?
- [ ] postMessage payload validated on main thread?

### Checklist B: Transfer ownership
- [ ] All ArrayBuffers in transfer list match payload references?
- [ ] No detached buffer access after transfer?
- [ ] `slice()` used before transfer to avoid detaching parent?
- [ ] Worker doesn't reuse transferred buffers?

### Checklist C: Memory & lifecycle
- [ ] Cumulative settled memory < 250 MB on iOS?
- [ ] Peak memory < 250 MB on iOS (or within ±10% variance)?
- [ ] Worker pool destroy releases all worker threads?
- [ ] Cancelled jobs don't leak in queue?

### Checklist D: Performance
- [ ] postMessage roundtrip < 5 ms p95?
- [ ] Tier switch within 60 ms (Phase 8 budget)?
- [ ] Chunk build p95 within 10 ms?
- [ ] FPS p95 ≥ 85 fps?

### Checklist E: Fallback
- [ ] Detection logic correct (Worker + DecompressionStream)?
- [ ] Main-thread path still works via `?decode=main`?
- [ ] No crash on unsupported environment?
- [ ] HUD displays current decode mode?

---

## Self-loop budget

| Phase | Budget |
|---|---:|
| 8.0 architecture review | 1.5h |
| 8.1 worker scaffold | 2h |
| 8.2 worker pool | 2h |
| 8.3 cache integration | 1.5h |
| 8.4 memory profiling | 1h |
| 8.5 real-device verification (Justin runs) | 1h (mostly waiting) |
| 8.6 iter 1 | 1.5h |
| 8.6 iter 2 | 1.5h |
| **Total max** | **12h** |

Stop after iter 2 — don't push to iter 3 (architecture sound, marginal
gains unlikely to justify more time).

---

## Output artifacts

```
docs/
├── phase-8-architecture.md       # 8.0 output
├── phase-8-iter-1.md              # if needed
├── phase-8-iter-2.md              # if needed
└── phase-8-retro.md               # final retrospective

src/workers/
├── chunkDecoder.worker.ts        # NEW (~150 lines)
├── chunkDecoder.types.ts         # NEW shared types (~30 lines)
└── workerPool.ts                  # NEW (~120 lines)

src/data/
└── chunks.ts                     # MODIFIED — delegate to worker pool

scripts/
└── bench-phase8-memory.mjs       # NEW automated bench

bench-results/
└── phase-8-final.json            # iOS + Chromium dual numbers
```

---

## Activation flow

```
1. Justin merges Phase 7 to main
2. Justin tests on iPhone 16 Pro Max real device:
   - Connect to Mac, Safari Web Inspector
   - Run pan storm 60s @ 10km tier
   - Record peak + settled memory across 3 runs
3. Decision:
   IF iOS peak < 250 MB:
     → Phase 8 CANCELLED
     → Update this file: STATUS: DEPRECATED — iOS verified Phase 7 sufficient
     → Move to Phase 9 (gameplay)
   IF iOS peak > 250 MB:
     → Phase 8 ACTIVATED
     → Branch off main, execute 8.0-8.6
4. Final decision per iteration:
   IF Phase 8 closes gate → merge
   IF Phase 8 fails after iter 2 → keep Phase 7 ship, document tradeoff
```

---

## Begin (only if activated)

Phase 7 must be merged to main first. Phase 8 starts on `phase-8-worker-decode`
branch off main.

If you're reading this and Justin hasn't posted iOS bench numbers yet —
**WAIT**. Don't start. Phase 8 may be unnecessary.

Good luck.
