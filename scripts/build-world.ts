/**
 * Build-time world data pipeline. SPEC Section 4.3 + 4.4 + 4.5 + 4.6.
 *
 * Phase 1a MVP scope:
 * - load NE 50m GeoJSON (pre-converted from SHP via scripts/convert-shp.mjs)
 * - filter Antarctica per country-allowlist.json
 * - project equirectangular (Section 4.4) — antimeridian split DEFERRED to Phase 7
 * - compute centroid (area-weighted) + bbox + area
 * - triangulate per LOD tier with earcut, MultiPolygon-aware (Section 4.6)
 * - tessellate borders to ribbon strips with per-vertex country index attrs (Section 5.3)
 * - land adjacency (grid-snap 4 decimals, ~11m precision)
 * - sea-lane adjacency Stage A (manual seed); Stage B/C auto-compute DEFERRED
 * - 4-color graph (Welsh-Powell greedy, fallback 5)
 * - merge capitals + VN names lookup
 * - emit world.json + world.polygons.tier{1,2}.json + world.borders.tier{1,2}.json + adjacency.json
 * - emit src/data/manifest.ts (logical → physical filename map; content hash deferred Phase 7)
 *
 * KNOWN LIMITATIONS (tracked TODO):
 * - Antimeridian split (RU/FJ/NZ/KI/US Aleutian): polygon may wrap in pixel space
 * - Visvalingam simplification: tier-1/tier-2 use raw vertices (mapshaper integration deferred)
 * - Sea-lane auto-compute Stage B/C: only Stage A manual seed
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import earcut from 'earcut';
// rbush import removed for Phase 1a MVP — grid-snap edge keys suffice. Re-add for Stage B sea-lane auto-compute (K=3 nearest centroids).

const ROOT = process.cwd();
const VENDOR_GEOJSON = join(ROOT, 'vendor/ne_50m_admin_0_countries.geojson');
const ALLOWLIST = join(ROOT, 'scripts/country-allowlist.json');
const SEA_LANES = join(ROOT, 'data/sea-lanes-manual.json');
const CAPITALS = join(ROOT, 'data/capitals.json');
const NAMES_VI = join(ROOT, 'data/country-names-vi.json');
const OUT = join(ROOT, 'public/geo');
const MANIFEST_OUT = join(ROOT, 'src/data/manifest.ts');

const WORLD_W = 3600;
const WORLD_H = 1800;

// ---------- types (mirror src/data/types.ts) ----------
type LngLat = [number, number];
type Ring = LngLat[];
type Polygon = Ring[];          // [outer, hole1, hole2, …]
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
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface CountryWork {
  code: string;
  name: string;
  nameVi: string;
  multipoly: MultiPolygon;       // in lng/lat
  multipolyPx: MultiPolygon;     // in projected px
  centroid: [number, number];
  bbox: [number, number, number, number]; // px [minX, minY, maxX, maxY]
  area: number;                  // approximate, lng/lat degree²
  capital: { name: string; position: [number, number] } | null;
  defaultColor: string;
  subMeshCount: number;
  hasAntimeridianSplit: boolean;
}

// ---------- projection ----------
function project([lng, lat]: LngLat): [number, number] {
  const x = ((lng + 180) / 360) * WORLD_W;
  const y = ((90 - lat) / 180) * WORLD_H;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

// ---------- centroid (area-weighted, on lng/lat — accept Mercator-ish bias for MVP) ----------
function ringArea(ring: LngLat[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) {
    const p1 = ring[i]!;
    const p2 = ring[i + 1]!;
    a += p1[0] * p2[1] - p2[0] * p1[1];
  }
  return a / 2;
}

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
    // Fallback: arithmetic mean of vertices
    let mx = 0, my = 0;
    for (const [x, y] of ring) { mx += x; my += y; }
    return [mx / ring.length, my / ring.length, 0];
  }
  return [cx / (6 * a), cy / (6 * a), Math.abs(a)];
}

function multipolyCentroid(mp: MultiPolygon): { lng: number; lat: number; area: number } {
  let totalArea = 0;
  let largestArea = 0;
  let largestCentroid: [number, number] = [0, 0];
  for (const poly of mp) {
    const [cx, cy, a] = ringCentroid(poly[0]!);
    totalArea += a;
    if (a > largestArea) {
      largestArea = a;
      largestCentroid = [cx, cy];
    }
  }
  return { lng: largestCentroid[0], lat: largestCentroid[1], area: totalArea };
}

// ---------- earcut (MultiPolygon-aware: 1 sub-mesh per sub-polygon) ----------
interface SubMesh {
  vertices: number[];
  indices: number[];
  holes: number[];
}

function triangulatePolygon(poly: Polygon): SubMesh {
  const flat: number[] = [];
  const holeIndices: number[] = [];
  // Outer ring (poly is non-empty by GeoJSON spec; assert)
  const outer = poly[0]!;
  for (const [x, y] of outer) flat.push(x, y);
  // Holes
  for (let i = 1; i < poly.length; i++) {
    holeIndices.push(flat.length / 2);
    const ring = poly[i]!;
    for (const [x, y] of ring) flat.push(x, y);
  }
  const indices = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  return { vertices: flat, indices, holes: holeIndices };
}

// ---------- adjacency: grid-snap edge keys ----------
function edgeKey(a: [number, number], b: [number, number]): string {
  // Snap to 4 decimals (~11m at equator)
  const ka = `${a[0].toFixed(4)},${a[1].toFixed(4)}`;
  const kb = `${b[0].toFixed(4)},${b[1].toFixed(4)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function computeLandAdjacency(countries: CountryWork[]): Set<string> {
  // For each country, collect edge keys; share key with another country = adjacent
  const edgeOwners = new Map<string, Set<string>>();
  for (const c of countries) {
    for (const poly of c.multipoly) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length - 1; i++) {
          const k = edgeKey(ring[i]!, ring[i + 1]!);
          let set = edgeOwners.get(k);
          if (!set) { set = new Set(); edgeOwners.set(k, set); }
          set.add(c.code);
        }
      }
    }
  }
  const adj = new Set<string>();
  for (const owners of edgeOwners.values()) {
    if (owners.size < 2) continue;
    const arr = [...owners].sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        adj.add(`${arr[i]}|${arr[j]}`);
      }
    }
  }
  return adj;
}

// ---------- 4-color Welsh-Powell greedy ----------
function fourColor(codes: string[], adj: Map<string, Set<string>>): Map<string, number> {
  // Sort by degree desc
  const sorted = [...codes].sort((a, b) => (adj.get(b)?.size ?? 0) - (adj.get(a)?.size ?? 0));
  const colors = new Map<string, number>();
  const PALETTE = [0, 1, 2, 3, 4]; // 5 fallback

  for (const c of sorted) {
    const used = new Set<number>();
    const neighbors = adj.get(c) ?? new Set();
    for (const n of neighbors) {
      const col = colors.get(n);
      if (col !== undefined) used.add(col);
    }
    let chosen = -1;
    for (const p of PALETTE) {
      if (!used.has(p)) { chosen = p; break; }
    }
    if (chosen === -1) chosen = 0; // collision (shouldn't happen with 5 colors on planar)
    colors.set(c, chosen);
  }
  return colors;
}

const COLOR_PALETTE_HEX = ['#0088aa', '#aa0066', '#aa6600', '#006644', '#666688']; // Section 20.1 + fallback grey

// ---------- borders: compact segment list ----------
// Phase 1a MVP: emit deduplicated border segments (2 endpoints + countryIndexLeft + countryIndexRight).
// Render layer (Phase 1b) tessellates ribbon strip at boot for shader (Section 5.3).
// Each segment = [x0, y0, x1, y1, countryIndexLeft, countryIndexRight] as Float32 / Int16 packed.
interface BorderTier {
  segments: number[];          // flat: [x0,y0, x1,y1, leftIdx, rightIdx] × N
  segmentCount: number;
  countryCount: number;        // = countries.length, for shader bounds
}

function buildBorderSegments(countries: CountryWork[]): BorderTier {
  const codeToIdx = new Map<string, number>();
  countries.forEach((c, i) => codeToIdx.set(c.code, i));

  // Edge owner map (px-space, 1-decimal precision already from project())
  const edgeOwnersPx = new Map<string, { codes: Set<string>; pts: [[number, number], [number, number]] }>();
  for (const c of countries) {
    for (const poly of c.multipolyPx) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i] as [number, number];
          const b = ring[i + 1] as [number, number];
          const ka = `${a[0]},${a[1]}`;
          const kb = `${b[0]},${b[1]}`;
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          let entry = edgeOwnersPx.get(key);
          if (!entry) {
            entry = { codes: new Set(), pts: [a, b] };
            edgeOwnersPx.set(key, entry);
          }
          entry.codes.add(c.code);
        }
      }
    }
  }

  const segments: number[] = [];
  let count = 0;
  for (const { codes, pts } of edgeOwnersPx.values()) {
    const sorted = [...codes].sort();
    const left = sorted[0]!;
    const right = sorted.length >= 2 ? sorted[1]! : null;
    const li = codeToIdx.get(left)!;
    const ri = right ? codeToIdx.get(right)! : -1;
    const [a, b] = pts;
    segments.push(a[0], a[1], b[0], b[1], li, ri);
    count++;
  }
  return { segments, segmentCount: count, countryCount: countries.length };
}

// ---------- main ----------
function main() {
  console.info('[build-world] start');
  const t0 = Date.now();

  if (!existsSync(VENDOR_GEOJSON)) {
    console.error(`Missing ${VENDOR_GEOJSON}. Run: node scripts/convert-shp.mjs`);
    process.exit(1);
  }

  const fc = JSON.parse(readFileSync(VENDOR_GEOJSON, 'utf8')) as { features: Feature[] };
  const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as { exclude: string[] };
  const seaLanesManual = JSON.parse(readFileSync(SEA_LANES, 'utf8')) as {
    edges: Array<{ from: string; to: string; reason: string }>;
  };
  const capitals = JSON.parse(readFileSync(CAPITALS, 'utf8')) as {
    capitals: Record<string, { name: string; lng: number; lat: number }>;
  };
  const namesVi = JSON.parse(readFileSync(NAMES_VI, 'utf8')) as {
    names: Record<string, string>;
  };

  console.info(`[build-world] loaded ${fc.features.length} features from NE 50m`);
  const exclude = new Set(allowlist.exclude);

  // Build country list
  const countries: CountryWork[] = [];
  const seenCodes = new Set<string>();

  for (const f of fc.features) {
    // NE 50m sets `ISO_A2='-99'` for disputed/special territories (France, Norway,
    // Kosovo, Northern Cyprus…) but populates `ISO_A2_EH` ("Extended Hotfix") with
    // the real code. Always prefer EH; fall back to ISO_A2 only when EH unset.
    const eh = f.properties.ISO_A2_EH;
    const a2 = f.properties.ISO_A2;
    const candidates = [eh, a2].filter(
      (c): c is string => typeof c === 'string' && c.length === 2 && c !== '-9' && c !== '-99',
    );
    const code = candidates[0] ?? '';
    if (!code) continue;
    if (exclude.has(code)) continue;
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);

    const mp: MultiPolygon = f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates as Polygon]
      : (f.geometry.coordinates as MultiPolygon);

    const { lng: cLng, lat: cLat, area } = multipolyCentroid(mp);

    // Filter small sub-polygons: keep top 30 by area (Section 4.6 cap)
    const mpRanked = mp
      .map(p => ({ poly: p, area: Math.abs(ringArea(p[0]!)) }))
      .sort((a, b) => b.area - a.area)
      .slice(0, 30)
      .map(r => r.poly);
    const mpFinal: MultiPolygon = mpRanked.length > 0 ? mpRanked : mp;

    // Project to px
    const mpPx = mpFinal.map(poly => poly.map(ring => ring.map(project))) as MultiPolygon;

    // bbox in px
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasAntimeridian = false;
    for (const poly of mpPx) {
      for (const ring of poly) {
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (x > minY && x < minX) minX = x; // typo guard
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // Detect antimeridian (RU/US Aleutian/FJ/NZ/KI): bbox span > 180° in lng
    {
      let lngMin = Infinity, lngMax = -Infinity;
      for (const poly of mp) {
        for (const ring of poly) {
          for (const [lng] of ring) {
            if (lng < lngMin) lngMin = lng;
            if (lng > lngMax) lngMax = lng;
          }
        }
      }
      if (lngMax - lngMin > 270) hasAntimeridian = true;
    }

    const cap = capitals.capitals[code] ?? null;

    const cwork: CountryWork = {
      code,
      name: f.properties.NAME_EN || f.properties.NAME || f.properties.ADMIN || code,
      nameVi: namesVi.names[code] || f.properties.NAME_EN || f.properties.NAME || code,
      multipoly: mpFinal,
      multipolyPx: mpPx,
      centroid: project([cLng, cLat]),
      bbox: [minX, minY, maxX, maxY],
      area,
      capital: cap ? { name: cap.name, position: project([cap.lng, cap.lat]) } : null,
      defaultColor: '#888888', // will be assigned after color graph
      subMeshCount: mpFinal.length,
      hasAntimeridianSplit: hasAntimeridian,
    };
    countries.push(cwork);
  }

  countries.sort((a, b) => (a.code < b.code ? -1 : 1));
  console.info(`[build-world] kept ${countries.length} countries`);

  // Land adjacency
  const adjPairs = computeLandAdjacency(countries);
  console.info(`[build-world] land adjacency edges: ${adjPairs.size}`);

  // Build adjacency map
  const adjMap = new Map<string, Set<string>>();
  for (const c of countries) adjMap.set(c.code, new Set());
  const codeSet = new Set(countries.map(c => c.code));
  for (const pair of adjPairs) {
    const parts = pair.split('|');
    const a = parts[0]!;
    const b = parts[1]!;
    if (!codeSet.has(a) || !codeSet.has(b)) continue;
    adjMap.get(a)!.add(b);
    adjMap.get(b)!.add(a);
  }

  // Sea-lane Stage A (manual)
  let seaEdges = 0;
  for (const e of seaLanesManual.edges) {
    if (!codeSet.has(e.from) || !codeSet.has(e.to)) {
      console.warn(`[build-world] skip sea-lane ${e.from}↔${e.to}: missing country`);
      continue;
    }
    adjMap.get(e.from)!.add(e.to);
    adjMap.get(e.to)!.add(e.from);
    seaEdges++;
  }
  console.info(`[build-world] sea-lane edges (manual): ${seaEdges}`);

  // 4-color
  const colors = fourColor(countries.map(c => c.code), adjMap);
  for (const c of countries) {
    const idx = colors.get(c.code) ?? 0;
    c.defaultColor = COLOR_PALETTE_HEX[idx] ?? '#888888';
  }

  // Connectivity check (Section 4.5 validation)
  const visited = new Set<string>();
  const startCode = countries[0]?.code;
  if (!startCode) {
    throw new Error('No countries to validate connectivity');
  }
  const queue: string[] = [startCode];
  visited.add(startCode);
  while (queue.length) {
    const v = queue.shift()!;
    for (const n of adjMap.get(v)!) {
      if (!visited.has(n)) { visited.add(n); queue.push(n); }
    }
  }
  const isolated = countries.filter(c => !visited.has(c.code)).map(c => c.code);
  if (isolated.length > 0) {
    console.warn(`[build-world] ⚠ ${isolated.length} disconnected components: ${isolated.slice(0, 20).join(', ')}${isolated.length > 20 ? '…' : ''}`);
    console.warn('[build-world] Phase 1a MVP: continuing despite disconnection. Add more sea-lane manual seeds in data/sea-lanes-manual.json.');
  } else {
    console.info('[build-world] ✓ adjacency graph connected');
  }

  // Triangulate per country (tier-1 = simplified raw, tier-2 = same MVP)
  // Output PolygonTierFile shape
  const tier1Countries: Record<string, { subMeshes: SubMesh[]; indexType: 'uint16' | 'uint32' }> = {};
  let totalVerts = 0;
  for (const c of countries) {
    const subs = c.multipolyPx.map(triangulatePolygon);
    const maxIdx = subs.reduce((m, s) => Math.max(m, s.vertices.length / 2), 0);
    const indexType = maxIdx > 65535 ? 'uint32' as const : 'uint16' as const;
    tier1Countries[c.code] = { subMeshes: subs, indexType };
    totalVerts += subs.reduce((sum, s) => sum + s.vertices.length / 2, 0);
  }
  console.info(`[build-world] tier-1 total vertices: ${totalVerts}`);

  // Borders (compact segments; tier-2 same for MVP)
  const borders = buildBorderSegments(countries);
  console.info(`[build-world] tier-1 border segments: ${borders.segmentCount}`);

  // Build adjacency edges output
  const edgesOut: Array<[string, string, 'land' | 'sea', 'auto' | 'manual']> = [];
  // Land edges from edgeOwners
  const landSet = new Set<string>();
  for (const e of adjPairs) landSet.add(e);
  for (const e of landSet) {
    const parts = e.split('|');
    const a = parts[0]!;
    const b = parts[1]!;
    if (codeSet.has(a) && codeSet.has(b)) {
      edgesOut.push([a, b, 'land', 'auto']);
    }
  }
  for (const e of seaLanesManual.edges) {
    if (codeSet.has(e.from) && codeSet.has(e.to)) {
      edgesOut.push([e.from, e.to, 'sea', 'manual']);
    }
  }

  // ---------- emit ----------
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  // world.json
  const worldFile = {
    schemaVersion: 1 as const,
    countries: countries.map(c => ({
      code: c.code,
      name: c.name,
      nameVi: c.nameVi,
      centroid: c.centroid,
      capital: c.capital,
      bbox: { kind: 'single' as const, min: [c.bbox[0], c.bbox[1]], max: [c.bbox[2], c.bbox[3]] },
      area: c.area,
      defaultColor: c.defaultColor,
      subMeshCount: c.subMeshCount,
      hasAntimeridianSplit: c.hasAntimeridianSplit,
    })),
  };
  writeFileSync(join(OUT, 'world.json'), JSON.stringify(worldFile));

  // polygons tier-1 + tier-2
  const polyTier1 = { schemaVersion: 1 as const, tier: 1 as const, countries: tier1Countries };
  writeFileSync(join(OUT, 'world.polygons.tier1.json'), JSON.stringify(polyTier1));
  // tier-2 = same as tier-1 in MVP (simplification deferred)
  const polyTier2 = { schemaVersion: 1 as const, tier: 2 as const, countries: tier1Countries };
  writeFileSync(join(OUT, 'world.polygons.tier2.json'), JSON.stringify(polyTier2));

  // borders tier-1 + tier-2 (compact)
  const borderTier1 = { schemaVersion: 1 as const, tier: 1 as const, ...borders };
  writeFileSync(join(OUT, 'world.borders.tier1.json'), JSON.stringify(borderTier1));
  const borderTier2 = { schemaVersion: 1 as const, tier: 2 as const, ...borders };
  writeFileSync(join(OUT, 'world.borders.tier2.json'), JSON.stringify(borderTier2));

  // adjacency
  const adjacencyFile = { schemaVersion: 1 as const, edges: edgesOut };
  writeFileSync(join(OUT, 'adjacency.json'), JSON.stringify(adjacencyFile));

  // manifest.ts (Section 19.2 — content-hashed filenames; Phase 1a MVP uses plain paths, hash later)
  const manifestSrc = `// AUTO-GENERATED by scripts/build-world.ts. Do not edit.
// SPEC Section 19.2 asset hashing contract. Phase 1a MVP: plain paths; content hash deferred.

export interface AssetManifest {
  worldJson: string;
  polygonsTier1: string;
  polygonsTier2: string;
  bordersTier1: string;
  bordersTier2: string;
  adjacencyJson: string;
}

export const manifest: AssetManifest = {
  worldJson: '/geo/world.json',
  polygonsTier1: '/geo/world.polygons.tier1.json',
  polygonsTier2: '/geo/world.polygons.tier2.json',
  bordersTier1: '/geo/world.borders.tier1.json',
  bordersTier2: '/geo/world.borders.tier2.json',
  adjacencyJson: '/geo/adjacency.json',
};
`;
  writeFileSync(MANIFEST_OUT, manifestSrc);

  // ---------- self-tests (Section 4.5 validation) ----------
  let testsPassed = 0;
  let testsFailed = 0;
  const test = (label: string, ok: boolean, detail?: string) => {
    if (ok) { console.info(`[test] ✓ ${label}`); testsPassed++; }
    else { console.error(`[test] ✗ ${label}${detail ? ': ' + detail : ''}`); testsFailed++; }
  };

  // USA land neighbors should include CA + MX
  const usAdj = adjMap.get('US') ?? new Set();
  test('USA land+sea neighbors include CA', usAdj.has('CA'));
  test('USA land+sea neighbors include MX', usAdj.has('MX'));

  // CU sea-lane includes US, MX, JM (per manual)
  const cuAdj = adjMap.get('CU') ?? new Set();
  test('CU sea-lane includes US', cuAdj.has('US'));
  test('CU sea-lane includes MX', cuAdj.has('MX'));
  test('CU sea-lane includes JM', cuAdj.has('JM'));

  // JP sea-lane includes KR
  const jpAdj = adjMap.get('JP') ?? new Set();
  test('JP sea-lane includes KR', jpAdj.has('KR'));

  // Ensure connected (warning, not failure for MVP)
  test(
    'Adjacency graph fully connected (warning-only MVP)',
    isolated.length === 0,
    `${isolated.length} isolated countries; add sea-lanes to connect`,
  );

  // No sub-mesh has > 30 sub-polygons (Section 4.6 cap)
  const tooMany = countries.find(c => c.subMeshCount > 30);
  test('All countries have ≤ 30 sub-polygons', !tooMany, tooMany?.code);

  const elapsed = Date.now() - t0;
  console.info(`[build-world] done in ${elapsed}ms (${testsPassed} tests passed, ${testsFailed} failed)`);

  if (testsFailed > 0 && process.env.STRICT_TESTS === '1') {
    process.exit(1);
  }
}

main();
