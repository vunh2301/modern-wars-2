/**
 * Phase 8 WorkerPool unit tests — covers Opus/Codex 6.2 review fixes.
 *   B2: cancel() rejects in-flight Promise immediately (no hang).
 *   H1: scheduler.assign() actually drives round-robin worker selection.
 *   H2: ready handshake with supportsDecompressionStream=false → degraded mode,
 *       subsequent dispatch() throws WorkerCapabilityError.
 *
 * Worker is mocked via workerFactory option — no real Worker spawned.
 */
import { describe, test, expect } from 'vitest';
import {
  WorkerPool,
  WorkerCapabilityError,
  FifoRoundRobinScheduler,
} from './pool';
import type { DecodeChunkJob, WorkerInbound, WorkerResult } from './types';

// ─── Mock Worker harness ──────────────────────────────────────────────────────

interface MockWorkerOptions {
  /** Reply with ready handshake on construction. Default true. */
  postReadyOnSpawn?: boolean;
  /** Value of supportsDecompressionStream in ready handshake. Default true. */
  supportsDecompressionStream?: boolean;
  /** Auto-reply to decode-chunk jobs after Nms. Default 0 (sync). */
  jobLatencyMs?: number;
  /** Capture posted inbound messages so tests can assert. */
  captureLog?: WorkerInbound[];
}

class MockWorker {
  // Worker-compatible event listener API.
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  private terminated = false;

  constructor(public readonly opts: MockWorkerOptions = {}) {
    // Post ready synchronously after the pool finishes wiring up listeners.
    // Using queueMicrotask defers to next microtask, after addEventListener fires.
    if (opts.postReadyOnSpawn !== false) {
      queueMicrotask(() => {
        if (this.terminated) return;
        this.dispatchEvent('message', {
          data: {
            type: 'ready',
            supportsDecompressionStream: opts.supportsDecompressionStream ?? true,
          },
        });
      });
    }
  }

  postMessage(msg: WorkerInbound): void {
    if (this.terminated) return;
    if (this.opts.captureLog) this.opts.captureLog.push(msg);

    // Cancel control message — drop, no reply.
    if ((msg as { type?: string }).type === 'cancel') return;

    // Decode-chunk job — auto-reply with success result after configured latency.
    if ((msg as { type?: string }).type === 'decode-chunk') {
      const job = msg as DecodeChunkJob;
      const reply = (): void => {
        if (this.terminated) return;
        const result: WorkerResult = {
          type: 'decode-chunk',
          id: job.id,
          ok: true,
          templateBuffer: new ArrayBuffer(48),
          instanceBuffer: new ArrayBuffer(12),
          indexBuffer: new ArrayBuffer(48),
          edgeBuffer: new ArrayBuffer(0),
          hexCount: 1,
          edgeCount: 0,
          bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          centroid: { x: 0, y: 0 },
          tierSizeKm: 50,
          col: 0,
          row: 0,
        };
        this.dispatchEvent('message', { data: result });
      };
      const latency = this.opts.jobLatencyMs ?? 0;
      if (latency > 0) setTimeout(reply, latency);
      else queueMicrotask(reply);
    }
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  terminate(): void {
    this.terminated = true;
    this.listeners.clear();
  }

  // Internal: fire an event to all registered listeners synchronously.
  dispatchEvent(type: string, ev: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) fn(ev);
  }
}

function makeJob(id: string): DecodeChunkJob {
  return {
    type: 'decode-chunk',
    id,
    entry: {
      id: 'c-0-0',
      col: 0,
      row: 0,
      file: 'fake.bin',
      hexCount: 1,
      edgeCount: 0,
      bytes: 0,
      hash: 'fake',
      bbox: [0, 0, 0, 0],
    },
    tier: 'fake',
  };
}

// ─── B2: cancel rejects in-flight Promise immediately ────────────────────────

describe('WorkerPool cancel (B2 fix)', () => {
  test('cancel() of in-flight job rejects Promise immediately with AbortError', async () => {
    // Slow worker — guarantees cancel races ahead of result.
    const workers: MockWorker[] = [];
    const pool = new WorkerPool({
      size: 1,
      lazy: false,
      workerFactory: () => {
        const w = new MockWorker({ jobLatencyMs: 100 });
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    await pool.warmup();

    const promise = pool.dispatch(makeJob('job-1'));
    pool.cancel('job-1');

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    pool.destroy();
  });

  test('cancel() of queued job rejects Promise with AbortError', async () => {
    const workers: MockWorker[] = [];
    const pool = new WorkerPool({
      size: 1,
      lazy: false,
      workerFactory: () => {
        const w = new MockWorker({ jobLatencyMs: 100 });
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    await pool.warmup();

    // First job occupies the only worker; second job sits in queue.
    const inFlight = pool.dispatch(makeJob('job-A'));
    const queued = pool.dispatch(makeJob('job-B'));

    pool.cancel('job-B');
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });

    // First job still resolves normally.
    await expect(inFlight).resolves.toMatchObject({ ok: true });
    pool.destroy();
  });

  test('cancellations stat increments per cancel call', async () => {
    const pool = new WorkerPool({
      size: 1,
      lazy: false,
      workerFactory: () =>
        new MockWorker({ jobLatencyMs: 100 }) as unknown as Worker,
    });
    await pool.warmup();

    const p1 = pool.dispatch(makeJob('a'));
    const p2 = pool.dispatch(makeJob('b'));
    pool.cancel('a');
    pool.cancel('b');
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.stats().cancellations).toBe(2);
    pool.destroy();
  });
});

// ─── H1: scheduler.assign() round-robin actually drives worker selection ─────

describe('FifoRoundRobinScheduler assign (H1 fix)', () => {
  test('successive dispatches spread across all idle workers', async () => {
    const sentTo: number[] = []; // worker index per posted job
    const workers: MockWorker[] = [];
    const pool = new WorkerPool({
      size: 4,
      lazy: false,
      workerFactory: () => {
        const idx = workers.length;
        const w = new MockWorker({ jobLatencyMs: 50 });
        // Spy on postMessage to record which worker received each job.
        const orig = w.postMessage.bind(w);
        w.postMessage = (msg: WorkerInbound): void => {
          if ((msg as { type?: string }).type === 'decode-chunk') sentTo.push(idx);
          orig(msg);
        };
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    await pool.warmup();

    const promises = [
      pool.dispatch(makeJob('a')),
      pool.dispatch(makeJob('b')),
      pool.dispatch(makeJob('c')),
      pool.dispatch(makeJob('d')),
    ];
    // All 4 dispatched immediately to all 4 workers.
    expect(new Set(sentTo).size).toBe(4);
    await Promise.all(promises);
    pool.destroy();
  });

  test('FifoRoundRobinScheduler.assign rotates index on every call', () => {
    const sched = new FifoRoundRobinScheduler();
    const workers = [
      { index: 0, busy: false, inFlightJobId: null },
      { index: 1, busy: false, inFlightJobId: null },
      { index: 2, busy: false, inFlightJobId: null },
      { index: 3, busy: false, inFlightJobId: null },
    ];
    const job = makeJob('x');
    const picks = [
      sched.assign(workers, job),
      sched.assign(workers, job),
      sched.assign(workers, job),
      sched.assign(workers, job),
    ];
    expect(picks).toEqual([0, 1, 2, 3]);
    // Wraps around.
    expect(sched.assign(workers, job)).toBe(0);
  });
});

// ─── H2: degraded fallback when worker missing DecompressionStream ───────────

describe('WorkerPool degraded fallback (H2 fix)', () => {
  test('worker reports supportsDecompressionStream=false → dispatch throws WorkerCapabilityError', async () => {
    const pool = new WorkerPool({
      size: 1,
      lazy: false,
      workerFactory: () =>
        new MockWorker({ supportsDecompressionStream: false }) as unknown as Worker,
    });
    // warmup awaits ready — degraded flag set during the handshake.
    await pool.warmup();

    expect(() => pool.dispatch(makeJob('job-1'))).toThrow(WorkerCapabilityError);
    expect(pool.stats().degraded).toBe(true);
    pool.destroy();
  });

  test('dispatching while degraded rejects in-flight pending jobs too', async () => {
    // Mix: first worker ready=OK, then a delayed second worker reports DS=false.
    let workerNum = 0;
    const pool = new WorkerPool({
      size: 2,
      lazy: false,
      workerFactory: () => {
        workerNum++;
        // First worker OK; second reports DS=false.
        return new MockWorker({
          supportsDecompressionStream: workerNum === 1,
          jobLatencyMs: 50,
        }) as unknown as Worker;
      },
    });
    await pool.warmup();

    // Pool entered degraded after second worker's ready handshake — every
    // pending job (none here yet) was rejected. Subsequent dispatch throws.
    expect(() => pool.dispatch(makeJob('job-x'))).toThrow(WorkerCapabilityError);
    expect(pool.stats().degraded).toBe(true);
    pool.destroy();
  });
});
