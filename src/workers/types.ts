/**
 * Phase 8 worker message protocol — discriminated union + exhaustiveness helpers.
 *
 * Two distinct unions (rev 3 split):
 *   - DispatchableJob: flows through pool.dispatch(), always has a result type.
 *   - ControlMessage: internal pool ↔ worker plumbing (cancel, ready, cancel-ack).
 *
 * ResultFor<TType> maps job type → result type at compile time.
 * assertNever enforces exhaustiveness in all switches (no plain `default:` allowed).
 */

// `import type` is type-only and elided at compile time — no runtime cycle.
import type { ChunkManifestEntry } from '../data/chunks';

// ─── Dispatchable jobs (each MUST have a matching result type) ────────────────
// Anything in this union is dispatch()-able.
// ResultFor<TType> guarantees result type via Extract<WorkerResult, { type: TType }>.
export type DispatchableJob =
  | DecodeChunkJob
  | PathfindJob   // Phase 9 stub — worker returns NotImplementedError
  | AiTickJob     // Phase 9 stub
  | CombatJob;    // Phase 10+ stub

// ─── Control messages (internal pool ↔ worker, NOT dispatch()-able) ──────────
// CancelMessage: main → worker via direct postMessage by pool.cancel(id).
// Worker → main: 'ready' handshake on spawn, 'cancel-ack' optional.
export type ControlMessage =
  | { type: 'cancel'; targetId: string }
  | { type: 'ready'; supportsDecompressionStream: boolean }
  | { type: 'cancel-ack'; targetId: string };

// Combined wire-format for inbound worker messages (job OR control).
export type WorkerInbound = DispatchableJob | ControlMessage;

// ─── Phase 8 IMPLEMENTS: decode-chunk ────────────────────────────────────────
export interface DecodeChunkJob {
  type: 'decode-chunk';
  id: string;
  // FULL manifest entry — needed for fetch URL (entry.file), validation
  // (entry.hexCount), and bbox-based downstream work. NOT just (tier, col, row).
  entry: ChunkManifestEntry;
  tier: string; // tierName, used for cacheKey on main thread
}

// ─── Phase 9 STUBS (interface locked, worker throws NotImplementedError) ──────
export interface PathfindJob {
  type: 'pathfind';
  id: string;
  startQ: number;
  startR: number;
  goalQ: number;
  goalR: number;
  tierKm: number; // per COORDINATE_SYSTEM.md invariant 1
  maxIterations?: number;
  worldVersion: number; // optimistic concurrency token
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

// ─── Result union ─────────────────────────────────────────────────────────────
export type WorkerResult =
  | DecodeChunkResult
  | PathfindResult
  | AiTickResult
  | CombatResult;

// Decode-chunk SUCCESS shape: 4 separate ArrayBuffers (one per ChunkBuffers
// typed-array field). Transferred via postMessage second-arg list (zero-copy).
// Main wraps each with matching typed view: new Uint8Array(result.templateBuffer), etc.
export type DecodeChunkResult =
  | {
      type: 'decode-chunk';
      id: string;
      ok: true;
      templateBuffer: ArrayBuffer; // → Uint8Array on main
      instanceBuffer: ArrayBuffer; // → Uint8Array
      indexBuffer: ArrayBuffer; //   → Uint32Array
      edgeBuffer: ArrayBuffer; //    → Float32Array
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
      error: string; // human-readable message
      errorName: string; // 'AbortError' | 'NetworkError' | 'ParseError' | 'NotImplementedError'
    };

// Phase 9 result: packed Int16Array (SoA: [q0,r0,q1,r1,...]).
// NOT Array<[number,number]> — avoids 80k garbage objects/sec at 400 paths/sec.
export type PathfindResult =
  | {
      type: 'pathfind';
      id: string;
      ok: true;
      pathBuffer: ArrayBuffer; // Int16Array packed [q0,r0,q1,r1,...]
      pathLen: number;
    }
  | { type: 'pathfind'; id: string; ok: false; error: string; errorName: string };

export type AiTickResult =
  | { type: 'ai-tick'; id: string; ok: true; commands: ArrayBuffer } // SoA payload
  | { type: 'ai-tick'; id: string; ok: false; error: string; errorName: string };

export type CombatResult =
  | { type: 'combat'; id: string; ok: true }
  | { type: 'combat'; id: string; ok: false; error: string; errorName: string };

// ─── Type-level mapping for sound dispatch ───────────────────────────────────
// Keyed by DispatchableJob (NOT WorkerInbound) — control messages don't have
// results. ResultFor<'cancel'> would never resolve, so cancel is excluded
// at the type level by construction.
export type ResultFor<TType extends DispatchableJob['type']> = Extract<
  WorkerResult,
  { type: TType }
>;

// ─── Exhaustiveness helper ───────────────────────────────────────────────────
// Use in `default:` branch of every job/result switch.
// Adding a new job type without updating the switch → TS compile error here.
export function assertNever(x: never, ctx: string): never {
  throw new Error(`[worker] non-exhaustive switch in ${ctx}: ${JSON.stringify(x)}`);
}
