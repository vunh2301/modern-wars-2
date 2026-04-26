/**
 * Phase 8.3 chunk loader. Reads MWCK v2 (instanced) binary (gzipped) from
 * /public/data/chunks/{tier}/c-{col}-{row}.{hash}.bin.
 *
 * Phase 8: delegates to WorkerPool (default) or main-thread fallback (?worker=off).
 * Public API unchanged: loadChunk(entry, signal?) returns Promise<ChunkBuffers>.
 * AbortError semantics preserved: signal abort → pool.cancel → promise rejects.
 *
 * Decode path selection (module init, runs once):
 *   ?worker=off              → main-thread (Phase 7.9 path via decoder.ts)
 *   typeof Worker undefined  → main-thread (non-DOM env, e.g. Vitest)
 *   default                  → WorkerPool (decoder.worker.ts)
 *
 * ?worker and ?engine are orthogonal URL params:
 *   ?worker controls decode path (worker vs main-thread)
 *   ?engine controls render path (mesh vs particles, Phase 7 default mesh)
 *
 * Worker memory note: performance.memory reports main thread heap only.
 * Worker heap is invisible. Total process peak = main + Σ(worker heaps).
 */

import { loadAndParse, parseChunkBinary as _parseChunkBinary } from '../workers/decoder';
import type { DecoderManifestEntry } from '../workers/decoder';
import { WorkerPool, QueueFullError } from '../workers/pool';
import type { DecodeChunkResult } from '../workers/types';

const HEADER_SIZE = 16;
const TEMPLATE_BYTES = 48;
const INDEX_BYTES = 48;
const FOOTER_SIZE = 32;

// Re-export constants so existing callers (tests, bake scripts) keep working.
export { HEADER_SIZE, TEMPLATE_BYTES, INDEX_BYTES, FOOTER_SIZE };

export interface ChunkBuffers {
  /** 6 hex template vertices × (x:f32, y:f32) pre-scaled. Each is an independent ArrayBuffer via .slice(). */
  templateBuffer: Uint8Array;
  /** Per-hex instance attrs: (cx:f32, cy:f32, RGBA:u8×4) interleaved. */
  instanceBuffer: Uint8Array;
  /** Static index buffer (12 uint32 fan triangulation). */
  indexBuffer: Uint32Array;
  /** Edge segments [x1, y1, x2, y2, …] (edge_count × 4 floats). */
  edgeBuffer: Float32Array;
  hexCount: number;
  edgeCount: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  centroid: { x: number; y: number };
  tierSizeKm: number;
  col: number;
  row: number;
}

export interface ChunkManifestEntry {
  id: string;
  col: number;
  row: number;
  file: string;
  hexCount: number;
  edgeCount: number;
  bytes: number;
  hash: string;
  bbox: [number, number, number, number];
}

export interface ChunkTierManifest {
  sizeKm: number;
  chunkCount: number;
  hexCount: number;
  bytesCompressed: number;
  chunks: ChunkManifestEntry[];
}

export interface ChunksManifest {
  schemaVersion: 1;
  colorLutHash: string;
  tiers: Record<string, ChunkTierManifest>;
}

// ─── Worker detection (module init — runs once) ───────────────────────────────

// Guard typeof globalThis.location for non-DOM contexts (Vitest/Node).
const supportsWorker =
  typeof Worker !== 'undefined' && typeof globalThis.location !== 'undefined';
const supportsDecompressionStream = typeof DecompressionStream !== 'undefined';

const urlOptOut = (() => {
  if (typeof globalThis.location === 'undefined') return false;
  return new URLSearchParams(globalThis.location.search).get('worker') === 'off';
})();

const useWorker = supportsWorker && supportsDecompressionStream && !urlOptOut;

// Pool size from ?workers=N URL param (default 4).
const workerPoolSize = (() => {
  if (typeof globalThis.location === 'undefined') return 4;
  const n = parseInt(new URLSearchParams(globalThis.location.search).get('workers') ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();

// Singleton pool (lazy init on first dispatch).
let pool: WorkerPool | null = null;

function getPool(): WorkerPool {
  if (!pool) {
    pool = new WorkerPool({ size: workerPoolSize });
  }
  return pool;
}

// ─── Manifest loader ──────────────────────────────────────────────────────────

let manifestPromise: Promise<ChunksManifest> | null = null;

/** Loads /data/chunks/manifest.json once, memoized. */
export async function loadChunksManifest(): Promise<ChunksManifest> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const res = await fetch('/data/chunks/manifest.json', { credentials: 'omit' });
    if (!res.ok) throw new Error(`chunks manifest fetch ${res.status}`);
    const m = (await res.json()) as ChunksManifest;
    if (m.schemaVersion !== 1) {
      throw new Error(`chunks manifest schemaVersion=${m.schemaVersion} unsupported`);
    }
    return m;
  })();
  return manifestPromise;
}

// ─── parseChunkBinary (re-export for backward compat) ────────────────────────

/**
 * Re-export parseChunkBinary from decoder.ts for backward compatibility.
 * ChunkManifestEntry and DecoderManifestEntry have identical shapes — safe cast.
 */
export function parseChunkBinary(
  buf: ArrayBuffer,
  entry: ChunkManifestEntry,
): ChunkBuffers {
  return _parseChunkBinary(buf, entry as DecoderManifestEntry);
}

// ─── Color LUT hash ───────────────────────────────────────────────────────────

/**
 * SHA-256 hash of color LUT bytes (first 12 hex chars) for runtime
 * mismatch detection vs chunkManifest.colorLutHash.
 */
export async function computeColorLutHash(lut: Uint32Array): Promise<string> {
  const bytes = new Uint8Array(lut.byteLength);
  bytes.set(new Uint8Array(lut.buffer, lut.byteOffset, lut.byteLength));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 12);
}

// ─── loadChunk — public API (signature unchanged) ─────────────────────────────

/**
 * Fetch + decompress + parse one chunk. Public API unchanged from Phase 7.9.
 *
 * Phase 8: delegates to WorkerPool by default (?worker=on or absent).
 * Falls back to main-thread decoder.ts when:
 *   - ?worker=off URL param
 *   - typeof Worker === undefined (non-DOM / Vitest)
 *
 * AbortSignal: meshHexLayer passes signal from abortController.
 * Pool cancel wired via signal.addEventListener('abort').
 */
export async function loadChunk(
  entry: ChunkManifestEntry,
  signal?: AbortSignal,
): Promise<ChunkBuffers> {
  if (!useWorker) {
    // Main-thread fallback (Phase 7.9 path via decoder.ts).
    return loadAndParse(entry as DecoderManifestEntry, signal);
  }

  // Worker path — delegate to pool.
  const id = `chunk-${entry.id}-${Math.random().toString(36).slice(2)}`;
  const p = getPool();

  // Wire AbortSignal to cancel (one-shot: once aborted, stays aborted).
  if (signal) {
    signal.addEventListener('abort', () => p.cancel(id), { once: true });
  }

  let result: DecodeChunkResult;
  try {
    result = await p.dispatch({ type: 'decode-chunk', id, entry, tier: entry.id });
  } catch (err) {
    if (err instanceof QueueFullError) {
      // Queue full — re-throw so meshHexLayer can add to retryNextCull.
      throw err;
    }
    throw err;
  }

  if (!result.ok) {
    // Re-raise error with correct name so AbortError is caught by meshHexLayer.
    const error = new Error(result.error);
    error.name = result.errorName;
    // Wrap AbortError as DOMException to match Phase 7.9 semantics.
    if (result.errorName === 'AbortError') {
      throw new DOMException(result.error, 'AbortError');
    }
    throw error;
  }

  // Reconstruct ChunkBuffers from transferred ArrayBuffers.
  // Each buffer was transferred zero-copy from worker; wrap in typed views.
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

// ─── ChunkCache ───────────────────────────────────────────────────────────────

/**
 * LRU cache for decoded ChunkBuffers. Insertion-order Map; on `get` the
 * accessed entry moves to most-recent. On `set`, oldest evicted past `max`.
 *
 * Keys: `${tierName}:c-${col}-${row}` (caller's choice — opaque to cache).
 */
export class ChunkCache {
  private readonly map = new Map<string, ChunkBuffers>();
  constructor(public readonly max = 24) {}

  get(key: string): ChunkBuffers | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Refresh recency: delete + re-insert.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: ChunkBuffers): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ─── Worker pool accessor (for HUD/bench) ────────────────────────────────────

/** Returns current worker pool stats (or null if pool not yet initialized). */
export function getWorkerPoolStats(): ReturnType<WorkerPool['stats']> | null {
  return pool ? pool.stats() : null;
}

/** Returns current decode mode for HUD display. */
export function getDecodeMode(): 'worker' | 'main' {
  return useWorker ? 'worker' : 'main';
}

/** Returns configured pool size. */
export function getWorkerPoolSize(): number {
  return workerPoolSize;
}
