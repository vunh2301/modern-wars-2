/**
 * Phase 7 Codex-review LOW fix: round-trip + ChunkCache unit tests.
 *
 * Run: npm test
 */
import { describe, test, expect } from 'vitest';
import {
  ChunkCache,
  computeColorLutHash,
  parseChunkBinary,
  type ChunkBuffers,
  type ChunkManifestEntry,
} from './chunks';

// ─── Hand-built MWCK v2 binary fixture ─────────────────────────────────────

const HEADER_SIZE = 16;
const TEMPLATE_BYTES = 48;
const INDEX_BYTES = 48;
const FOOTER_SIZE = 32;

function buildSyntheticChunk(opts: {
  hexCount: number;
  edgeCount: number;
  tierSizeKm: number;
  col: number;
  row: number;
  bbox: [number, number, number, number];
  centroid: [number, number];
  version?: number;
  magic?: string;
}): ArrayBuffer {
  const N = opts.hexCount;
  const E = opts.edgeCount;
  const total =
    HEADER_SIZE +
    TEMPLATE_BYTES +
    N * 12 +
    INDEX_BYTES +
    4 +
    E * 16 +
    FOOTER_SIZE;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  const magic = opts.magic ?? 'MWCK';
  for (let i = 0; i < 4; i++) u8[i] = magic.charCodeAt(i);
  view.setUint32(4, opts.version ?? 2, true);
  view.setUint16(8, opts.tierSizeKm, true);
  view.setUint8(10, opts.col);
  view.setUint8(11, opts.row);
  view.setUint32(12, N, true);

  // Template (48 B): 6 vertices × (x:f32, y:f32) = sentinel data
  let off = HEADER_SIZE;
  for (let v = 0; v < 6; v++) {
    view.setFloat32(off, v * 10, true);
    view.setFloat32(off + 4, v * 10 + 1, true);
    off += 8;
  }

  // Instances (N × 12 B)
  for (let i = 0; i < N; i++) {
    view.setFloat32(off, i * 100, true);
    view.setFloat32(off + 4, i * 100 + 50, true);
    view.setUint8(off + 8, (i * 17) & 0xff);
    view.setUint8(off + 9, (i * 31) & 0xff);
    view.setUint8(off + 10, (i * 47) & 0xff);
    view.setUint8(off + 11, 0xff);
    off += 12;
  }

  // Static index (12 uint32 fan triangulation)
  for (let t = 0; t < 4; t++) {
    view.setUint32(off, 0, true);
    view.setUint32(off + 4, t + 1, true);
    view.setUint32(off + 8, t + 2, true);
    off += 12;
  }

  // Edge prefix
  view.setUint32(off, E, true);
  off += 4;

  // Edge segments
  for (let i = 0; i < E; i++) {
    view.setFloat32(off, i, true);
    view.setFloat32(off + 4, i + 0.1, true);
    view.setFloat32(off + 8, i + 0.2, true);
    view.setFloat32(off + 12, i + 0.3, true);
    off += 16;
  }

  // Footer
  view.setFloat32(off, opts.bbox[0], true);
  view.setFloat32(off + 4, opts.bbox[1], true);
  view.setFloat32(off + 8, opts.bbox[2], true);
  view.setFloat32(off + 12, opts.bbox[3], true);
  view.setFloat32(off + 16, opts.centroid[0], true);
  view.setFloat32(off + 20, opts.centroid[1], true);

  return buf;
}

function fakeEntry(N: number, E: number, col = 3, row = 1): ChunkManifestEntry {
  return {
    id: `c-${col}-${row}`,
    col,
    row,
    file: `chunks/50km/c-${col}-${row}.fakehash.bin`,
    hexCount: N,
    edgeCount: E,
    bytes: 0,
    hash: 'fakehash',
    bbox: [-100, -50, +100, +50],
  };
}

// ─── parseChunkBinary tests ────────────────────────────────────────────────

describe('parseChunkBinary', () => {
  test('parses well-formed MWCK v2 chunk', () => {
    const N = 5;
    const E = 3;
    const buf = buildSyntheticChunk({
      hexCount: N,
      edgeCount: E,
      tierSizeKm: 50,
      col: 3,
      row: 1,
      bbox: [-100, -50, 100, 50],
      centroid: [0, 0],
    });
    const parsed: ChunkBuffers = parseChunkBinary(buf, fakeEntry(N, E, 3, 1));
    expect(parsed.hexCount).toBe(N);
    expect(parsed.edgeCount).toBe(E);
    expect(parsed.tierSizeKm).toBe(50);
    expect(parsed.col).toBe(3);
    expect(parsed.row).toBe(1);
    expect(parsed.bbox).toEqual({ minX: -100, minY: -50, maxX: 100, maxY: 50 });
    expect(parsed.centroid).toEqual({ x: 0, y: 0 });
    expect(parsed.templateBuffer.byteLength).toBe(TEMPLATE_BYTES);
    expect(parsed.instanceBuffer.byteLength).toBe(N * 12);
    expect(parsed.indexBuffer.length).toBe(12);
    expect(parsed.edgeBuffer.length).toBe(E * 4);
  });

  test('transferable: returned views have independent ArrayBuffer backing (Phase 8 .slice())', () => {
    // Phase 8: parseChunkBinary uses .slice() on each TypedArray so buffers are
    // independently owned and safe to transfer via postMessage(). They must NOT
    // share the input ArrayBuffer.
    const buf = buildSyntheticChunk({
      hexCount: 2,
      edgeCount: 1,
      tierSizeKm: 25,
      col: 0,
      row: 0,
      bbox: [0, 0, 0, 0],
      centroid: [0, 0],
    });
    const parsed = parseChunkBinary(buf, fakeEntry(2, 1, 0, 0));
    expect(parsed.templateBuffer.buffer).not.toBe(buf);
    expect(parsed.instanceBuffer.buffer).not.toBe(buf);
    expect(parsed.indexBuffer.buffer).not.toBe(buf);
    expect(parsed.edgeBuffer.buffer).not.toBe(buf);
    // Correct data must still be present (sizes match the 2-hex, 1-edge chunk).
    expect(parsed.templateBuffer.byteLength).toBeGreaterThan(0);
    expect(parsed.instanceBuffer.byteLength).toBe(2 * 12);
    expect(parsed.edgeBuffer.byteLength).toBeGreaterThan(0);
  });

  test('rejects bad magic', () => {
    const buf = buildSyntheticChunk({
      hexCount: 1, edgeCount: 0, tierSizeKm: 50, col: 0, row: 0,
      bbox: [0, 0, 0, 0], centroid: [0, 0], magic: 'XXXX',
    });
    expect(() => parseChunkBinary(buf, fakeEntry(1, 0, 0, 0))).toThrow(/bad magic/);
  });

  test('rejects unsupported version', () => {
    const buf = buildSyntheticChunk({
      hexCount: 1, edgeCount: 0, tierSizeKm: 50, col: 0, row: 0,
      bbox: [0, 0, 0, 0], centroid: [0, 0], version: 99,
    });
    expect(() => parseChunkBinary(buf, fakeEntry(1, 0, 0, 0))).toThrow(/unsupported version/);
  });

  test('rejects hexCount mismatch with manifest', () => {
    const buf = buildSyntheticChunk({
      hexCount: 5, edgeCount: 0, tierSizeKm: 50, col: 0, row: 0,
      bbox: [0, 0, 0, 0], centroid: [0, 0],
    });
    // Manifest claims 7 hexes; binary has 5
    expect(() => parseChunkBinary(buf, fakeEntry(7, 0, 0, 0))).toThrow(/hexCount/);
  });

  test('rejects truncated buffer (size mismatch)', () => {
    const buf = buildSyntheticChunk({
      hexCount: 3, edgeCount: 2, tierSizeKm: 50, col: 0, row: 0,
      bbox: [0, 0, 0, 0], centroid: [0, 0],
    });
    const truncated = buf.slice(0, buf.byteLength - 8);
    expect(() => parseChunkBinary(truncated, fakeEntry(3, 2, 0, 0))).toThrow(/size mismatch/);
  });
});

// ─── ChunkCache tests ──────────────────────────────────────────────────────

describe('ChunkCache', () => {
  function dummyBuf(): ChunkBuffers {
    return {
      templateBuffer: new Uint8Array(0),
      instanceBuffer: new Uint8Array(0),
      indexBuffer: new Uint32Array(0),
      edgeBuffer: new Float32Array(0),
      hexCount: 0,
      edgeCount: 0,
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      centroid: { x: 0, y: 0 },
      tierSizeKm: 50,
      col: 0,
      row: 0,
    };
  }

  test('respects max capacity, evicts oldest', () => {
    const cache = new ChunkCache(3);
    cache.set('a', dummyBuf());
    cache.set('b', dummyBuf());
    cache.set('c', dummyBuf());
    cache.set('d', dummyBuf()); // evict 'a'
    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('d')).toBe(true);
  });

  test('get refreshes recency (LRU semantics)', () => {
    const cache = new ChunkCache(3);
    cache.set('a', dummyBuf());
    cache.set('b', dummyBuf());
    cache.set('c', dummyBuf());
    // Touch 'a' to make it most-recent
    cache.get('a');
    cache.set('d', dummyBuf()); // evict oldest non-touched = 'b'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  test('set existing key updates without growing size', () => {
    const cache = new ChunkCache(2);
    cache.set('a', dummyBuf());
    cache.set('a', dummyBuf());
    expect(cache.size).toBe(1);
  });

  test('clear empties cache', () => {
    const cache = new ChunkCache(5);
    cache.set('a', dummyBuf());
    cache.set('b', dummyBuf());
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });
});

// ─── computeColorLutHash test ──────────────────────────────────────────────

describe('computeColorLutHash', () => {
  test('deterministic across calls', async () => {
    const lut = new Uint32Array([0x112233, 0x445566, 0x778899]);
    const h1 = await computeColorLutHash(lut);
    const h2 = await computeColorLutHash(lut);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(12);
  });

  test('different LUTs produce different hashes', async () => {
    const a = new Uint32Array([0x112233]);
    const b = new Uint32Array([0x112234]);
    expect(await computeColorLutHash(a)).not.toBe(await computeColorLutHash(b));
  });
});
