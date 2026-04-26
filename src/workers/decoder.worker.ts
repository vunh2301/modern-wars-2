/**
 * Phase 8 decode worker entry point.
 *
 * Lifecycle:
 *   1. On spawn: post { type: 'ready', supportsDecompressionStream } handshake.
 *   2. Listen for DispatchableJob messages — route by type.
 *   3. Listen for ControlMessage cancel — abort in-flight job.
 *
 * MUST NOT import: pixi.js, pixi-viewport, src/data/chunks.ts (circular).
 * Only imports: decoder.ts, types.ts, transferUtils.ts, stubs.ts.
 *
 * Worker bundle gzip < 50KB hard gate (verified by bench-phase8.ts).
 */
import { loadAndParse } from './decoder';
import { handlePathfindStub, handleAiTickStub, handleCombatStub } from './stubs';
import { extractTransferables } from './transferUtils';
import type {
  ControlMessage,
  DecodeChunkJob,
  DispatchableJob,
  WorkerInbound,
  WorkerResult,
} from './types';
import { assertNever } from './types';

// ─── Handshake ────────────────────────────────────────────────────────────────

// Post ready signal immediately on spawn.
// Pool awaits this before dispatching first job to this worker slot.
const supportsDecompressionStream = typeof DecompressionStream !== 'undefined';
self.postMessage({
  type: 'ready',
  supportsDecompressionStream,
} satisfies ControlMessage);

// ─── Per-job AbortController registry ────────────────────────────────────────

// Map from job.id → AbortController for in-flight decode jobs.
// Cancel message looks up controller and calls .abort().
const inFlightControllers = new Map<string, AbortController>();

// ─── Message handler ──────────────────────────────────────────────────────────

self.addEventListener('message', (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;

  // Control messages.
  if (msg.type === 'cancel') {
    handleCancel(msg.targetId);
    return;
  }
  if (msg.type === 'ready' || msg.type === 'cancel-ack') {
    // These are outbound-only (worker → main). Ignore if received inbound.
    return;
  }

  // Dispatchable jobs — async handler, errors caught + posted as error result.
  const job = msg as DispatchableJob;
  void handleJob(job);
});

// ─── Cancel handler ───────────────────────────────────────────────────────────

function handleCancel(targetId: string): void {
  const controller = inFlightControllers.get(targetId);
  if (controller) {
    controller.abort();
    // Controller will be removed in handleJob's finally block.
  }
  // Post cancel-ack (optional — main ignores it, but useful for debugging).
  self.postMessage({ type: 'cancel-ack', targetId } satisfies ControlMessage);
}

// ─── Job dispatcher ───────────────────────────────────────────────────────────

async function handleJob(job: DispatchableJob): Promise<void> {
  switch (job.type) {
    case 'decode-chunk':
      await handleDecodeChunk(job);
      break;
    case 'pathfind': {
      const result = handlePathfindStub(job);
      const xfers = extractTransferables(result);
      self.postMessage(result, { transfer: xfers });
      break;
    }
    case 'ai-tick': {
      const result = handleAiTickStub(job);
      const xfers = extractTransferables(result);
      self.postMessage(result, { transfer: xfers });
      break;
    }
    case 'combat': {
      const result = handleCombatStub(job);
      const xfers = extractTransferables(result);
      self.postMessage(result, { transfer: xfers });
      break;
    }
    default:
      assertNever(job, 'decoder.worker handleJob');
  }
}

// ─── Decode-chunk handler ─────────────────────────────────────────────────────

async function handleDecodeChunk(job: DecodeChunkJob): Promise<void> {
  const controller = new AbortController();
  inFlightControllers.set(job.id, controller);

  try {
    const buffers = await loadAndParse(job.entry, controller.signal);

    // Build DecodeChunkResult with 4 independent ArrayBuffers.
    // parseChunkBinary already called .slice() on each — each buffer is independent.
    // postMessage will transfer (zero-copy) — do NOT access result.* after postMessage.
    // Each TypedArray.buffer is guaranteed to be a plain ArrayBuffer by
    // parseChunkBinary's use of .slice() (not SharedArrayBuffer).
    // Cast to ArrayBuffer is safe here.
    const templateBuffer = buffers.templateBuffer.buffer as ArrayBuffer;
    const instanceBuffer = buffers.instanceBuffer.buffer as ArrayBuffer;
    const indexBuffer = buffers.indexBuffer.buffer as ArrayBuffer;
    const edgeBuffer = buffers.edgeBuffer.buffer as ArrayBuffer;

    const result: WorkerResult = {
      type: 'decode-chunk',
      id: job.id,
      ok: true,
      templateBuffer,
      instanceBuffer,
      indexBuffer,
      edgeBuffer,
      hexCount: buffers.hexCount,
      edgeCount: buffers.edgeCount,
      bbox: buffers.bbox,
      centroid: buffers.centroid,
      tierSizeKm: buffers.tierSizeKm,
      col: buffers.col,
      row: buffers.row,
    };

    // Collect transferables BEFORE postMessage (buffers detach after).
    const transferList = extractTransferables(result);

    // Zero-copy transfer to main thread.
    // After this line: templateBuffer etc. are detached — do NOT read result.*.
    self.postMessage(result, { transfer: transferList });
  } catch (err: unknown) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    const error = err instanceof Error ? err : new Error(String(err));

    const errorResult: WorkerResult = {
      type: 'decode-chunk',
      id: job.id,
      ok: false,
      error: error.message,
      errorName: isAbort ? 'AbortError' : (error.name || 'Error'),
    };
    self.postMessage(errorResult);
  } finally {
    inFlightControllers.delete(job.id);
  }
}
