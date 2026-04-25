/**
 * Inter-worker contract type stubs. Phase 0 emits these so Workers B + C extend
 * (do NOT redefine). Implementations land in subsequent phases — these are
 * shape-only; semantics live in `docs/SPEC.md`.
 *
 * Cite SPEC sections in each block; bump `schemaVersion` per Section 14.3 if
 * shape ever changes incompatibly.
 */

// ─── Geometry primitives — SPEC Section 4.1 ─────────────────────────────────

export type Vec2 = [number, number];

/** Bounding box for normal countries. Coords are projected px (Section 4.4). */
export type SingleBBox = {
  kind: 'single';
  min: Vec2;
  max: Vec2;
};

/**
 * Two-half bbox for countries crossing the antimeridian (RU, US, FJ, NZ, KI).
 * SPEC Section 4.4 antimeridian handling + Section 5.4 SplitBBox cull duplication.
 */
export type SplitBBox = {
  kind: 'split';
  west: { min: Vec2; max: Vec2 };
  east: { min: Vec2; max: Vec2 };
};

export type BBox = SingleBBox | SplitBBox;

// ─── World data (immutable after boot) — SPEC Section 4.1 ───────────────────

/**
 * Per-country meta loaded from `public/geo/world.json` (~80KB gz).
 * SPEC Section 4.1 `CountryMeta`.
 */
export type CountryMeta = {
  /** ISO_A2 or fallback NAME-hash */
  code: string;
  /** English display name */
  name: string;
  /** Vietnamese display name; fallback = `name` */
  nameVi: string;
  /** Pre-computed projected px (area-weighted; main sub-polygon for antimeridian crossers) */
  centroid: Vec2;
  /** Capital coordinates if present, else null */
  capital: { name: string; position: Vec2 } | null;
  /** Bounding box for culling — 2-half for antimeridian crossers */
  bbox: BBox;
  /** Approximate projected area (gameplay balance) */
  area: number;
  /** HSL deterministic 4-color from Welsh-Powell (Section 4.3 step 8) */
  defaultColor: string;
  /** Number of disjoint sub-polygons (Section 4.6 MultiPolygon) */
  subMeshCount: number;
  /** True if geometry was split at antimeridian */
  hasAntimeridianSplit: boolean;
};

/** Top-level `world.json` payload. SPEC Section 4.1 `WorldFile`. */
export type WorldFile = {
  schemaVersion: 1;
  /** Sorted by `code` for deterministic iteration (Section 8.5 rule 7) */
  countries: CountryMeta[];
};

/**
 * Country fill geometry per LOD tier (`world.polygons.tier{1,2}.json`).
 * Tier 0 omitted — aggregate render uses centroid+balls (Section 5.2).
 * SPEC Section 4.1 `PolygonTierFile` + Section 4.6 sub-mesh contract.
 */
export type PolygonSubMesh = {
  /** [x,y, x,y, …] projected px, 1 decimal precision (Section 4.4) */
  vertices: number[];
  /** Earcut output — type per parent `indexType` field */
  indices: number[];
  /** Earcut hole start indices, per sub-polygon */
  holes: number[];
};

export type PolygonTierFile = {
  schemaVersion: 1;
  tier: 1 | 2;
  countries: Record<string, {
    subMeshes: PolygonSubMesh[];
    /** uint32 if vertex count > 65535 (RU/CA at tier 2) */
    indexType: 'uint16' | 'uint32';
  }>;
};

/**
 * Border segment list per LOD tier (`world.borders.tier{1,2}.json`).
 * SPEC Section 4.1 `BorderTierFile` + Section 5.3.
 *
 * Phase 1a MVP uses compact segment-list form (deduplicated edges). The Phase 1b
 * boot loader tessellates ribbon strips at runtime for the LUT shader. Full
 * pre-tessellated form (with vertices/indices/segmentTable/countryIndexAttribute)
 * deferred to Phase 7 binary asset optimization.
 *
 * Each segment = 6 numbers: `[x0, y0, x1, y1, countryIndexLeft, countryIndexRight]`.
 * countryIndexRight = -1 for coastlines (border vs ocean).
 */
export type BorderTierFile = {
  schemaVersion: 1;
  tier: 1 | 2;
  /** Flat array: [x0,y0, x1,y1, leftIdx, rightIdx] × segmentCount */
  segments: number[];
  segmentCount: number;
  /** = countries.length, used as shader uniform bound for LUT */
  countryCount: number;
};

/**
 * Adjacency edge tuple. SPEC Section 4.1 `AdjacencyEdge`.
 * Example: `["US", "CA", "land", "auto"]`.
 */
export type AdjacencyEdge = [
  from: string,
  to: string,
  type: 'land' | 'sea',
  source: 'auto' | 'manual',
];

export type AdjacencyFile = {
  schemaVersion: 1;
  edges: AdjacencyEdge[];
};

/**
 * Hand-curated sea-lanes seeded into the auto pipeline.
 * SPEC Section 4.5 Stage A schema.
 */
export type SeaLanesManual = {
  schemaVersion: 1;
  edges: Array<{
    from: string;
    to: string;
    reason: string;
  }>;
};

/**
 * Runtime composed structure assembled by `loadWorld()`. SPEC Section 4.1
 * `WorldData`. Tier-2 polygons + borders are null until lazy-loaded
 * (zoom > 1.5, Section 13.2).
 */
export type WorldData = {
  countries: Record<string, CountryMeta>;
  /** Bidirectional code → neighbor codes */
  adjacency: Record<string, Set<string>>;
  /** Adjacency edge type lookup */
  edgeType: Record<string, Record<string, 'land' | 'sea'>>;
  polygons: {
    tier1: Record<string, PolygonTierFile['countries'][string]>;
    tier2: Record<string, PolygonTierFile['countries'][string]> | null;
  };
  borders: {
    tier1: BorderTierFile;
    tier2: BorderTierFile | null;
  };
};

// ─── Game state (mutable, Zustand store) — SPEC Section 4.2 ─────────────────

/**
 * Per-country runtime state. `capitalUnderSiege` is DERIVED, not stored —
 * see `isCapitalUnderSiege` helper (Section 4.2 / Section 6.1).
 */
export type CountryRuntime = {
  code: string;
  /** Initially same as `code`; changes on capture */
  ownerId: string;
  troops: number;
  /** [0,1] — drives `reinforceRate` multiplier */
  morale: number;
  /** troops/sec, derived from area + morale (Section 6.1 reinforce) */
  reinforceRate: number;
  lastBattleTick: number;
};

/**
 * Per-side aggregate, recomputed end of each sim-tick batch.
 * SPEC Section 4.2 `SideDerived`.
 */
export type SideDerived = {
  ownerId: string;
  /** Sorted by code (deterministic, Section 8.5 rule 5) */
  territoryCodes: string[];
  /** First sorted-code owned country with `.capital !== null` */
  capitalCode: string | null;
  totalTroops: number;
};

/**
 * Active combat event. ID is deterministic per Section 4.2 — DO NOT use nanoid
 * (would break Section 8.5 hash check).
 */
export type Battle = {
  /** Format: `b-${attacker}-${defender}-${startTick}` */
  id: string;
  attacker: string;
  defender: string;
  startTick: number;
  /** [0,1] — drives visual effect intensity (Section 6.1) */
  intensity: number;
  /** Adjacency edge type === 'sea' (Section 4.5) */
  isSeaInvasion: boolean;
};

export type GameSpeed = 1 | 2 | 4 | 8 | 16 | 32 | 64;

/**
 * Top-level Zustand store shape. SPEC Section 4.2 `GameState`.
 *
 * MUTATION RULES (cứng — SPEC Section 4.2):
 *  - In-place mutate via immer; never replace `countries` Record.
 *  - Bump version counters per change kind (split for selector specificity).
 *  - No Map/Set in the store — those are sim-layer scratch only.
 */
export type GameState = {
  /** Bump per Section 14.3 migration rules */
  schemaVersion: 1;

  countries: Record<string, CountryRuntime>;
  sides: Record<string, SideDerived>;
  battles: Battle[];

  tick: number;
  paused: boolean;
  speed: GameSpeed;
  winner: string | null;
  /** Current PRNG seed (Section 8.5) */
  rngSeed: string;

  // Version counters — split per slice for selector specificity (Section 4.2)
  ownershipVersion: number;
  troopsVersion: number;
  battlesVersion: number;
  sidesVersion: number;

  // Bench/debug accumulators (Section 4.2 / Section 8.3 determinism block)
  statsDamageTotal: number;
  statsCaptureCount: number;
  /** Sim ticks dropped by spiral guard (Section 8.5 rule 6) */
  statsSpiralDropped: number;
};

/**
 * Local per-tick context, NOT persisted in Zustand (Section 4.2 TickContext
 * semantics). Created at start of each sim-tick batch to avoid race conditions
 * during multi-battle resolution.
 */
export type TickContext = {
  /** Shallow-copied refs from `state.sides` */
  sidesAtStart: Record<string, SideDerived>;
  /** Frozen snapshot of `state.battles` */
  battlesAtStart: readonly Battle[];
  tick: number;
};

// ─── Telemetry — SPEC Section 14.4 ──────────────────────────────────────────

export type TelemetryEvent =
  | { type: 'boot-to-playable'; ms: number }
  | { type: 'frame-budget-violation'; frameMs: number; scenario: string }
  | { type: 'webgl-context-lost' }
  | { type: 'sim-spiral-of-death'; dropped: number }
  | { type: 'texture-budget-exceeded'; bytes: number };

// ─── Bench output — SPEC Section 14.1 ───────────────────────────────────────

export type FrameSample = {
  t: number;
  frameMs: number;
  simMs: number;
  renderMs: number;
  reactMs: number;
  drawCalls: number;
  battleCount: number;
};

export type BenchOutput = {
  schemaVersion: 1;
  scenario: 'idle' | 'combat' | 'panzoom';
  startedAt: string;
  device: { ua: string; dpr: number; screen: { w: number; h: number } };
  seed: string;
  fps: { p50: number; p5: number; p1: number };
  frameMs: { p50: number; p95: number; p99: number };
  /** Thermal throttle detect (R7) — early-30s window */
  frameMsFirst30Win: { p95: number };
  frameMsLast30Win: { p95: number };
  /** null on Safari (Section 8.1 platform notes) */
  heapBytes: number | null;
  vramEstimateBytes: number;
  drawCalls: { p50: number; p95: number };
  battles: { p50: number; max: number };
  determinism: {
    /** FNV-1a 64-bit hash of canonical full sim state (Section 8.5) */
    simHash: string;
    damageTotal: number;
    captureCount: number;
    winnerCode: string | null;
    totalTicks: number;
    spiralOfDeathDropped: number;
  };
  samples?: FrameSample[];
};
