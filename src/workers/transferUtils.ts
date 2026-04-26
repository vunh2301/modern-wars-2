/**
 * Phase 8 transferable buffer helpers.
 *
 * extractTransferables(result) collects all ArrayBuffers from a WorkerResult
 * for use as the second argument to postMessage(data, transferList).
 *
 * Deduplication via Set prevents double-transfer TypeError (same ArrayBuffer
 * listed twice in transferList throws at runtime).
 *
 * Common Mistakes (see phase-8-architecture.md §7):
 *  1. Don't slice again — parseChunkBinary already slices each view.
 *  2. Don't access result.* after postMessage (buffers are detached).
 *  3. Always pass transferList — omitting causes structured clone (2× memory).
 *  4. Subview transfer detaches parent — parser contract guarantees independent ABs.
 *  5. Helper dedupes via Set — no double-transfer TypeError possible.
 *  6. Don't reuse buffers across jobs — treat post-postMessage locals as invalid.
 */
import { assertNever, type DecodeChunkResult, type WorkerResult } from './types';

/**
 * Collect transferable ArrayBuffers for a DecodeChunkResult.
 * Returns [] for error results (no buffers to transfer).
 */
export function extractDecodeChunkTransferables(r: DecodeChunkResult): ArrayBuffer[] {
  if (!r.ok) return [];
  // Order does not matter — postMessage transferList is semantically a Set.
  // Dedup guards against unlikely aliasing (same AB assigned to two fields).
  const seen = new Set<ArrayBuffer>();
  const out: ArrayBuffer[] = [];
  for (const b of [r.templateBuffer, r.instanceBuffer, r.indexBuffer, r.edgeBuffer]) {
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  return out;
}

/**
 * Generic dispatch — collects transferables for any WorkerResult type.
 * Exhaustive switch with assertNever enforces coverage of all result variants.
 */
export function extractTransferables(r: WorkerResult): ArrayBuffer[] {
  switch (r.type) {
    case 'decode-chunk':
      return extractDecodeChunkTransferables(r);
    case 'pathfind':
      return r.ok ? [r.pathBuffer] : [];
    case 'ai-tick':
      return r.ok ? [r.commands] : [];
    case 'combat':
      return [];
    default:
      return assertNever(r, 'extractTransferables');
  }
}
