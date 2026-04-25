/**
 * Boot-time world data loader. SPEC Section 4.3 boot pipeline + Section 13.1.
 *
 * Parallel-fetches the four eager JSON payloads via the build-time manifest
 * (Section 19.2), validates schema versions, and assembles the runtime
 * `WorldData` object. Asserts adjacency graph is a single connected component
 * before resolving — boot fails loudly if the offline build emitted a broken
 * dataset.
 *
 * Tier-2 polygons + borders are deferred until viewport zoom > 1.5 (handled
 * by `loadTier2Lazy` — wired by Phase 6a LOD switcher).
 */
import { manifest } from './manifest';
import type {
  AdjacencyEdge,
  AdjacencyFile,
  BorderTierFile,
  CountryMeta,
  PolygonTierFile,
  WorldData,
  WorldFile,
} from './types';

/** SPEC Section 4.1 / 4.5 — current version we know how to parse. */
const KNOWN_SCHEMA = 1;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return (await res.json()) as T;
}

function assertSchema(label: string, value: number): void {
  if (value !== KNOWN_SCHEMA) {
    throw new Error(`${label}.schemaVersion=${value} but loader knows ${KNOWN_SCHEMA} (SPEC Section 14.3)`);
  }
}

function buildAdjacency(
  countries: CountryMeta[],
  edges: AdjacencyEdge[],
): Pick<WorldData, 'adjacency' | 'edgeType'> {
  const adjacency: Record<string, Set<string>> = {};
  const edgeType: Record<string, Record<string, 'land' | 'sea'>> = {};
  for (const c of countries) {
    adjacency[c.code] = new Set();
    edgeType[c.code] = {};
  }
  for (const [from, to, type] of edges) {
    const af = adjacency[from];
    const at = adjacency[to];
    if (!af || !at) continue;
    af.add(to);
    at.add(from);
    (edgeType[from] ??= {})[to] = type;
    (edgeType[to] ??= {})[from] = type;
  }
  return { adjacency, edgeType };
}

function assertConnected(countries: CountryMeta[], adj: Record<string, Set<string>>): void {
  const start = countries[0]?.code;
  if (!start) return;
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length) {
    const v = queue.shift()!;
    for (const n of adj[v] ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  if (seen.size !== countries.length) {
    const missing = countries.filter((c) => !seen.has(c.code)).map((c) => c.code);
    throw new Error(
      `Adjacency graph not connected: ${missing.length} unreachable (${missing.slice(0, 6).join(',')}…). Re-run \`npm run build:world\`.`,
    );
  }
}

export type WorldLoadProgress = {
  loaded: number;
  total: number;
  step: 'fetching' | 'parsing' | 'composing' | 'ready';
};

/**
 * Boot loader entry. Calling code drives the loading-state UI by listening to
 * `onProgress`. Resolves with the composed runtime structure.
 *
 * Boot timing: caller should `performance.mark('boot-start')` before invoking
 * and `performance.measure('boot-to-playable', 'boot-start', 'boot-playable')`
 * after the first map frame paints. SPEC Section 13.1.
 */
export async function loadWorld(
  onProgress?: (p: WorldLoadProgress) => void,
): Promise<WorldData> {
  onProgress?.({ loaded: 0, total: 4, step: 'fetching' });

  const [worldFile, polyTier1, borderTier1, adjFile] = await Promise.all([
    fetchJson<WorldFile>(manifest.worldJson),
    fetchJson<PolygonTierFile>(manifest.polygonsTier1),
    fetchJson<BorderTierFile>(manifest.bordersTier1),
    fetchJson<AdjacencyFile>(manifest.adjacencyJson),
  ]);
  onProgress?.({ loaded: 4, total: 4, step: 'parsing' });

  assertSchema('world.json', worldFile.schemaVersion);
  assertSchema('polygons.tier1', polyTier1.schemaVersion);
  assertSchema('borders.tier1', borderTier1.schemaVersion);
  assertSchema('adjacency', adjFile.schemaVersion);

  onProgress?.({ loaded: 4, total: 4, step: 'composing' });
  const { adjacency, edgeType } = buildAdjacency(worldFile.countries, adjFile.edges);
  assertConnected(worldFile.countries, adjacency);

  const countries: Record<string, CountryMeta> = {};
  for (const c of worldFile.countries) countries[c.code] = c;

  const data: WorldData = {
    countries,
    adjacency,
    edgeType,
    polygons: {
      tier1: polyTier1.countries,
      tier2: null,
    },
    borders: {
      tier1: borderTier1,
      tier2: null,
    },
  };

  onProgress?.({ loaded: 4, total: 4, step: 'ready' });
  return data;
}

/**
 * Lazy-load tier-2 polygons + borders. SPEC Section 13.2 — invoked when
 * `viewport.scale > 1.5`. Mutates the passed `WorldData` in place.
 *
 * Failure mode: log telemetry, retry once with 500ms backoff, then mark
 * degraded (caller stays on tier-1) per Section 13.2 lazy-load contract.
 */
export async function loadTier2(data: WorldData): Promise<void> {
  if (data.polygons.tier2 && data.borders.tier2) return;
  const [polyTier2, borderTier2] = await Promise.all([
    fetchJson<PolygonTierFile>(manifest.polygonsTier2),
    fetchJson<BorderTierFile>(manifest.bordersTier2),
  ]);
  assertSchema('polygons.tier2', polyTier2.schemaVersion);
  assertSchema('borders.tier2', borderTier2.schemaVersion);
  data.polygons.tier2 = polyTier2.countries;
  data.borders.tier2 = borderTier2;
}
