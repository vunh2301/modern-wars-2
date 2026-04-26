/**
 * Phase 8 shared decode helpers — imported by BOTH:
 *   - decoder.worker.ts (runs in worker context)
 *   - src/data/chunks.ts (main-thread fallback path, ?worker=off)
 *
 * MUST NOT import: pixi.js, pixi-viewport, src/data/chunks.ts (circular).
 * MUST NOT have side effects — pure functions only.
 *
 * Extraction note: parseChunkBinary was originally in src/data/chunks.ts.
 * Moved here to break the worker↔chunks circular import:
 *   chunks.ts → pool.ts → worker → chunks.ts (FORBIDDEN)
 *   chunks.ts → pool.ts → worker → decoder.ts (OK — decoder has no pool dep)
 *
 * Stale comment cleanup: Phase 7.9 switched from zero-copy views to .slice()
 * per typed array (chunks.ts commit 2026-04-26). Each returned typed array
 * owns an independent backing ArrayBuffer — safe to transfer via postMessage.
 * The old "zero-copy view" language in the original Phase 7.2 docstring
 * no longer applies and has been removed here.
 */

// ChunkBuffers and ChunkManifestEntry shapes — re-declared here to avoid
// importing chunks.ts. Must stay in sync with src/data/chunks.ts declarations.
// (Using import type from chunks would work but creates an indirect dependency
//  that confuses some bundlers when worker entry is resolved.)

export interface ChunkBuffers {
  /** 6 hex template vertices × (x:f32, y:f32) pre-scaled. */
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

// Minimal subset of ChunkManifestEntry needed by decoder (avoids full import).
export interface DecoderManifestEntry {
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

const HEADER_SIZE = 16;
const TEMPLATE_BYTES = 48;
const INDEX_BYTES = 48;
const FOOTER_SIZE = 32;

/**
 * Parse MWCK v2 binary buffer → typed views.
 *
 * Each returned typed array is backed by its own independent ArrayBuffer
 * (via TypedArray.slice()). This is required for:
 *   1. Pixi v8 WebGPU fastCopy compatibility (descriptor.size must match).
 *   2. Safe postMessage transfer (each buffer can be in transferList independently).
 *
 * Throws on format error (bad magic, version mismatch, size mismatch).
 */
export function parseChunkBinary(
  buf: ArrayBuffer,
  entry: DecoderManifestEntry,
): ChunkBuffers {
  const view = new DataView(buf);

  // Header validation
  const magic =
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3));
  if (magic !== 'MWCK') throw new Error(`${entry.file}: bad magic ${magic}`);

  const version = view.getUint32(4, true);
  if (version !== 2)
    throw new Error(`${entry.file}: unsupported version ${version} (expected 2)`);

  const tierSizeKm = view.getUint16(8, true);
  const col = view.getUint8(10);
  const row = view.getUint8(11);
  const hexCount = view.getUint32(12, true);
  if (hexCount !== entry.hexCount) {
    throw new Error(
      `${entry.file}: hexCount ${hexCount} ≠ manifest ${entry.hexCount}`,
    );
  }

  // Template (48 B): 6 verts × (x:f32, y:f32) pre-scaled.
  // .slice() → independent ArrayBuffer (not a view into `buf`).
  const templateOffset = HEADER_SIZE;
  const templateBuffer = new Uint8Array(buf, templateOffset, TEMPLATE_BYTES).slice();

  // Instance buffer (hexCount × 12 B): (cx:f32, cy:f32, RGBA:u8×4).
  const instanceOffset = templateOffset + TEMPLATE_BYTES;
  const instanceBytes = hexCount * 12;
  const instanceBuffer = new Uint8Array(buf, instanceOffset, instanceBytes).slice();

  // Static index (48 B = 12 uint32 fan triangulation).
  const indexOffset = instanceOffset + instanceBytes;
  const indexBuffer = new Uint32Array(buf, indexOffset, INDEX_BYTES / 4).slice();

  // Edge prefix (4 B) + edge data.
  const edgePrefixOffset = indexOffset + INDEX_BYTES;
  const edgeCount = view.getUint32(edgePrefixOffset, true);
  const edgeOffset = edgePrefixOffset + 4;
  const edgeBytes = edgeCount * 16; // edge_count × 4 floats × 4 bytes
  const edgeBuffer = new Float32Array(buf, edgeOffset, edgeBytes / 4).slice();

  // Footer (32 B): bbox + centroid.
  const footerOffset = edgeOffset + edgeBytes;
  const minX = view.getFloat32(footerOffset, true);
  const minY = view.getFloat32(footerOffset + 4, true);
  const maxX = view.getFloat32(footerOffset + 8, true);
  const maxY = view.getFloat32(footerOffset + 12, true);
  const cx = view.getFloat32(footerOffset + 16, true);
  const cy = view.getFloat32(footerOffset + 20, true);

  const expectedTotal = footerOffset + FOOTER_SIZE;
  if (expectedTotal !== buf.byteLength) {
    throw new Error(
      `${entry.file}: size mismatch — expected ${expectedTotal}, got ${buf.byteLength}`,
    );
  }

  return {
    templateBuffer,
    instanceBuffer,
    indexBuffer,
    edgeBuffer,
    hexCount,
    edgeCount,
    bbox: { minX, minY, maxX, maxY },
    centroid: { x: cx, y: cy },
    tierSizeKm,
    col,
    row,
  };
}

/**
 * Fetch + decompress + parse a chunk binary.
 * Pure function — no caching, no side effects.
 * Shared by worker (decoder.worker.ts) and main-thread fallback (chunks.ts).
 */
export async function loadAndParse(
  entry: DecoderManifestEntry,
  signal?: AbortSignal,
): Promise<ChunkBuffers> {
  const res = await fetch(`/data/${entry.file}`, {
    credentials: 'omit',
    signal,
  });
  if (!res.ok) throw new Error(`chunk fetch ${res.status} ${entry.file}`);
  if (!res.body) throw new Error(`chunk body missing ${entry.file}`);

  // Browser-native gzip decompression.
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return parseChunkBinary(arrayBuffer, entry);
}
