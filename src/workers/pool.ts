/**
 * Phase 8 WorkerPool — generic worker pool with pluggable scheduling strategy.
 *
 * Design:
 *  - Lazy spawn (default): workers created on first dispatch(), not on construction.
 *  - warmup(): eager init, spawns all workers, awaits 'ready' handshakes.
 *  - Pluggable scheduler (SchedulingStrategy): Phase 8 default = FifoRoundRobinScheduler.
 *    Phase 9 swaps to PriorityAffinityScheduler at construction without changing call sites.
 *  - Queue backpressure: dispatch() throws QueueFullError synchronously when queue full.
 *  - Cancel protocol: pending jobs removed from queue; in-flight jobs get cancel message.
 *  - destroy(): terminates all workers, rejects all pending jobs.
 *
 * Runtime guard: result.type validated against job.type on receipt.
 * Type mismatch = throw (unreachable in correct code, prevents silent corruption).
 */

import type { DispatchableJob, ResultFor, WorkerResult } from './types';

// ─── Scheduling interfaces ────────────────────────────────────────────────────

export interface WorkerSlot {
  index: number;
  busy: boolean;
  inFlightJobId: string | null;
}

export interface QueueAccessor {
  size(): number;
  capacity(): number;
  /** Append to tail. Returns false if at cap. */
  push(job: DispatchableJob): boolean;
  popById(jobId: string): boolean;
  peek(filter?: (j: DispatchableJob) => boolean): DispatchableJob | undefined;
  shift(): DispatchableJob | undefined;
}

export type EnqueueResult =
  | { kind: 'queued' }
  | { kind: 'dispatched-immediately'; workerIndex: number }
  | { kind: 'rejected'; reason: 'queue-full' };

/** Scheduling policy owns queue management + worker assignment.
 *  Phase 8 default = FifoRoundRobinScheduler.
 *  Phase 9 swaps to PriorityAffinityScheduler without changing WorkerPool API. */
export interface SchedulingStrategy {
  /** Called when new job arrives. Strategy decides: enqueue, drop, or dispatch now. */
  enqueue(
    job: DispatchableJob,
    workers: ReadonlyArray<WorkerSlot>,
    queue: QueueAccessor,
  ): EnqueueResult;
  /** Called when a worker becomes idle. Strategy picks next job (or null). */
  pickNext(workers: ReadonlyArray<WorkerSlot>, queue: QueueAccessor): DispatchableJob | null;
  /** Worker assignment for the picked job. */
  assign(workers: ReadonlyArray<WorkerSlot>, job: DispatchableJob): number;
}

// ─── Pool options ─────────────────────────────────────────────────────────────

export interface WorkerPoolOptions {
  size?: number; // default 4
  lazy?: boolean; // default true (spawn on first dispatch)
  scheduler?: SchedulingStrategy; // default = FifoRoundRobinScheduler
  maxQueueDepth?: number; // default 2 × size
  workerUrl?: URL; // injectable for tests
}

// ─── Error classes ────────────────────────────────────────────────────────────

/** Thrown synchronously by dispatch() when scheduler rejects with queue-full.
 *  Caller catches and decides: retry on next frame, drop silently, surface error. */
export class QueueFullError extends Error {
  constructor(
    public readonly job: DispatchableJob,
    public readonly currentQueueSize: number,
    public readonly capacity: number,
  ) {
    super(
      `WorkerPool queue full (${currentQueueSize}/${capacity}); rejected job ${job.id}`,
    );
    this.name = 'QueueFullError';
  }
}

// ─── Built-in FIFO + round-robin scheduler ────────────────────────────────────

/** Phase 8 default scheduler: FIFO queue + round-robin worker assignment.
 *  Suitable when all jobs have equal priority (decode-chunk only in Phase 8).
 *  Phase 9 replaces with PriorityAffinityScheduler. */
export class FifoRoundRobinScheduler implements SchedulingStrategy {
  private rrCounter = 0;

  enqueue(
    job: DispatchableJob,
    workers: ReadonlyArray<WorkerSlot>,
    queue: QueueAccessor,
  ): EnqueueResult {
    // Try to dispatch immediately to an idle worker.
    const idleIdx = workers.findIndex((w) => !w.busy);
    if (idleIdx >= 0) {
      return { kind: 'dispatched-immediately', workerIndex: idleIdx };
    }
    // All workers busy — try to queue.
    const pushed = queue.push(job);
    if (!pushed) {
      return { kind: 'rejected', reason: 'queue-full' };
    }
    return { kind: 'queued' };
  }

  pickNext(
    _workers: ReadonlyArray<WorkerSlot>,
    queue: QueueAccessor,
  ): DispatchableJob | null {
    return queue.shift() ?? null;
  }

  assign(workers: ReadonlyArray<WorkerSlot>, _job: DispatchableJob): number {
    // Round-robin over idle workers.
    const idle = workers.filter((w) => !w.busy);
    if (idle.length === 0) return 0; // fallback (shouldn't happen in normal flow)
    const idx = this.rrCounter % idle.length;
    this.rrCounter++;
    return idle[idx]!.index;
  }
}

// ─── Internal queue implementation ───────────────────────────────────────────

class BoundedQueue implements QueueAccessor {
  private readonly items: DispatchableJob[] = [];
  constructor(private readonly cap: number) {}

  size(): number {
    return this.items.length;
  }
  capacity(): number {
    return this.cap;
  }
  push(job: DispatchableJob): boolean {
    if (this.items.length >= this.cap) return false;
    this.items.push(job);
    return true;
  }
  popById(jobId: string): boolean {
    const idx = this.items.findIndex((j) => j.id === jobId);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }
  peek(filter?: (j: DispatchableJob) => boolean): DispatchableJob | undefined {
    if (!filter) return this.items[0];
    return this.items.find(filter);
  }
  shift(): DispatchableJob | undefined {
    return this.items.shift();
  }
  clear(): DispatchableJob[] {
    return this.items.splice(0);
  }
}

// ─── Internal pending job tracker ────────────────────────────────────────────

interface PendingEntry {
  job: DispatchableJob;
  resolve: (value: WorkerResult) => void;
  reject: (reason: unknown) => void;
  workerIndex: number | null; // null = queued, number = in-flight on worker
  dispatchedAt: number; // performance.now() for latency tracking
}

// ─── WorkerPool ───────────────────────────────────────────────────────────────

const DEFAULT_POOL_SIZE = 4;

export class WorkerPool {
  private readonly poolSize: number;
  private readonly lazy: boolean;
  private readonly scheduler: SchedulingStrategy;
  private readonly queue: BoundedQueue;
  private readonly workerUrl: URL;

  private workers: Worker[] = [];
  private slots: WorkerSlot[] = [];
  private readySlots: Set<number> = new Set();
  private readyPromises: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  private pendingJobs: Map<string, PendingEntry> = new Map();
  private cancelledIds: Set<string> = new Set(); // cancel arrived before result

  // Stats
  private _queueFullRejects = 0;
  private _totalJobs = 0;
  private latencies: number[] = []; // rolling window, last 100

  constructor(opts: WorkerPoolOptions = {}) {
    this.poolSize = opts.size ?? DEFAULT_POOL_SIZE;
    this.lazy = opts.lazy ?? true;
    this.scheduler = opts.scheduler ?? new FifoRoundRobinScheduler();
    const maxQueue = opts.maxQueueDepth ?? this.poolSize * 2;
    this.queue = new BoundedQueue(maxQueue);

    // Default worker URL — points to decoder.worker.ts (Vite rewrites at build).
    this.workerUrl =
      opts.workerUrl ?? new URL('./decoder.worker.ts', import.meta.url);

    if (!this.lazy) {
      this.spawnAll();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Sound dispatch: result type narrowed by job.type.
   *  Throws QueueFullError synchronously (BEFORE returning Promise) when queue full. */
  dispatch<TType extends DispatchableJob['type']>(
    job: DispatchableJob & { type: TType },
  ): Promise<ResultFor<TType>> {
    this.ensureWorkers();

    const workers = this.slots as ReadonlyArray<WorkerSlot>;
    const result = this.scheduler.enqueue(job, workers, this.queue);

    if (result.kind === 'rejected') {
      this._queueFullRejects++;
      throw new QueueFullError(job, this.queue.size(), this.queue.capacity());
    }

    return new Promise<ResultFor<TType>>((resolve, reject) => {
      const entry: PendingEntry = {
        job,
        resolve: resolve as (value: WorkerResult) => void,
        reject,
        workerIndex: null,
        dispatchedAt: performance.now(),
      };
      this.pendingJobs.set(job.id, entry);

      if (result.kind === 'dispatched-immediately') {
        this.sendToWorker(result.workerIndex, job, entry);
      }
      // else: queued — will be dispatched in drainQueue() when a worker finishes
    });
  }

  /** Cancel a pending or in-flight job.
   *  Pending: removed from queue, promise rejects with AbortError.
   *  In-flight: cancel message sent to worker; result discarded on completion. */
  cancel(jobId: string): void {
    const entry = this.pendingJobs.get(jobId);
    if (!entry) return; // already resolved or unknown

    if (entry.workerIndex === null) {
      // Pending in queue — remove + reject immediately.
      this.queue.popById(jobId);
      this.pendingJobs.delete(jobId);
      entry.reject(new DOMException('Aborted', 'AbortError'));
    } else {
      // In-flight — send cancel to assigned worker, mark for discard.
      this.cancelledIds.add(jobId);
      const worker = this.workers[entry.workerIndex];
      if (worker) {
        worker.postMessage({ type: 'cancel', targetId: jobId });
      }
      // Don't delete from pendingJobs yet — wait for worker result to clean up.
    }
  }

  /** Eager init — resolves after all workers post 'ready' handshake.
   *  Use for cold-start avoidance before first dispatch(). */
  async warmup(): Promise<void> {
    this.ensureWorkers();
    // Wait for all slots to be ready.
    const pending: Promise<void>[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      if (!this.readySlots.has(i)) {
        pending.push(
          new Promise<void>((resolve, reject) => {
            this.readyPromises.push({ resolve, reject });
          }),
        );
      }
    }
    await Promise.all(pending);
  }

  /** Terminate all workers, reject all pending + queued jobs. */
  destroy(): void {
    // Terminate workers (frees OS threads).
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.slots = [];
    this.readySlots.clear();

    // Drain queue + reject all pending.
    const drained = this.queue.clear();
    const abortError = new DOMException('WorkerPool destroyed', 'AbortError');

    for (const job of drained) {
      const entry = this.pendingJobs.get(job.id);
      if (entry) {
        this.pendingJobs.delete(job.id);
        entry.reject(abortError);
      }
    }
    for (const entry of this.pendingJobs.values()) {
      entry.reject(abortError);
    }
    this.pendingJobs.clear();
    this.cancelledIds.clear();
  }

  /** Runtime stats for HUD / bench. */
  stats(): {
    poolSize: number;
    activeJobs: number;
    queueDepth: number;
    queueFullRejects: number;
    totalJobs: number;
    p95LatencyMs: number;
    avgLatencyMs: number;
  } {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p95 =
      sorted.length > 0
        ? (sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]!)
        : 0;
    const avg =
      sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;

    return {
      poolSize: this.poolSize,
      activeJobs: this.slots.filter((s) => s.busy).length,
      queueDepth: this.queue.size(),
      queueFullRejects: this._queueFullRejects,
      totalJobs: this._totalJobs,
      p95LatencyMs: Math.round(p95 * 10) / 10,
      avgLatencyMs: Math.round(avg * 10) / 10,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private ensureWorkers(): void {
    if (this.workers.length === 0) {
      this.spawnAll();
    }
  }

  private spawnAll(): void {
    for (let i = 0; i < this.poolSize; i++) {
      this.spawnOne(i);
    }
  }

  private spawnOne(index: number): void {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    this.workers[index] = worker;
    this.slots[index] = { index, busy: false, inFlightJobId: null };

    worker.addEventListener('message', (ev: MessageEvent<WorkerResult>) => {
      this.handleWorkerMessage(index, ev.data);
    });

    worker.addEventListener('error', (ev: ErrorEvent) => {
      this.handleWorkerError(index, ev);
    });
  }

  private handleWorkerMessage(workerIndex: number, data: WorkerResult | { type: 'ready'; supportsDecompressionStream: boolean } | { type: 'cancel-ack'; targetId: string }): void {
    // Handle control messages first.
    if (data.type === 'ready') {
      this.readySlots.add(workerIndex);
      // Resolve one waiting warmup promise.
      const p = this.readyPromises.shift();
      if (p) p.resolve();
      // Try draining queue now that this worker is ready.
      this.drainQueue(workerIndex);
      return;
    }
    if (data.type === 'cancel-ack') {
      // Optional — just ignore (main already tracking via cancelledIds).
      return;
    }

    // It's a WorkerResult — find matching pending job.
    const result = data as WorkerResult;
    const jobId = result.id;
    const entry = this.pendingJobs.get(jobId);

    // Mark worker as idle.
    const slot = this.slots[workerIndex];
    if (slot) {
      slot.busy = false;
      slot.inFlightJobId = null;
    }

    if (this.cancelledIds.has(jobId)) {
      // Result for a cancelled job — discard.
      this.cancelledIds.delete(jobId);
      this.pendingJobs.delete(jobId);
      this.drainQueue(workerIndex);
      return;
    }

    if (!entry) {
      // Unknown job ID (shouldn't happen in correct code).
      this.drainQueue(workerIndex);
      return;
    }

    this.pendingJobs.delete(jobId);

    // Record latency.
    const latency = performance.now() - entry.dispatchedAt;
    this.latencies.push(latency);
    if (this.latencies.length > 100) this.latencies.shift();
    this._totalJobs++;

    // Runtime guard (Opus MEDIUM): validate result.type === job.type.
    // Mismatch = bug in worker routing; throw diagnostic.
    if (result.type !== entry.job.type) {
      entry.reject(
        new Error(
          `[WorkerPool] result type mismatch: expected '${entry.job.type}', got '${result.type}' for job ${jobId}`,
        ),
      );
      this.drainQueue(workerIndex);
      return;
    }

    entry.resolve(result);

    // Try to pick next queued job for this now-idle worker.
    this.drainQueue(workerIndex);
  }

  private handleWorkerError(workerIndex: number, ev: ErrorEvent): void {
    const slot = this.slots[workerIndex];
    const jobId = slot?.inFlightJobId;

    if (slot) {
      slot.busy = false;
      slot.inFlightJobId = null;
    }

    if (jobId) {
      const entry = this.pendingJobs.get(jobId);
      if (entry) {
        this.pendingJobs.delete(jobId);
        entry.reject(new Error(`[WorkerPool] worker ${workerIndex} error: ${ev.message}`));
      }
    }

    // Respawn worker to keep pool healthy.
    this.spawnOne(workerIndex);
    this.drainQueue(workerIndex);
  }

  private drainQueue(workerIndex: number): void {
    const slot = this.slots[workerIndex];
    if (!slot || slot.busy) return;

    const job = this.scheduler.pickNext(
      this.slots as ReadonlyArray<WorkerSlot>,
      this.queue,
    );
    if (!job) return;

    const entry = this.pendingJobs.get(job.id);
    if (!entry) {
      // Job was cancelled while queued — try next.
      this.drainQueue(workerIndex);
      return;
    }

    this.sendToWorker(workerIndex, job, entry);
  }

  private sendToWorker(
    workerIndex: number,
    job: DispatchableJob,
    entry: PendingEntry,
  ): void {
    const slot = this.slots[workerIndex];
    const worker = this.workers[workerIndex];
    if (!slot || !worker) return;

    slot.busy = true;
    slot.inFlightJobId = job.id;
    entry.workerIndex = workerIndex;

    worker.postMessage(job);
  }
}
