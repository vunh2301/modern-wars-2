/**
 * Offline bake script. SPEC v1.0 Section 4 + 11 Phase 1.
 *
 * For each LOD tier:
 *   1. Build hex grid covering Mercator-projected world bbox.
 *   2. For each hex centroid (lng, lat), point-in-polygon → country ISO.
 *   3. Force-assign mini-states (Vatican, Monaco, Nauru…) so 100% countries
 *      have ≥ 1 hex from tier 25km onward.
 *   4. Emit binary {hexes: [(q, r, countryId), …]} brotli-compressed.
 *
 * Outputs:
 *   public/data/countries.json
 *   public/data/manifest.json
 *   public/data/tiles/world-{tier}.{hash}.bin.br
 *
 * Run: `npm run bake`
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { gzipSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import RBush from 'rbush';

// ─── Config ─────────────────────────────────────────────────────────────────
const TIERS = [
  { name: '50km', sizeKm: 50, source: 'ne_50m' as const, lazy: false },
  { name: '25km', sizeKm: 25, source: 'ne_50m' as const, lazy: false },
  { name: '10km', sizeKm: 10, source: 'ne_10m' as const, lazy: false },
  // Larger tiers deferred — uncomment when ready (each ~minutes bake time):
  // { name: '5km',  sizeKm: 5,  source: 'ne_10m' as const, lazy: true },
  // { name: '2km',  sizeKm: 2,  source: 'ne_10m' as const, lazy: true },
  // { name: '1km',  sizeKm: 1,  source: 'ne_10m' as const, lazy: true },
];

const TIERS_TO_BAKE = (process.env.TIERS ?? '').split(',').filter(Boolean);
const SHOULD_BAKE = (name: string): boolean =>
  TIERS_TO_BAKE.length === 0 || TIERS_TO_BAKE.includes(name);

const OUT_DIR = 'public/data';
const TILES_DIR = join(OUT_DIR, 'tiles');
const NE_50M = 'vendor/ne_50m_admin_0_countries.geojson';
const NE_10M = 'vendor/ne_10m_admin_0_countries.geojson';

// Earth radius (km) — Web Mercator sphere approximation.
const EARTH_R_KM = 6371;
const MAX_LAT = 85; // Mercator lat clamp.
const KM_PER_RAD = EARTH_R_KM;

// ─── Types ──────────────────────────────────────────────────────────────────
type LngLat = [number, number];
type Ring = LngLat[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface FeatureProps {
  ISO_A2?: string;
  ISO_A2_EH?: string;
  NAME?: string;
  NAME_EN?: string;
  ADMIN?: string;
}

interface Feature {
  type: 'Feature';
  properties: FeatureProps;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Polygon | MultiPolygon };
}

interface Country {
  id: number;             // dense numeric ID (1..N), 0 = ocean/unassigned
  code: string;           // ISO_A2 (or fallback)
  name: string;
  centroid: LngLat;       // largest sub-polygon centroid
  bboxLngLat: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  multipoly: MultiPolygon;
}

interface PolyBushItem {
  minX: number; minY: number; maxX: number; maxY: number;
  countryId: number;
  ringIdx: number;        // index into countries[id].multipoly[?].
  polyIdx: number;
}

// ─── Mercator (radians) ────────────────────────────────────────────────────
function lngLatToMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = (lng * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
  return [x, y];
}

function mercatorToLngLat(x: number, y: number): [number, number] {
  const lng = (x * 180) / Math.PI;
  const lat = ((Math.atan(Math.exp(y)) - Math.PI / 4) * 360) / Math.PI;
  return [lng, lat];
}

// ─── Hex math (flat-top axial) ─────────────────────────────────────────────
// Hex inradius in radians. 1 km on the equator ≈ (1/EARTH_R_KM) rad.
function hexInradiusRad(sizeKm: number): number {
  return sizeKm / KM_PER_RAD;
}

function axialToMercator(q: number, r: number, sizeRad: number): [number, number] {
  const x = sizeRad * 1.5 * q;
  const y = sizeRad * Math.sqrt(3) * (r + q / 2);
  return [x, y];
}

// ─── Point-in-polygon (ray casting) ─────────────────────────────────────────
function pointInRingRaw(x: number, y: number, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const yi = a[1], xi = a[0];
    const yj = b[1], xj = b[0];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * PiP that handles antimeridian-crossing rings correctly. Justin feedback
 * 2026-04-26 "alaska, russia bị cắt". When ring spans > 180° in lng,
 * normalize all vertices + query point to [0, 360) range so the ring is
 * monotonic and ray-cast works.
 */
function pointInRing(x: number, y: number, ring: LngLat[]): boolean {
  let minLng = Infinity, maxLng = -Infinity;
  for (const v of ring) {
    if (v[0] < minLng) minLng = v[0];
    if (v[0] > maxLng) maxLng = v[0];
  }
  if (maxLng - minLng < 180) return pointInRingRaw(x, y, ring);
  // Wrapping ring — shift negative lngs by +360 so all vertices in [0, 360).
  const shifted: LngLat[] = ring.map(([lng, lat]) => [lng < 0 ? lng + 360 : lng, lat]);
  const shiftedX = x < 0 ? x + 360 : x;
  return pointInRingRaw(shiftedX, y, shifted);
}

// ─── Centroid (area-weighted on raw lng/lat) ───────────────────────────────
function ringCentroid(ring: LngLat[]): [number, number, number] {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) {
    const p1 = ring[i]!;
    const p2 = ring[i + 1]!;
    const cross = p1[0] * p2[1] - p2[0] * p1[1];
    cx += (p1[0] + p2[0]) * cross;
    cy += (p1[1] + p2[1]) * cross;
    a += cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    let mx = 0, my = 0;
    for (const [x, y] of ring) { mx += x; my += y; }
    return [mx / ring.length, my / ring.length, 0];
  }
  return [cx / (6 * a), cy / (6 * a), Math.abs(a)];
}

function multipolyCentroidAndBBox(
  mp: MultiPolygon,
): { centroid: LngLat; bbox: [number, number, number, number] } {
  let bestArea = 0;
  let bestC: LngLat = [0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of mp) {
    if (poly.length === 0) continue;
    const [cx, cy, a] = ringCentroid(poly[0]!);
    if (a > bestArea) {
      bestArea = a;
      bestC = [cx, cy];
    }
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { centroid: bestC, bbox: [minX, minY, maxX, maxY] };
}

// ─── Load countries from a GeoJSON ──────────────────────────────────────────
// SPEC v1.0-locked Section 1: Antarctica explicit exclude (uninhabited,
// gameplay-irrelevant, dominates south pole hex grid in purple).
const EXCLUDE_CODES = new Set(['AQ']);

// Justin 2026-04-26 "thiếu Somaliland". NE flags Somaliland + N. Cyprus
// as Sovereign country nhưng cả ISO_A2 và ISO_A2_EH đều '-99'. Map ADMIN
// → synthetic 2-char codes (X-prefix not used by ISO 3166-1).
const SYNTHETIC_CODE_BY_ADMIN: Record<string, string> = {
  'Somaliland': 'XM',       // X + reuse Somali first letter
  'Northern Cyprus': 'XN',  // X + Northern
};

function loadCountries(geojsonPath: string): Country[] {
  const fc = JSON.parse(readFileSync(geojsonPath, 'utf8')) as { features: Feature[] };
  const seen = new Set<string>();
  const out: Country[] = [];
  let nextId = 1; // 0 reserved for ocean

  for (const f of fc.features) {
    // Justin 2026-04-26 "mất nước Pháp". NE 50m gắn ISO_A2='-99' (no-code
    // placeholder) cho France/Norway/… nhưng có ISO_A2_EH chuẩn. Code cũ
    // dùng `ISO_A2 || ISO_A2_EH` → lấy '-99' rồi reject. Fix: chỉ chấp
    // nhận ISO_A2 nếu valid 2-char code, else fall back ISO_A2_EH.
    const rawA2 = f.properties.ISO_A2;
    const rawEH = f.properties.ISO_A2_EH;
    const a2Valid = rawA2 && rawA2 !== '-99' && rawA2.length === 2 ? rawA2 : '';
    const ehValid = rawEH && rawEH !== '-99' && rawEH.length === 2 ? rawEH : '';
    let code = a2Valid || ehValid;
    if (!code) {
      // No standard ISO. Use synthetic code only for sovereign-country orphans
      // (Somaliland, N. Cyprus). Skip Indeterminate/Disputed (Siachen Glacier).
      const admin = (f.properties as { ADMIN?: string }).ADMIN ?? '';
      const synth = SYNTHETIC_CODE_BY_ADMIN[admin];
      if (!synth) continue;
      code = synth;
    }
    if (EXCLUDE_CODES.has(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);

    const mp: MultiPolygon =
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates as Polygon]
        : (f.geometry.coordinates as MultiPolygon);

    const { centroid, bbox } = multipolyCentroidAndBBox(mp);
    out.push({
      id: nextId++,
      code,
      name: f.properties.NAME_EN || f.properties.NAME || f.properties.ADMIN || code,
      centroid,
      bboxLngLat: bbox,
      multipoly: mp,
    });
  }
  out.sort((a, b) => (a.code < b.code ? -1 : 1));
  // Re-assign IDs in sorted order so binary output stays deterministic.
  out.forEach((c, i) => { c.id = i + 1; });
  return out;
}

// ─── Build rbush index over country polygon bboxes (per ring) ──────────────
/**
 * Antimeridian-aware bbox builder. Russia, USA Aleutian, Fiji, NZ, Kiribati
 * have outer rings crossing 180° → naive bbox spans entire world (-180..180)
 * → rbush returns them as candidate for every ocean tile → ray-cast PiP false
 * positives → ocean fills with country color.
 *
 * Fix: detect antimeridian crossing (any edge with |lng diff| > 180°). If
 * crossing, build TWO bboxes — one for each side of the antimeridian —
 * by re-projecting western vertices to lng+360 space, computing bbox there,
 * then emitting two rbush items (one normal, one shifted).
 */
function buildPolyBush(countries: Country[]): RBush<PolyBushItem> {
  const bush = new RBush<PolyBushItem>(16);
  const items: PolyBushItem[] = [];
  for (const c of countries) {
    for (let pIdx = 0; pIdx < c.multipoly.length; pIdx++) {
      const ring = c.multipoly[pIdx]?.[0];
      if (!ring || ring.length < 3) continue;

      // Detect antimeridian crossing.
      let crosses = false;
      for (let i = 1; i < ring.length; i++) {
        const dx = Math.abs(ring[i]![0] - ring[i - 1]![0]);
        if (dx > 180) { crosses = true; break; }
      }

      if (!crosses) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        items.push({ minX, minY, maxX, maxY, countryId: c.id, ringIdx: 0, polyIdx: pIdx });
      } else {
        // Build "east" bbox using lngs as-is but ignoring west-of-antimeridian; and "west" bbox vice versa.
        // East piece: vertices with lng > 0 (Eastern hemisphere portion).
        let eMinX = Infinity, eMinY = Infinity, eMaxX = -Infinity, eMaxY = -Infinity;
        let wMinX = Infinity, wMinY = Infinity, wMaxX = -Infinity, wMaxY = -Infinity;
        let hasE = false, hasW = false;
        for (const [x, y] of ring) {
          if (x >= 0) {
            hasE = true;
            if (x < eMinX) eMinX = x;
            if (x > eMaxX) eMaxX = x;
            if (y < eMinY) eMinY = y;
            if (y > eMaxY) eMaxY = y;
          } else {
            hasW = true;
            if (x < wMinX) wMinX = x;
            if (x > wMaxX) wMaxX = x;
            if (y < wMinY) wMinY = y;
            if (y > wMaxY) wMaxY = y;
          }
        }
        if (hasE) items.push({ minX: eMinX, minY: eMinY, maxX: eMaxX, maxY: eMaxY, countryId: c.id, ringIdx: 0, polyIdx: pIdx });
        if (hasW) items.push({ minX: wMinX, minY: wMinY, maxX: wMaxX, maxY: wMaxY, countryId: c.id, ringIdx: 0, polyIdx: pIdx });
      }
    }
  }
  bush.load(items);
  return bush;
}

// ─── Lookup: which country owns this lng/lat ───────────────────────────────
function lookupCountry(
  lng: number,
  lat: number,
  bush: RBush<PolyBushItem>,
  countriesById: Map<number, Country>,
): number {
  const candidates = bush.search({ minX: lng, minY: lat, maxX: lng, maxY: lat });
  for (const c of candidates) {
    const country = countriesById.get(c.countryId);
    if (!country) continue;
    const poly = country.multipoly[c.polyIdx];
    if (!poly) continue;
    if (!pointInRing(lng, lat, poly[0]!)) continue;
    let isHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (pointInRing(lng, lat, poly[i]!)) { isHole = true; break; }
    }
    if (!isHole) return c.countryId;
  }
  return 0; // ocean
}

// ─── Bake one tier ─────────────────────────────────────────────────────────
interface BakedHex { q: number; r: number; countryId: number; }

// Wrap-align constants — match src/geo/projection.ts WRAP_DISTANCE_PX.
// Justin 2026-04-26 "điểm nối map bị cắt 1 lằn → cho nó sát vô".
// Wrap distance phải là bội số chính xác của hex pitch ở mọi tier; chọn
// 50km làm base, all other tiers (25, 10, 5, 2, 1) là divisor của 50 → integer.
const WRAP_BASE_TIER_KM = 50;
const WRAP_HEX_COUNT_BASE = Math.round((2 * Math.PI) / (1.5 * (WRAP_BASE_TIER_KM / KM_PER_RAD)));

function bakeTier(
  sizeKm: number,
  countries: Country[],
  bush: RBush<PolyBushItem>,
): BakedHex[] {
  const countriesById = new Map<number, Country>();
  for (const c of countries) countriesById.set(c.id, c);
  const sizeRad = hexInradiusRad(sizeKm);
  const vertSpacing = Math.sqrt(3) * sizeRad;

  const minMercY = lngLatToMercator(0, -MAX_LAT)[1];
  const maxMercY = lngLatToMercator(0, MAX_LAT)[1];

  // Wrap-aligned q range. wrapHexCount per row = base × (50 / sizeKm).
  // sizeKm phải chia hết 50 (50, 25, 10, 5, 2, 1) → integer count.
  if (WRAP_BASE_TIER_KM % sizeKm !== 0) {
    throw new Error(`tier ${sizeKm}km must divide ${WRAP_BASE_TIER_KM}km for wrap-align`);
  }
  const wrapHexCount = WRAP_HEX_COUNT_BASE * (WRAP_BASE_TIER_KM / sizeKm);
  const qMin = -Math.floor(wrapHexCount / 2);
  const qMax = qMin + wrapHexCount - 1;

  // Shear fix: r range PER q sao cho mỗi cột q phủ đủ y ∈ [minMercY, maxMercY].
  const rBaseLo = minMercY / vertSpacing;
  const rBaseHi = maxMercY / vertSpacing;

  const hexes: BakedHex[] = [];
  let total = 0;
  let oceanSkipped = 0;
  for (let q = qMin; q <= qMax; q++) {
    const halfQ = q / 2;
    const rLo = Math.floor(rBaseLo - halfQ) - 1;
    const rHi = Math.ceil(rBaseHi - halfQ) + 1;
    for (let r = rLo; r <= rHi; r++) {
      const [mx, my] = axialToMercator(q, r, sizeRad);
      if (my < minMercY || my > maxMercY) continue;
      let [lng, lat] = mercatorToLngLat(mx, my);
      // Wrap lng to [-180, 180] for PiP — q at extreme columns may give
      // mercX > π / < -π (those hexes belong to wrap-copies geographically).
      if (lng > 180) lng -= 360;
      else if (lng < -180) lng += 360;
      total++;
      const countryId = lookupCountry(lng, lat, bush, countriesById);
      if (countryId === 0) { oceanSkipped++; continue; }
      hexes.push({ q, r, countryId });
    }
  }
  console.info(`  iterated ${total} hexes, kept ${hexes.length} land, dropped ${oceanSkipped} ocean`);
  return hexes;
}

// ─── Force-assign mini-states ──────────────────────────────────────────────
function forceAssignMissing(
  hexes: BakedHex[],
  countries: Country[],
  sizeKm: number,
): { assigned: number; missing: string[] } {
  const sizeRad = hexInradiusRad(sizeKm);
  const counts = new Map<number, number>();
  for (const h of hexes) counts.set(h.countryId, (counts.get(h.countryId) ?? 0) + 1);

  let assigned = 0;
  const stillMissing: string[] = [];

  for (const country of countries) {
    if ((counts.get(country.id) ?? 0) > 0) continue;
    // Find nearest hex by Mercator distance to country centroid.
    const [tx, ty] = lngLatToMercator(country.centroid[0], country.centroid[1]);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < hexes.length; i++) {
      const h = hexes[i]!;
      const [hx, hy] = axialToMercator(h.q, h.r, sizeRad);
      const dx = hx - tx;
      const dy = hy - ty;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      const hex = hexes[bestIdx]!;
      const oldCountry = countries.find((c) => c.id === hex.countryId);
      const oldCount = counts.get(hex.countryId) ?? 0;
      // Don't steal if the donor has only 1 hex too (would create new missing).
      if (oldCount > 1) {
        hex.countryId = country.id;
        counts.set(country.id, 1);
        counts.set(oldCountry?.id ?? 0, oldCount - 1);
        assigned++;
      } else {
        stillMissing.push(country.code);
      }
    } else {
      stillMissing.push(country.code);
    }
  }
  return { assigned, missing: stillMissing };
}

// ─── Pack hex list to Int32Array (q, r, countryId) and brotli ──────────────
function packHexes(hexes: BakedHex[]): Buffer {
  // Header: magic 4 bytes ("MWHX") + count uint32 + sizeKm uint16 + reserved uint16
  const headerSize = 12;
  const buf = Buffer.alloc(headerSize + hexes.length * 8);
  buf.write('MWHX', 0, 'ascii');
  buf.writeUInt32LE(hexes.length, 4);
  // Body: each hex = q (int16) + r (int16) + countryId (uint16) + reserved (uint16) = 8 bytes
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i]!;
    const off = headerSize + i * 8;
    buf.writeInt16LE(h.q, off);
    buf.writeInt16LE(h.r, off + 2);
    buf.writeUInt16LE(h.countryId, off + 4);
    buf.writeUInt16LE(0, off + 6);
  }
  // Use gzip (level 9) for browser native DecompressionStream('gzip').
  // SPEC mentioned brotli but browser DecompressionStream only supports gzip
  // natively — keeping spec semantics (binary compressed asset) with widely
  // supported codec.
  return gzipSync(buf, { level: constants.Z_BEST_COMPRESSION });
}

function contentHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

// ─── Country names VN (basic seed; extend later) ───────────────────────────
const NAMES_VI: Record<string, string> = {
  US: 'Hoa Kỳ', VN: 'Việt Nam', CN: 'Trung Quốc', JP: 'Nhật Bản', KR: 'Hàn Quốc',
  GB: 'Anh', FR: 'Pháp', DE: 'Đức', RU: 'Nga', IN: 'Ấn Độ',
  AU: 'Úc', BR: 'Brazil', CA: 'Canada', MX: 'Mexico', IT: 'Ý',
  ES: 'Tây Ban Nha', PT: 'Bồ Đào Nha', NL: 'Hà Lan', BE: 'Bỉ', CH: 'Thụy Sĩ',
  SE: 'Thụy Điển', NO: 'Na Uy', FI: 'Phần Lan', DK: 'Đan Mạch', IS: 'Iceland',
  IE: 'Ireland', GR: 'Hy Lạp', TR: 'Thổ Nhĩ Kỳ', EG: 'Ai Cập', SA: 'Saudi Arabia',
  IR: 'Iran', IQ: 'Iraq', PK: 'Pakistan', BD: 'Bangladesh', ID: 'Indonesia',
  TH: 'Thái Lan', PH: 'Philippines', MY: 'Malaysia', SG: 'Singapore', NZ: 'New Zealand',
  ZA: 'Nam Phi', NG: 'Nigeria', KE: 'Kenya', ET: 'Ethiopia', MA: 'Morocco',
  AR: 'Argentina', CL: 'Chile', CO: 'Colombia', PE: 'Peru', VE: 'Venezuela',
};

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const t0 = Date.now();
  console.info('[bake] start');

  if (!existsSync(NE_50M)) throw new Error(`Missing ${NE_50M}`);
  if (!existsSync(NE_10M)) {
    console.warn(`[bake] ${NE_10M} missing — will reuse 50m for higher tiers (degraded mode)`);
  }

  console.info('[bake] loading NE 50m');
  const countries50m = loadCountries(NE_50M);
  console.info(`[bake] NE 50m: ${countries50m.length} countries`);

  let countries10m: Country[] = countries50m;
  if (existsSync(NE_10M)) {
    console.info('[bake] loading NE 10m (slower, larger)');
    countries10m = loadCountries(NE_10M);
    console.info(`[bake] NE 10m: ${countries10m.length} countries`);
  }

  // Re-id 10m to match 50m IDs by code so countryId space is consistent.
  // Strategy: use 50m as source of truth for ID assignment; 10m polygons
  // adopt matching IDs by code, with new codes appended.
  const codeToId = new Map<string, number>();
  for (const c of countries50m) codeToId.set(c.code, c.id);
  let nextId = countries50m.length + 1;
  for (const c of countries10m) {
    let id = codeToId.get(c.code);
    if (id === undefined) {
      id = nextId++;
      codeToId.set(c.code, id);
    }
    c.id = id;
  }

  // Combined country master list (used for force-assignment + countries.json)
  const allCountries = [...countries50m];
  for (const c of countries10m) {
    if (!countries50m.find((x) => x.code === c.code)) allCountries.push(c);
  }
  allCountries.sort((a, b) => a.id - b.id);

  console.info(`[bake] total countries: ${allCountries.length}`);

  const bush50m = buildPolyBush(countries50m);
  const bush10m: RBush<PolyBushItem> = existsSync(NE_10M) ? buildPolyBush(countries10m) : bush50m;

  // ── Per-tier bake ────────────────────────────────────────────────────────
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(TILES_DIR)) mkdirSync(TILES_DIR, { recursive: true });

  // Clean stale tile files
  for (const f of readdirSync(TILES_DIR)) {
    if (f.endsWith('.bin.br') || f.endsWith('.bin.gz') || f.endsWith('.bin')) unlinkSync(join(TILES_DIR, f));
  }

  const manifest: { tiles: Record<string, { file: string; sizeKm: number; hexCount: number; bytesCompressed: number; hash: string }> } = { tiles: {} };

  for (const tier of TIERS) {
    if (!SHOULD_BAKE(tier.name)) {
      console.info(`[bake] skip tier ${tier.name} (not in TIERS env)`);
      continue;
    }
    console.info(`[bake] tier ${tier.name} (${tier.sizeKm}km, source=${tier.source})`);
    const t1 = Date.now();
    const useCountries = tier.source === 'ne_10m' ? countries10m : countries50m;
    const useBush = tier.source === 'ne_10m' ? bush10m : bush50m;
    const hexes = bakeTier(tier.sizeKm, useCountries, useBush);
    const { assigned, missing } = forceAssignMissing(hexes, allCountries, tier.sizeKm);
    console.info(`  force-assigned ${assigned} mini-states, ${missing.length} still missing (${missing.slice(0, 10).join(',')}${missing.length > 10 ? '…' : ''})`);

    const compressed = packHexes(hexes);
    const hash = contentHash(compressed);
    // NB: filename ends `.bin` (NOT `.bin.gz`) so Vercel/Vite don't apply
    // Content-Encoding: gzip and double-decompress. Body content IS gzipped;
    // browser uses DecompressionStream('gzip') manually (src/data/tiers.ts).
    const filename = `world-${tier.name}.${hash}.bin`;
    writeFileSync(join(TILES_DIR, filename), compressed);
    manifest.tiles[tier.name] = {
      file: `tiles/${filename}`,
      sizeKm: tier.sizeKm,
      hexCount: hexes.length,
      bytesCompressed: compressed.length,
      hash,
    };
    console.info(`  → ${filename} (${(compressed.length / 1024).toFixed(1)} KB compressed) in ${Date.now() - t1}ms`);
  }

  // ── countries.json ───────────────────────────────────────────────────────
  const countriesJson = {
    schemaVersion: 1,
    countries: allCountries.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      nameVi: NAMES_VI[c.code] ?? c.name,
      centroid: c.centroid,
      bbox: c.bboxLngLat,
    })),
  };
  writeFileSync(join(OUT_DIR, 'countries.json'), JSON.stringify(countriesJson));
  console.info(`[bake] wrote countries.json (${allCountries.length} entries)`);

  // ── manifest.json ────────────────────────────────────────────────────────
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...manifest }, null, 2));
  console.info(`[bake] wrote manifest.json`);

  console.info(`[bake] done in ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('[bake] FAILED', err);
  process.exit(1);
});
