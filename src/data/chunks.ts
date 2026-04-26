/**
 * Phase 7.2 chunk loader. Reads MWCK v2 (instanced) binary (gzipped) from
 * /public/data/chunks/{tier}/c-{col}-{row}.{hash}.bin and exposes zero-copy
 * views suitable for Pixi v8 Geometry attribute buffers (instanced mode).
 *
 * Phase 7 Iter 2: Format v2 = template + instances + shared index, ~10×
 * smaller than v1 (per-vertex packed).
 *
 * AbortController per fetch — see arch § 8.5.
 */

const HEADER_SIZE = 16;
const TEMPLATE_BYTES = 48;
const INDEX_BYTES = 48;
const FOOTER_SIZE = 32;

export interface ChunkBuffers {
  /** 6 hex template vertices × (x:f32, y:f32) pre-scaled to hexSizeWorldPx. */
  templateBuffer: ArrayBuffer;
  /** Per-hex instance attrs: (cx:f32, cy:f32, RGBA:u8×4) interleaved. */
  instanceBuffer: ArrayBuffer;
  /** Static index buffer (12 uint32 fan triangulation, shared across instances). */
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

/**
 * Fetch + decompress + parse one chunk. Pure function — caller owns caching.
 *
 * Pass an AbortSignal to cancel mid-flight fetch (e.g., on tier switch).
 */
export async function loadChunk(
  entry: ChunkManifestEntry,
  signal?: AbortSignal,
): Promise<ChunkBuffers> {
  const res = await fetch(`/data/${entry.file}`, { credentials: 'omit', signal });
  if (!res.ok) throw new Error(`chunk fetch ${res.status} ${entry.file}`);
  if (!res.body) throw new Error(`chunk body missing ${entry.file}`);

  // Browser-native gzip decompression.
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return parseChunkBinary(arrayBuffer, entry);
}

/** Parse MWCK v2 binary buffer → typed views. Throws on format error. */
export function parseChunkBinary(buf: ArrayBuffer, entry: ChunkManifestEntry): ChunkBuffers {
  const view = new DataView(buf);

  // Header
  const magic =
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3));
  if (magic !== 'MWCK') throw new Error(`${entry.file}: bad magic ${magic}`);
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`${entry.file}: unsupported version ${version} (expected 2)`);
  const tierSizeKm = view.getUint16(8, true);
  const col = view.getUint8(10);
  const row = view.getUint8(11);
  const hexCount = view.getUint32(12, true);
  if (hexCount !== entry.hexCount) {
    throw new Error(`${entry.file}: hexCount ${hexCount} ≠ manifest ${entry.hexCount}`);
  }

  // Template (48 B): 6 verts × (x:f32, y:f32) pre-scaled
  const templateOffset = HEADER_SIZE;
  const templateBuffer = buf.slice(templateOffset, templateOffset + TEMPLATE_BYTES);

  // Instance buffer (hex_count × 12 B)
  const instanceOffset = templateOffset + TEMPLATE_BYTES;
  const instanceBytes = hexCount * 12;
  const instanceBuffer = buf.slice(instanceOffset, instanceOffset + instanceBytes);

  // Static index (48 B = 12 uint32, shared fan triangulation)
  const indexOffset = instanceOffset + instanceBytes;
  const indexBuffer = new Uint32Array(buf.slice(indexOffset, indexOffset + INDEX_BYTES));

  // Edge prefix + edges
  const edgePrefixOffset = indexOffset + INDEX_BYTES;
  const edgeCount = view.getUint32(edgePrefixOffset, true);
  const edgeOffset = edgePrefixOffset + 4;
  const edgeBytes = edgeCount * 16;
  const edgeBuffer = new Float32Array(buf.slice(edgeOffset, edgeOffset + edgeBytes));

  // Footer
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
