/**
 * Tier loader. SPEC v1.0 Section 4.2 binary format + Section 7.3 IndexedDB cache.
 *
 * Binary format per bake script:
 *   Header: "MWHX" 4 bytes + count uint32 LE + sizeKm uint16 + reserved uint16
 *   Body  : per hex 8 bytes (q int16, r int16, countryId uint16, _ uint16)
 *
 * Compression: gzip (browser DecompressionStream native).
 * IndexedDB cache deferred Phase 1b; Phase 1 in-memory only.
 */
import { loadManifest, type TierManifestEntry } from './manifest';

export interface HexRecord {
  q: number;
  r: number;
  countryId: number;
}

export interface TierData {
  name: string;
  sizeKm: number;
  hexes: HexRecord[];
}

const cache = new Map<string, Promise<TierData>>();

export async function loadTier(name: string): Promise<TierData> {
  const existing = cache.get(name);
  if (existing) return existing;
  const promise = loadTierInner(name);
  cache.set(name, promise);
  return promise;
}

async function loadTierInner(name: string): Promise<TierData> {
  const manifest = await loadManifest();
  const entry: TierManifestEntry | undefined = manifest.tiles[name];
  if (!entry) throw new Error(`tier ${name} not in manifest`);

  const url = `/data/${entry.file}`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`tier ${name} fetch ${res.status}`);

  // Decompress gzip → ArrayBuffer
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
  const decompressed = await new Response(stream).arrayBuffer();
  const view = new DataView(decompressed);

  // Parse header
  const magic =
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3));
  if (magic !== 'MWHX') throw new Error(`tier ${name} bad magic ${magic}`);
  const count = view.getUint32(4, true);

  // Parse hexes
  const hexes: HexRecord[] = new Array(count);
  let off = 12;
  for (let i = 0; i < count; i++) {
    const q = view.getInt16(off, true);
    const r = view.getInt16(off + 2, true);
    const countryId = view.getUint16(off + 4, true);
    hexes[i] = { q, r, countryId };
    off += 8;
  }

  return { name, sizeKm: entry.sizeKm, hexes };
}
