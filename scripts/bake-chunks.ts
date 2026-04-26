/**
 * Phase 7.1 chunk bake — splits each baked tier into 8×4 = 32 per-chunk
 * binary files (MWCK format, gzipped). Replaces runtime addParticle
 * iteration via pre-computed vertex/index/edge buffers ready for GPU upload.
 *
 * Reads:
 *   public/data/manifest.json  (Phase 6 monolithic tier manifest)
 *   public/data/tiles/world-{tier}.{hash}.bin  (gzipped MWHX hex data)
 *   public/data/countries.json (for color LUT bake)
 *
 * Writes:
 *   public/data/chunks/{tier}/c-{col}-{row}.{hash}.bin    (MWCK gzipped)
 *   public/data/chunks/manifest.json                       (chunk manifest)
 *
 * Binary format: see docs/phase-7-architecture.md § 5.
 *
 * Run: npm run bake:chunks
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  kmToWorldPx,
  WRAP_DISTANCE_PX,
  worldBoundsPx,
} from '../src/geo/projection';
import { axialToPx, SQRT_3 } from '../src/geo/hex';
import { normalizeHex } from '../src/geo/wrap';
import { buildColorLut } from '../src/render/colors';
import type { CountryEntry } from '../src/data/countries';

// ─── Constants ─────────────────────────────────────────────────────────────
const COLS = 8;
const ROWS = 4;
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [+1, 0], [+1, -1], [0, -1],
  [-1, 0], [-1, +1], [0, +1],
];
const PERP_F = 0.5 / SQRT_3;

const TIERS_TO_BAKE = (process.env.TIERS ?? '').split(',').filter(Boolean);
const SHOULD_BAKE = (name: string): boolean =>
  TIERS_TO_BAKE.length === 0 || TIERS_TO_BAKE.includes(name);

const BUNDLE_SIZE_CAP_BYTES = 50 * 1024 * 1024;

// ─── Types ─────────────────────────────────────────────────────────────────
interface BakedHex { q: number; r: number; countryId: number }

interface TierManifestEntry {
  file: string;
  sizeKm: number;
  hexCount: number;
  bytesCompressed: number;
  hash: string;
}

interface MonolithicManifest {
  schemaVersion: 1;
  tiles: Record<string, TierManifestEntry>;
}

interface ChunkBbox {
  id: string;
  col: number;
  row: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface ChunkData {
  bbox: ChunkBbox;
  hexes: BakedHex[];
  edges: number[]; // [x1, y1, x2, y2, …]
}

interface ChunkManifestEntry {
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

interface ChunkManifest {
  schemaVersion: 1;
  colorLutHash: string;
  tiers: Record<string, {
    sizeKm: number;
    chunkCount: number;
    hexCount: number;
    bytesCompressed: number;
    chunks: ChunkManifestEntry[];
  }>;
}

// ─── Tier loader (mirrors src/data/tiers.ts MWHX parser) ───────────────────
function loadTierHexes(filepath: string): BakedHex[] {
  const compressed = readFileSync(filepath);
  const buf = gunzipSync(compressed);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic =
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3));
  if (magic !== 'MWHX') throw new Error(`bad magic ${magic} at ${filepath}`);
  const count = view.getUint32(4, true);
  const hexes: BakedHex[] = new Array(count);
  let off = 12;
  for (let i = 0; i < count; i++) {
    const q = view.getInt16(off, true);
    const r = view.getInt16(off + 2, true);
    const countryId = view.getUint16(off + 4, true);
    hexes[i] = { q, r, countryId };
    off += 8;
  }
  return hexes;
}

// ─── Country loader (for color LUT) ─────────────────────────────────────────
function loadCountries(): CountryEntry[] {
  const raw = JSON.parse(readFileSync('public/data/countries.json', 'utf8')) as { countries: CountryEntry[] };
  return raw.countries;
}

// ─── Chunk grid & partition ────────────────────────────────────────────────
function clampInt(v: number, lo: number, hi: number): number {
  const i = Math.floor(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function makeChunkGrid(
  worldMinX: number,
  worldMinY: number,
  worldWidth: number,
  worldHeight: number,
): ChunkData[] {
  const chunkW = worldWidth / COLS;
  const chunkH = worldHeight / ROWS;
  const out: ChunkData[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      out.push({
        bbox: {
          id: `c-${col}-${row}`,
          col,
          row,
          minX: worldMinX + col * chunkW,
          minY: worldMinY + row * chunkH,
          maxX: worldMinX + (col + 1) * chunkW,
          maxY: worldMinY + (row + 1) * chunkH,
        },
        hexes: [],
        edges: [],
      });
    }
  }
  return out;
}

function partitionTier(
  hexes: BakedHex[],
  hexSizeWorldPx: number,
  sizeKm: number,
): ChunkData[] {
  const bounds = worldBoundsPx();
  const worldMinX = -WRAP_DISTANCE_PX / 2;
  const worldWidth = WRAP_DISTANCE_PX;
  const worldMinY = bounds.minY;
  const worldHeight = bounds.height;
  const chunkW = worldWidth / COLS;
  const chunkH = worldHeight / ROWS;

  const chunks = makeChunkGrid(worldMinX, worldMinY, worldWidth, worldHeight);

  // Pass 1: assign hexes by centroid, build wrap-aware lookup map.
  const KEY_OFFSET = 32768;
  const countryByKey = new Map<number, number>();

  for (const h of hexes) {
    const [x, y] = axialToPx(h.q, h.r, hexSizeWorldPx);
    const col = clampInt((x - worldMinX) / chunkW, 0, COLS - 1);
    const row = clampInt((y - worldMinY) / chunkH, 0, ROWS - 1);
    chunks[row * COLS + col]!.hexes.push(h);
    const key = (h.q + KEY_OFFSET) * 65536 + (h.r + KEY_OFFSET);
    countryByKey.set(key, h.countryId);
  }

  // Wrap-aware neighbor lookup via normalizeHex (Phase 6.8 contract).
  const wrapLookup = (q: number, r: number): number | undefined => {
    const [qq, rr] = normalizeHex(q, r, sizeKm);
    return countryByKey.get((qq + KEY_OFFSET) * 65536 + (rr + KEY_OFFSET));
  };

  // Pass 2: compute edges, partition by midpoint.
  for (const h of hexes) {
    const [hx, hy] = axialToPx(h.q, h.r, hexSizeWorldPx);
    for (let n = 0; n < 6; n++) {
      const off = NEIGHBORS[n]!;
      const nq = h.q + off[0];
      const nr = h.r + off[1];
      const neighborCountry = wrapLookup(nq, nr);
      if (neighborCountry === h.countryId) continue;
      if (neighborCountry !== undefined && h.countryId > neighborCountry) continue;
      const [nx, ny] = axialToPx(nq, nr, hexSizeWorldPx);
      const mx = (hx + nx) / 2;
      const my = (hy + ny) / 2;
      const dx = nx - hx;
      const dy = ny - hy;
      const px = -dy * PERP_F;
      const py = dx * PERP_F;
      const col = clampInt((mx - worldMinX) / chunkW, 0, COLS - 1);
      const row = clampInt((my - worldMinY) / chunkH, 0, ROWS - 1);
      chunks[row * COLS + col]!.edges.push(mx + px, my + py, mx - px, my - py);
    }
  }

  return chunks;
}

// ─── Encode per-chunk binary (MWCK format, see arch § 5) ───────────────────
function encodeChunkBinary(
  chunk: ChunkData,
  sizeKm: number,
  hexSizeWorldPx: number,
  lut: Uint32Array,
): Buffer {
  const N = chunk.hexes.length;
  const E = chunk.edges.length / 4;

  const HEADER_SIZE = 16;
  const VERTEX_BYTES = N * 6 * 12;        // 6 verts × (f32+f32+u8×4)
  const INDEX_BYTES = N * 12 * 4;         // 12 indices × u32
  const EDGE_PREFIX = 4;                  // u32 edge_count
  const EDGE_BYTES = E * 16;              // 4 floats
  const FOOTER_SIZE = 32;

  const totalSize = HEADER_SIZE + VERTEX_BYTES + INDEX_BYTES + EDGE_PREFIX + EDGE_BYTES + FOOTER_SIZE;
  const buf = Buffer.alloc(totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Header
  buf.write('MWCK', 0, 'ascii');
  view.setUint32(4, 1, true);
  view.setUint16(8, sizeKm, true);
  view.setUint8(10, chunk.bbox.col);
  view.setUint8(11, chunk.bbox.row);
  view.setUint32(12, N, true);

  // Vertex buffer (interleaved x:f32, y:f32, r:u8, g:u8, b:u8, a:u8)
  let off = HEADER_SIZE;
  for (let i = 0; i < N; i++) {
    const h = chunk.hexes[i]!;
    const [cx, cy] = axialToPx(h.q, h.r, hexSizeWorldPx);
    const tint = lut[h.countryId] ?? 0x666688;
    const r = (tint >> 16) & 0xff;
    const g = (tint >> 8) & 0xff;
    const b = tint & 0xff;
    for (let v = 0; v < 6; v++) {
      const angle = (Math.PI / 3) * v;
      const vx = cx + hexSizeWorldPx * Math.cos(angle);
      const vy = cy + hexSizeWorldPx * Math.sin(angle);
      view.setFloat32(off, vx, true);
      view.setFloat32(off + 4, vy, true);
      view.setUint8(off + 8, r);
      view.setUint8(off + 9, g);
      view.setUint8(off + 10, b);
      view.setUint8(off + 11, 0xff); // alpha
      off += 12;
    }
  }

  // Index buffer (fan triangulation: vertex 0 → (1,2), (2,3), (3,4), (4,5))
  for (let i = 0; i < N; i++) {
    const base = i * 6;
    for (let t = 0; t < 4; t++) {
      view.setUint32(off, base, true);
      view.setUint32(off + 4, base + t + 1, true);
      view.setUint32(off + 8, base + t + 2, true);
      off += 12;
    }
  }

  // Edge prefix
  view.setUint32(off, E, true);
  off += 4;

  // Edge buffer
  for (let i = 0; i < chunk.edges.length; i++) {
    view.setFloat32(off, chunk.edges[i]!, true);
    off += 4;
  }

  // Footer (bbox + centroid; 8 bytes reserved zero already)
  view.setFloat32(off, chunk.bbox.minX, true);
  view.setFloat32(off + 4, chunk.bbox.minY, true);
  view.setFloat32(off + 8, chunk.bbox.maxX, true);
  view.setFloat32(off + 12, chunk.bbox.maxY, true);
  view.setFloat32(off + 16, (chunk.bbox.minX + chunk.bbox.maxX) / 2, true);
  view.setFloat32(off + 20, (chunk.bbox.minY + chunk.bbox.maxY) / 2, true);

  return buf;
}

// ─── Color LUT hash for runtime mismatch check ─────────────────────────────
function lutHash(lut: Uint32Array): string {
  return createHash('sha256').update(Buffer.from(lut.buffer, lut.byteOffset, lut.byteLength)).digest('hex').slice(0, 12);
}

function chunkContentHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

// ─── Verification pass ─────────────────────────────────────────────────────
function verifyChunk(filepath: string, expected: ChunkManifestEntry, sizeKm: number): void {
  const raw = gunzipSync(readFileSync(filepath));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic =
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3));
  if (magic !== 'MWCK') throw new Error(`${filepath}: bad magic ${magic}`);
  const ver = view.getUint32(4, true);
  if (ver !== 1) throw new Error(`${filepath}: bad version ${ver}`);
  const tierKmOnDisk = view.getUint16(8, true);
  if (tierKmOnDisk !== sizeKm) throw new Error(`${filepath}: tier mismatch ${tierKmOnDisk} vs ${sizeKm}`);
  const colOnDisk = view.getUint8(10);
  const rowOnDisk = view.getUint8(11);
  if (colOnDisk !== expected.col || rowOnDisk !== expected.row) {
    throw new Error(`${filepath}: col/row mismatch (${colOnDisk},${rowOnDisk}) vs (${expected.col},${expected.row})`);
  }
  const hexCount = view.getUint32(12, true);
  if (hexCount !== expected.hexCount) {
    throw new Error(`${filepath}: hexCount ${hexCount} vs expected ${expected.hexCount}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const t0 = Date.now();
  console.info('[bake:chunks] start');

  const monolithic = JSON.parse(readFileSync('public/data/manifest.json', 'utf8')) as MonolithicManifest;
  if (monolithic.schemaVersion !== 1) {
    throw new Error(`unexpected schemaVersion ${monolithic.schemaVersion}`);
  }

  const countries = loadCountries();
  const lut = buildColorLut(countries);
  const lutH = lutHash(lut);
  console.info(`[bake:chunks] color LUT hash = ${lutH} (${countries.length} countries)`);

  const outBase = 'public/data/chunks';
  if (!existsSync(outBase)) mkdirSync(outBase, { recursive: true });

  // Wipe stale chunk dirs for tiers we're about to bake.
  for (const tierName of Object.keys(monolithic.tiles)) {
    if (!SHOULD_BAKE(tierName)) continue;
    const dir = join(outBase, tierName);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  const chunkManifest: ChunkManifest = {
    schemaVersion: 1,
    colorLutHash: lutH,
    tiers: {},
  };
  let totalBytes = 0;

  for (const [tierName, entry] of Object.entries(monolithic.tiles)) {
    if (!SHOULD_BAKE(tierName)) {
      console.info(`[bake:chunks] skip tier ${tierName} (not in TIERS env)`);
      continue;
    }
    const t1 = Date.now();
    console.info(`[bake:chunks] tier ${tierName} (${entry.hexCount} hexes)`);

    const hexes = loadTierHexes(join('public/data', entry.file));
    const hexSizeWorldPx = kmToWorldPx(entry.sizeKm);
    const chunks = partitionTier(hexes, hexSizeWorldPx, entry.sizeKm);

    const tierDir = join(outBase, tierName);
    mkdirSync(tierDir, { recursive: true });

    const tierEntries: ChunkManifestEntry[] = [];
    let tierBytes = 0;
    let tierHexCount = 0;

    for (const chunk of chunks) {
      if (chunk.hexes.length === 0) continue; // skip empty (ocean-only)
      const raw = encodeChunkBinary(chunk, entry.sizeKm, hexSizeWorldPx, lut);
      const compressed = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
      const hash = chunkContentHash(compressed);
      const fname = `${chunk.bbox.id}.${hash}.bin`;
      writeFileSync(join(tierDir, fname), compressed);
      tierEntries.push({
        id: chunk.bbox.id,
        col: chunk.bbox.col,
        row: chunk.bbox.row,
        file: `chunks/${tierName}/${fname}`,
        hexCount: chunk.hexes.length,
        edgeCount: chunk.edges.length / 4,
        bytes: compressed.length,
        hash,
        bbox: [chunk.bbox.minX, chunk.bbox.minY, chunk.bbox.maxX, chunk.bbox.maxY],
      });
      tierBytes += compressed.length;
      tierHexCount += chunk.hexes.length;
    }

    chunkManifest.tiers[tierName] = {
      sizeKm: entry.sizeKm,
      chunkCount: tierEntries.length,
      hexCount: tierHexCount,
      bytesCompressed: tierBytes,
      chunks: tierEntries,
    };
    totalBytes += tierBytes;
    console.info(
      `  ${tierEntries.length} chunks, ${tierHexCount.toLocaleString()} hexes, ` +
      `${(tierBytes / 1024 / 1024).toFixed(2)} MB compressed in ${Date.now() - t1}ms`,
    );
  }

  writeFileSync(
    join(outBase, 'manifest.json'),
    JSON.stringify(chunkManifest, null, 2),
  );

  // Verification pass — load every chunk + assert MWCK header + hex_count
  console.info('[bake:chunks] verifying...');
  for (const tier of Object.values(chunkManifest.tiers)) {
    for (const chunk of tier.chunks) {
      verifyChunk(join('public/data', chunk.file), chunk, tier.sizeKm);
    }
  }
  console.info('[bake:chunks] verification OK');

  console.info(`[bake:chunks] total ${(totalBytes / 1024 / 1024).toFixed(2)} MB across all tiers (cap 50 MB)`);
  console.info(`[bake:chunks] done in ${Date.now() - t0}ms`);

  if (totalBytes > BUNDLE_SIZE_CAP_BYTES) {
    console.error('[bake:chunks] BUNDLE SIZE EXCEEDS 50 MB CAP — escalate');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[bake:chunks] FAILED', err);
  process.exit(1);
});
