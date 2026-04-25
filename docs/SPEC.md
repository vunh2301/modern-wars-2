# Modern Wars 2.0 — Implementation Spec

> Project rebuild — zero ràng buộc với codebase cũ. Spec này là bản hợp đồng giữa bạn và Claude Code: mục tiêu, stack, architecture, gameplay, performance target, và benchmark protocol đo thực tế.

---

## 1. Mục tiêu & Scope

### Phải có (MVP)
- World map game theo Risk-style: 1 quốc gia = 1 phe = 1 territory polygon (Natural Earth 50m, ~177 nước).
- Real-time combat tick-based (không turn-based). Speed adjustable 1×–64×.
- Spectator/AI-only mode. Không player input vào combat (chỉ pause/speed/zoom).
- 60 FPS sustained trên iPhone 12+ và MacBook M1+ tại zoom 1× (whole world view).
- Deploy như SPA chạy trong browser (Chrome/Safari mobile + desktop).

### Không làm trong MVP
- Multiplayer (PvP, PvE).
- Player-controlled faction. Save/load. Diplomacy UI.
- Hex grid, terrain types, unit types, supply lines.
- Procedural map generation.

### Acceptance criteria (MVP done khi)
- Khởi động → click "Start" → **boot-to-playable ≤ 1500ms** trên iPhone 12 Safari (canonical gate, Section 13.1). 800ms = stretch goal.
- Có 50+ trận đánh đồng thời với frame time p95 ≤ 18.2 ms (tương đương FPS p5 ≥ 55) trên iPhone 12.
- Trận average kết thúc trong 3-7 phút real time tại 32× speed.
- Memory peak < 250 MB (JS heap + estimated VRAM, đo theo Section 14.2).
- JS bundle size: initial route < 350 KB gzipped, total app < 500 KB gzipped. **Excluded from JS budget** (separate asset budget; filenames là **logical keys** — physical filenames content-hashed via manifest, Section 19.2):
  - **Eager (boot-fetch):** `world.json` (~80KB gz), `world.polygons.tier1.json` (~600KB gz), `world.borders.tier1.json` (~80KB gz), `adjacency.json` (~12KB gz) → ~770KB gz total eager.
  - **Lazy (zoom > 1.5):** `world.polygons.tier2.json` (~1.4MB gz), `world.borders.tier2.json` (~200KB gz).
  - CI hard-fail nếu vượt **JS** budget (Section 12); asset budget warned-only.

---

## 2. Tech Stack — quyết định cứng

| Layer | Choice | Lý do |
|---|---|---|
| Build | **Vite ≥7** + **TypeScript ≥5.4** | Vite 7 currently supported; pin minor trong `package.json`. Vite 5 đã EOL — **không** dùng. |
| UI framework | **React 18** | HUD/leaderboard cần stateful UI, React đơn giản nhất |
| Renderer | **Pixi.js `8.6.6`** (vanilla, exact patch pin trong `package.json`, no caret/tilde) | WebGL2, sprite batching. v9 có thể break tint cascade. Pin patch để dependency lock reproducible. **Bắt buộc dùng `Particle` (không phải `Sprite`) bên trong `ParticleContainer` — xem Section 5.5.** |
| State | **Zustand 4** + **immer middleware** | Không Redux boilerplate, no Context lifecycle drama. **Cấm dùng `Map`/`Set` trong store** (Section 4.2). |
| Audio | **Tone.js 15** (lazy-loaded, dynamic `import()`) | Web Audio synth tốt nhất, tránh asset load. Lazy để không tính vào initial bundle. |
| Map data | **Natural Earth 50m GeoJSON** | Same-origin static asset trong `public/geo`, không phụ thuộc CDN/external runtime fetch. Adjacency precomputed offline (Section 4.3). |
| Viewport | **pixi-viewport 6** | Version tương thích Pixi.js v8 cho pan/zoom/pinch, mobile gesture sẵn. **Bắt buộc construct với `{ events: app.renderer.events }`** (Section 5.4). |
| Culling | **Pixi `CullerPlugin` (extension)** | `cullable=true` một mình **không tự cull** — phải register plugin (Section 5.4). |
| RNG | **`seedrandom` v3** | Deterministic PRNG cho sim/AI/combat/bench. **Cấm `Math.random()` trong layer Sim** (Section 8.5). |
| Spatial index | **`rbush` v4** | Build-time only, không dùng runtime (adjacency precomputed). |

**Cấm:**
- Không dùng SVG cho map render (DOM scale kém).
- Không dùng Three.js (overkill 3D).
- Không dùng Phaser (engine wrapping Pixi, mất control).
- Không dùng @pixi/react (reconciler overhead 2-5× cho 200+ objects).

---

## 3. Architecture — tách 5 layer rõ ràng

```
┌─────────────────────────────────────────────────┐
│ UI Layer (React)                                │
│   HUD, leaderboard, controls, settings          │
└──────────────┬──────────────────────────────────┘
               │ subscribes to
┌──────────────▼──────────────────────────────────┐
│ State Layer (Zustand store)                     │
│   gameState, settings, simStats                 │
└──────────────┬──────────────────────────────────┘
               │ ticks
┌──────────────▼──────────────────────────────────┐
│ Sim Layer (pure TS, no DOM)                     │
│   Combat resolution, AI, reinforcement          │
└──────────────┬──────────────────────────────────┘
               │ commits diff to state, triggers
┌──────────────▼──────────────────────────────────┐
│ Render Layer (Pixi)                             │
│   Country polygons, troops, effects, labels     │
└──────────────┬──────────────────────────────────┘
               │ uses
┌──────────────▼──────────────────────────────────┐
│ Data Layer (loaded once, immutable)             │
│   GeoJSON polygons, country meta, adjacency     │
└─────────────────────────────────────────────────┘
```

### Quy tắc cứng
- **UI không gọi Sim trực tiếp.** UI ↔ State ↔ Sim.
- **Sim không touch Pixi.** Sim mutate state, render layer subscribes.
- **Render layer không tự tick.** Drive bởi Pixi `app.ticker` → đọc state, vẽ. State diff via Zustand `subscribe` để biết invalidate gì.
- **Data layer load 1 lần ở app boot.** Không reload giữa game.

---

## 4. Data Model

### 4.1 Loaded data (immutable sau boot)

Spec chia data thành **4 file payload eager** (boot-time parallel) + 2 file lazy (zoom > 1.5):

```ts
// `public/geo/world.json` — meta only, ~80KB gzipped
type CountryMeta = {
  code: string;            // ISO_A2 hoặc fallback NAME-hash
  name: string;            // tên hiển thị (English)
  nameVi: string;          // tên Việt (lookup, fallback = name)
  centroid: [number, number]; // pre-computed projected px (Section 4.4)
  capital: { name: string; position: [number, number] } | null;
  bbox: BBox;              // for culling — see SplitBBox cho countries cross antimeridian
  area: number;            // pre-computed approximate (gameplay balance)
  defaultColor: string;    // HSL deterministic 4-color
  subMeshCount: number;    // bao nhiêu sub-polygon (Section 4.6)
  hasAntimeridianSplit: boolean;
};

type BBox = {
  kind: 'single';
  min: [number, number];   // projected px
  max: [number, number];
};
type SplitBBox = {
  kind: 'split';            // for countries cross antimeridian (RU, US, FJ, NZ, KI)
  west: { min: [number, number]; max: [number, number] };
  east: { min: [number, number]; max: [number, number] };
};

type WorldFile = {
  schemaVersion: 1;
  countries: CountryMeta[];          // sorted by code
};

// `public/geo/world.polygons.tier{1,2}.json` — country fills, ~600KB / ~1.4MB gzipped
// Tier 0 (zoom < 0.5) renders aggregate balls từ centroid (no polygon needed).
type PolygonTierFile = {
  schemaVersion: 1;
  tier: 1 | 2;
  countries: Record<string, {
    subMeshes: Array<{
      vertices: number[];   // [x,y, x,y, …] projected px (1 decimal precision)
      indices: number[];    // earcut output, type per indexType field
      holes: number[];      // earcut hole start indices, per sub-polygon
    }>;
    indexType: 'uint16' | 'uint32';  // uint32 nếu vertex count > 65535
  }>;
};

// `public/geo/world.borders.tier{1,2}.json` — pre-tessellated border ribbon, ~80KB / ~200KB gzipped
type BorderTierFile = {
  schemaVersion: 1;
  tier: 1 | 2;
  // Single Mesh, segmented by country pair. Each segment = ribbon strip (4 verts, 2 tris).
  vertices: number[];                        // [x,y, x,y, …] projected px ribbon vertices
  indices: number[];                         // triangle indices into vertices
  segmentTable: Array<{                      // sorted by (countryIndexLeft, countryIndexRight)
    countryIndexLeft: number;                // index into countries[] in `world.json`
    countryIndexRight: number;               // -1 if border vs ocean (coastline)
    indexStart: number;                      // first index in `indices` for this segment
    indexCount: number;
  }>;
  countryIndexAttribute: number[];           // per-vertex `countryIndexLeft` for shader LUT lookup; serialized as JSON number[] (parsed to Float32Array at runtime)
  countryIndexAttributeRight: number[];      // per-vertex `countryIndexRight`; -1 for coastlines
};
// Serialization note: number[] in JSON is human-readable; ~80KB tier-1, OK. Future optim: emit binary blob (.bin) referenced from JSON if profiling shows JSON.parse > 50ms iPhone.

// `public/geo/adjacency.json` — graph, ~12KB gzipped
type AdjacencyEdge = [from: string, to: string, type: 'land' | 'sea', source: 'auto' | 'manual'];
type AdjacencyFile = {
  schemaVersion: 1;
  edges: AdjacencyEdge[];
};

// Runtime composed structure (in-memory after boot):
type WorldData = {
  countries: Record<string, CountryMeta>;       // by code
  adjacency: Record<string, Set<string>>;       // bidirectional, code → neighbor codes
  edgeType: Record<string, Record<string, 'land' | 'sea'>>; // adjacency edge type lookup
  polygons: {                                    // by code, by tier (tier 2 lazy)
    // tier0 omitted — aggregate render uses centroid only (Section 5.2)
    tier1: Record<string, PolygonTierFile['countries'][string]>;
    tier2: Record<string, PolygonTierFile['countries'][string]> | null; // null until lazy-load
  };
  borders: {                                     // pre-tessellated stroke ribbon Mesh, by tier
    tier1: BorderTierFile;                       // eager-loaded at boot
    tier2: BorderTierFile | null;                // null until lazy-load (zoom > 1.5)
  };
};
```

**Loaded via:** `loadWorld()` parallel-fetches **4 files** (Section 13.2 preload, content-hashed via manifest): `world.json`, `world.polygons.tier1.json`, `world.borders.tier1.json`, `adjacency.json`. Composes `WorldData`, validates schema versions, **builds adjacency graph from `AdjacencyFile.edges` and asserts `connectedComponents === 1`**. Tier-2 polygons + borders lazy-loaded khi zoom > 1.5 (Section 13.2). Note: filenames in spec là **logical asset keys**; runtime resolves qua `manifest.ts` (Section 19.2).

### 4.2 Game state (mutable, Zustand)

```ts
type GameState = {
  schemaVersion: 1;       // bump khi mutate shape; Section 14.3 migration rule

  // Per-country runtime state — Record (NOT Map) để Zustand shallow-equal hoạt động
  countries: Record<string, CountryRuntime>;

  // Per-side derived state — recomputed end of each sim-tick batch
  sides: Record<string, SideDerived>;

  // Combat events active
  battles: Battle[];

  // Global
  tick: number;            // sim tick (4/s base, deterministic counter)
  paused: boolean;
  speed: 1 | 2 | 4 | 8 | 16 | 32 | 64;
  winner: string | null;
  rngSeed: string;         // current PRNG seed (Section 8.5)

  // Version counters — split per-slice để selector chỉ re-derive khi relevant
  ownershipVersion: number;  // bump khi any ownerId change (capture event ~10-50/game)
  troopsVersion: number;     // bump mỗi sim-tick batch (4-256/sec)
  battlesVersion: number;    // bump khi battles[] add/remove
  sidesVersion: number;      // bump khi sides re-derived (= mỗi tick batch)

  // Bench/debug accumulators — incremented in sim, consumed by Section 8.3 bench runner
  // Reset to 0 at game start; not part of selector-watched state.
  statsDamageTotal: number;
  statsCaptureCount: number;
  statsSpiralDropped: number; // sim ticks dropped by spiral guard (Section 8.5 rule 6)
};

type CountryRuntime = {
  code: string;
  ownerId: string;            // initially same as code
  troops: number;
  morale: number;             // 0..1, drives reinforceRate multiplier
  reinforceRate: number;      // troops/sec, derived from area + morale
  lastBattleTick: number;
  // NOTE: capitalUnderSiege is DERIVED, not stored — see derivation below
};

type SideDerived = {
  ownerId: string;
  territoryCodes: string[];   // sorted by code
  capitalCode: string | null; // first sorted-code owned country with .capital !== null
  totalTroops: number;
};

type Battle = {
  id: string;                 // deterministic: `b-${attacker}-${defender}-${startTick}` — KHÔNG dùng nanoid (sẽ break Section 8.5 hash check)
  attacker: string;           // attacker country code
  defender: string;           // defender country code
  startTick: number;
  intensity: number;          // 0..1, drives visual effect
  isSeaInvasion: boolean;     // true khi adjacency edge type === 'sea' (Section 4.5)
};

// Derived per-country flag, cached end-of-tick:
// capitalUnderSiege(c) = (c.code === sides[c.ownerId]?.capitalCode) AND (∃ Battle b where b.defender === c.code)
```

**Mutation rules (cứng):**

- **Per-country in-place mutation, NOT replace toàn map.** Immer `draft.countries[code].troops -= damage` cho từng battle event. Replace full map → 177 shallow clones × 256 sim-ticks/s @ speed 64× = 45K alloc/s = GC violation Section 7.2.
- Bump version counter **theo loại change** (split để selector chỉ re-derive khi relevant slice change):
  - `ownershipVersion`: bump khi capture event (`ownerId` change). Frequency ~10-50/game.
  - `troopsVersion`: bump mỗi sim-tick batch (4-256/sec).
  - `battlesVersion`: bump khi battles[] thêm/bớt.
  - `sidesVersion`: bump cùng `troopsVersion` (sides re-derive at tick batch end).
- React selectors:
  - Country fill re-tint: subscribe `ownershipVersion` only (cheap, low-frequency).
  - Leaderboard top-12: subscribe `sidesVersion` + memoized derive (debounce 100ms cho speed > 8×).
  - Battle counter / highlight: subscribe `battlesVersion`.
  - Troop sprite count: subscribe `troopsVersion`.
- **Cấm** subscribe toàn `countries` Record (would deep-compare).
- `Map`/`Set` chỉ được dùng trong **Sim layer scratch** (transient, không vào store).
- **`capitalUnderSiege`** derived inline khi cần (Section 6.1) qua helper `isCapitalUnderSiege(country, tickCtx)` — không lưu trong `CountryRuntime`. Avoids dual source-of-truth bug.
  - **Local TickContext semantics (chống race, không vào Zustand):** sim tick batch begins → tạo local `TickContext` object (KHÔNG store in Zustand to avoid alloc/GC + reactivity churn):
    ```ts
    type TickContext = {
      sidesAtStart: Record<string, SideDerived>;   // shallow-copied refs from state.sides
      battlesAtStart: readonly Battle[];           // frozen slice
      tick: number;
    };
    function beginTick(state): TickContext {
      return {
        sidesAtStart: { ...state.sides },          // shallow spread, ~177 ref copies — cheap, no deep clone
        battlesAtStart: Object.freeze(state.battles.slice()),
        tick: state.tick,
      };
    }
    ```
  - Mọi `isCapitalUnderSiege()` calls trong tick batch resolve nhận tickCtx, đọc `tickCtx.sidesAtStart` và `tickCtx.battlesAtStart`, KHÔNG read live state.
  - End-of-tick: re-derive `state.sides` từ post-mutation `state.countries`; bump `sidesVersion`; tickCtx GC'd.
  - **Cost:** ~177 object refs spread per tick = micro-alloc. At speed 64× = 256 ticks/s × ~177 refs = 45K shallow ref copies/s, comparable to existing immer per-country mutation cost. Acceptable.
  - Lý do: nhiều battles resolve trong cùng tick có thể flip `ownerId` lẫn nhau (e.g. defender vừa capture sang ownerId X, ngay sau lại bị attack tiếp); tickCtx bảo đảm helper không thấy partially-mutated `sides`.

### 4.3 Pre-computation pipeline

**Build-time (Node script `scripts/build-world.ts`, chạy 1 lần khi raw GeoJSON đổi):**

1. Load `vendor/ne_50m_admin_0_countries.geojson` (raw 50m). **Vendor file COMMITTED to repo** với SHA256 trong `vendor/CHECKSUMS.txt` — fresh checkout phải build được offline, no download script.
2. **Filter** allowlist: bắt đầu với toàn bộ countries từ NE 50m sau khi loại Antarctica (`ISO_A2 === 'AQ'`); allowlist explicit trong `scripts/country-allowlist.json` để gameplay reproducible khi NE update version.
3. **Project + normalize geometry** (Section 4.4): equirectangular projection, antimeridian split, hole winding fix với `@turf/rewind`, `mapshaper-cli` Visvalingam simplification.
   - **Tooling:** `mapshaper-cli` invoked qua `child_process.execFileSync` từ Node script. Pin version `mapshaper@^0.6` trong `devDependencies`. Outputs intermediate GeoJSON tới `vendor/_built/`.
4. **Triangulate per LOD tier** với `earcut@^3` cho mỗi sub-polygon độc lập (handle MultiPolygon, xem 4.6).
5. Compute centroid (area-weighted, picked sub-polygon ≥60% area cho countries cross antimeridian) + bbox + area.
6. **Compute land adjacency** (rbush MBR-prune → segment-level grid-snap test, key = lng/lat snapped to **4 decimals** ≈ 11m precision sau projection; chống floating-point drift).
7. **Compute sea-lane adjacency** (Section 4.5).
8. **Compute color graph** (Welsh-Powell 4-color greedy với HSL golden-angle palette; fallback to 5 colors nếu graph non-planar do enclave).
9. Merge capital lookup `data/capitals.json` theo ISO_A2.
10. Emit:
    - `public/geo/world.json` — `WorldFile` (`CountryMeta[]`, Section 4.1).
    - `public/geo/world.polygons.tier{1,2}.json` — country fill geometry (tier-0 omitted, aggregate centroid). Lazy-load tier-2 chỉ khi viewport zoom > 1.5. Schema:
      ```ts
      type PolygonTierFile = {
        schemaVersion: 1;
        tier: 1 | 2;       // tier-0 omitted, aggregate uses centroid only
        countries: Record<string, {
          subMeshes: Array<{
            vertices: number[];   // [x,y, x,y, …] projected px (1 decimal)
            indices: number[];    // earcut output, Uint32 if max index > 65535 (RU/CA at tier 2)
            holes: number[];      // earcut hole start indices, per sub-polygon
          }>;
          indexType: 'uint16' | 'uint32';  // Uint32 nếu vertex count > 65535
        }>;
      };
      ```
    - `public/geo/world.borders.tier{1,2}.json` — pre-tessellated border ribbon Mesh + per-vertex country-index attributes (Section 4.1 `BorderTierFile`).
    - `public/geo/adjacency.json` — `AdjacencyFile` (Section 4.1), example edge: `[ "US", "CA", "land", "auto" ]` (4 fields per `AdjacencyEdge` tuple).
    - `bench/baseline-fixtures/midgame.json` — Section 8.5 fixture, includes `schemaVersion: 1` field.
11. Validate (build script asserts):
    - Graph connected (Section 4.5).
    - All ISO codes unique.
    - All centroids finite.
    - **No earcut triangle spans > 1 sub-polygon** (cross-product test on output).
    - Vertex count tier-1 ≤ 50K total; tier-2 ≤ 200K total; per-country sub-mesh count ≤ 30.

**Boot-time (browser, canonical gate ≤ 1500ms iPhone 12 Safari, stretch ≤ 800ms — Section 13.1):**

- `fetch` **4 JSON files** (`world.json`, `world.polygons.tier1.json`, `world.borders.tier1.json`, `adjacency.json`) in parallel (Section 13.2 preload).
- `world.polygons.tier2.json` + `world.borders.tier2.json` deferred until viewport zoom > 1.5 (lazy).
- `JSON.parse` + schema-version check (reject if mismatch).
- Compose runtime `WorldData` (Section 4.1).
- **Không** chạy rbush hay edge-test ở boot — đó là build-time concern.

> **Boot budget revised:** loại bỏ runtime adjacency computation cho phép canonical gate **≤ 1500ms** trên iPhone 12 (Section 1, 7.1, 13.1 đồng bộ).

### 4.4 Projection & Geometry contract

**Projection: Equirectangular** (a.k.a. Plate Carrée). Chọn vì:
- Đơn giản nhất: `x = (lng + 180) / 360 * worldWidth; y = (90 - lat) / 180 * worldHeight`.
- Không distort cực Bắc/Nam tệ như Mercator (Greenland không to bằng Africa).
- Tile-friendly cho LOD nếu sau này cần.
- Trade-off: shape mỗi nước hơi méo so với atlas đời thường — chấp nhận cho gameplay-first map.

**World canvas dimensions:**
- Logical world size: `worldWidth = 3600`, `worldHeight = 1800` (divisions of 0.1°).
- Pixi `Application` resolution = `Math.min(window.devicePixelRatio, 2)` — **DPR cap = 2** (Section 5.3).
- pixi-viewport `worldWidth/worldHeight` = above; `screenWidth/screenHeight` = canvas pixels.

**Antimeridian (180°) handling:**
- Build-time pre-process: bất kỳ ring nào cross 180° → split thành 2 rings tại antimeridian (dùng `@turf/line-split` hoặc custom). Áp dụng cho RU, US (Aleutian), FJ, NZ, KI.
- Centroid: tính trên polygon visible chính (≥60% area), không lấy MBR center.
- Bbox: store **2 bbox** cho countries cross antimeridian (`bboxWest`, `bboxEast`) để culling không broken.

**Hole winding (RFC 7946 / GeoJSON spec):**
- Outer ring: counter-clockwise (CCW).
- Inner ring (hole): clockwise (CW).
- Build script normalize bằng `@turf/rewind` — Pixi Graphics `poly()` rely vào winding để fill đúng.

**Simplification:**
- Tier 0 (`zoom < 0.5`): **no polygon simplification needed** — aggregate render uses centroid+balls, polygon file omitted (Section 4.3 emit).
- Tier 1 LOD (`zoom 0.5-2`): tolerance 0.05° (~5.5km) — default render.
- Tier 2 LOD (`zoom > 2`): full detail (no simplification).
- Tool: `mapshaper-cli` Visvalingam, weighted area metric.
- Result: ~30K total vertices tier-1 vs ~150K raw → 5× geometry budget cut.

**Number precision:**
- All projected coordinates rounded to 0.1px (1 decimal) at build-time → JSON.parse cheaper, Pixi vertex buffer smaller.

### 4.5 Sea-lane adjacency

**Problem:** land-only adjacency disconnects 47 island/peninsula nations (Japan, UK, Australia, Madagascar, Iceland, Cuba, Philippines, Indonesia, …) → game **không bao giờ kết thúc** vì win condition (Section 6.3) requires last side alive but isolated islands có thể tồn tại mãi mãi.

**Solution:** sea-lane edges, computed build-time, marked `type='sea'` trong adjacency.json.

**Algorithm (3-stage):**

1. Build land adjacency graph (Section 4.3 step 6).
2. **Stage A — Manual seed sea-lanes** từ `data/sea-lanes-manual.json` (committed, hand-curated cho gameplay-meaningful Pacific/Caribbean clusters). Schema:
   ```ts
   type SeaLanesManual = {
     schemaVersion: 1;
     edges: Array<{
       from: string;       // ISO_A2
       to: string;         // ISO_A2
       reason: string;     // human-readable rationale
     }>;
   };
   ```
   Example payload:
   ```json
   {
     "schemaVersion": 1,
     "edges": [
       {"from": "KI", "to": "FJ", "reason": "Polynesia bridge"},
       {"from": "KI", "to": "TV", "reason": "Polynesia bridge"},
       {"from": "AS", "to": "WS", "reason": "Polynesia"},
       {"from": "FJ", "to": "AS", "reason": "Polynesia bridge"},
       {"from": "MH", "to": "FM", "reason": "Micronesia"},
       {"from": "PW", "to": "PH", "reason": "Micronesia → Asia bridge"}
     ]
   }
   ```
   Build script validates: schemaVersion = 1, both ISO codes exist, no duplicates.
3. **Stage B — Auto-compute** for each isolated component remaining sau Stage A:
   a. Compute centroid of component.
   b. Find K=3 nearest centroids (great-circle) trong supercomponent OR other components.
   c. Add sea-lane edge for each candidate **if great-circle distance ≤ 2500km AND ≤ K=3 per island**.
4. **Stage C — Final connectivity check + bounded force-add:**
   - After Stages A+B, find remaining components.
   - For each, force-add nearest-pair edge **với cap distance ≤ 4000km**.
   - If still disconnected: build script **fails** — manually add to `sea-lanes-manual.json`.
5. Emit adjacency.json với edge type tag (`'land' | 'sea'`) + source tag (`'auto' | 'manual'`) cho debug.

**Validation gates (build script):**
- `assert graph.connectedComponents.length === 1`
- `assert sea-lane edges ≤ 80` (sanity bound, includes Stage A manual).
- `assert no edge distance > 4000km` (catch transoceanic bug).
- `assert all 177 countries reachable via BFS from any starting country in ≤ 8 hops` (gameplay reachability bound).

### 4.6 MultiPolygon handling contract

Countries với multi-island/exclave (US mainland+AK+HI, ID ~13K islands → ~20 visible sau simplify, PH, JP, NO, GR, CA, GB, RU split antimeridian): mỗi **sub-polygon = 1 sub-mesh độc lập**.

**Render layer (Section 5.3):**
```ts
class CountryFill {
  meshes: Mesh[];           // 1 per sub-polygon
  container: Container;     // groups meshes; tint cascades v8.4+
  setOwner(color: number) {
    this.container.tint = color;  // 1 mutation, all sub-meshes update
  }
}
```

**Why not concatenate vertices?** Earcut `holes` parameter là array of **start indices trong cùng vertex array** — không support disjoint polygons. Naive concat tạo "phantom triangles" nối Alaska → Hawaii.

**Why Container.tint cascade?** Pixi ≥8.4 propagates parent `Container.tint` xuống children. **Pin Pixi `8.6.6` exact patch** trong `package.json` (no caret/tilde, Section 2). Runtime assert: `if (parseFloat(VERSION) < 8.6) throw`.

**Performance:** Build script enforces sub-mesh cap < 30/country, total < 800. Pixi v8 batch khả năng lo, nhưng quá nhiều sub-mesh = vertex buffer fragmentation.

**Examples (expected):**
- JP ↔ KR (≈220km), JP ↔ RU (Sakhalin proximity).
- GB ↔ FR (≈30km), GB ↔ IE.
- AU ↔ ID, AU ↔ PG, AU ↔ NZ.
- MG ↔ MZ.
- IS ↔ NO, IS ↔ GB.
- CU ↔ US, CU ↔ MX, CU ↔ JM.

**Gameplay impact:**
- Sea invasions slower: `damage_to_defender *= 0.7`, `damage_to_attacker *= 1.3` (Section 6.1) — defender bonus.
- Visual: sea-invasion battle highlight dùng dashed stroke thay vì solid pulse.
- AI prefers land targets if available (sea cost penalty in Section 6.2 weight).

**Test gate (build script):**
- `assert graph.connectedComponents.length === 1`
- (sanity bound moved to Section 4.5 Stage C: ≤ 80 edges incl Stage A manual)
- `assert all 177 countries reachable from any starting country in BFS`.

---

## 5. Rendering Pipeline

### 5.1 Layer order (Pixi.Container z-stack)

| z | Layer | Update freq | Tech |
|---|---|---|---|
| 0 | Ocean background | once | `PIXI.Sprite` solid color, full screen |
| 1 | Country fills | tint mutation on owner change | `PIXI.Mesh` per country (geometry static, tint dynamic) — Section 5.3 |
| 2 | Country borders | shader uniform palette swap | Single pre-tessellated **stroke ribbon Mesh** với per-vertex `(ownerL,ownerR)` attribute + uniform color palette (Section 5.3 borders block) |
| 3 | Battle highlight | shader uniform per frame | Pre-computed border segment + shader pulse uniform; **no per-frame Graphics redraw**. Sea-invasion = dashed style |
| 4 | Troop particles | every frame | Pixi v8 `ParticleContainer` + `Particle` (NOT Sprite) — Section 5.5 |
| 5 | Combat effects | every frame | Particle pool with TTL |
| 6 | Country labels | on zoom change | `PIXI.Text` cached, visible >= zoom 0.8 |
| 7 | UI overlay | React DOM | Above canvas |

### 5.2 LOD theo zoom

```
zoom < 0.5:   Aggregate render. Mỗi nước = 1 ball center + tổng troops badge.
              Borders đơn giản hóa, không labels.

zoom 0.5-2:   Standard render. Country polygons full chi tiết, 
              troops cluster theo bucket 16px, labels capital cities only.

zoom > 2:     Detail render. Troops cá nhân, labels mọi nước, 
              animated battles full effects.
```

Switch tier khi zoom cross threshold → tear down sprites tier cũ, build tier mới. Switch < 100ms.

### 5.3 Country fill rendering — KEY OPTIMIZATION

**Naive:** mỗi country redraw `PIXI.Graphics` mỗi frame. ~177 paths × ~100 vertices = 17K vertices/frame. **Tránh.**

**Strategy: Hybrid (tinted Mesh + occasional re-cache):**

Default path — **`Mesh` with tint via parent Container** (NOT cacheAsTexture, NOT MeshLine):
- Build-time: triangulate mỗi sub-polygon → indexed `MeshGeometry` (Section 4.6). Outputs Float32 vertices + Uint16/Uint32 indices.
- Runtime: 1 `Container` per country, N `Mesh` children (1 per sub-polygon), shared 1×1 white `Texture`. `container.tint = color` cascades xuống Mesh children (Pixi ≥8.4 verified, pin `8.6.6` exact, Section 2).
- **LUT initialization at boot:** trước khi bất kỳ capture event xảy ra, init LUT pixel `i = palette[CountryMeta.defaultColor]` cho mỗi country (177 entries). Section 4.3 build script computes default colors via 4-color greedy.
- Owner change → chỉ update `container.tint = newOwnerColor`. **Zero geometry rebuild, zero texture re-snap.**
- **Runtime assert at boot:** `if (parseFloat(VERSION) < 8.6) throw new Error('Pixi ≥8.6 required for tint cascade');`.

**Borders: pre-tessellated stroke ribbon Mesh (NOT MeshLine).**
- Build-time: `scripts/build-world.ts` extracts border segments from polygon edges, tessellates mỗi segment thành **2-vertex-per-side ribbon strip** (4 vertices per segment, 2 triangles). Output to `world.borders.tier{1,2}.json` (Section 4.1 `BorderTierFile`).
- **Static per-vertex attributes** (geometry never mutates after upload):
  - `aPosition: vec2` — projected px.
  - `aCountryLeft: float` — index into countries[] (NOT owner — geometry doesn't know runtime owner).
  - `aCountryRight: float` — index into countries[]; `-1.0` if border vs ocean (coastline).
- **Runtime: 1×177 RGBA LUT texture** (`uColorLut`) updated khi `ownershipVersion` bump:
  ```ts
  // texture pixel i = current owner's color for country index i
  for (let i = 0; i < countries.length; i++) {
    const ownerColor = palette[countries[i].ownerId];
    lutPixels.set(ownerColor.rgba, i * 4);
  }
  lutTexture.update(); // 1 small upload, ≤ 1KB
  ```
- **Custom shader (LUT path = primary, robust cross-device):**
  ```glsl
  // vertex
  in vec2 aPosition;
  in float aCountryLeft;
  in float aCountryRight;
  uniform sampler2D uColorLut;     // 177×1 RGBA
  uniform float uCountryCount;     // = 177.0
  out vec3 vColor;
  void main() {
    vec3 cL = texelFetch(uColorLut, ivec2(int(aCountryLeft), 0), 0).rgb;
    float rIdx = aCountryRight < 0.0 ? aCountryLeft : aCountryRight;
    vec3 cR = texelFetch(uColorLut, ivec2(int(rIdx), 0), 0).rgb;
    vColor = (cL + cR) * 0.5;
    gl_Position = uViewportMatrix * vec4(aPosition, 0.0, 1.0);
  }
  ```
- **Why country-index, not owner-index?** Geometry static; ownership dynamic. Storing owner per-vertex would require per-vertex re-upload mỗi capture event. Country-index static + LUT dynamic = zero geometry mutation, ≤ 1KB texture update per capture.
- **Uniform-array fallback (optional, legacy GPUs)**: nếu cần switch về uniform array (vd debug), check `MAX_FRAGMENT_UNIFORM_VECTORS ≥ 256`. LUT là primary path, fallback chỉ là tooling/debug option, không runtime auto-switch.
- Why not `Pixi.Graphics.stroke`? Per-frame regenerate vertex buffer cho 177 nước = 8-12ms iPhone 12. Pre-tessellated ribbon + LUT = 0 vertex update at runtime.

**Battle highlight (z=3) implementation:**
- Borders Mesh shader có thêm uniform `uPulseTime` (float) + `uActiveBattlePairs[64]` (vec4 = (countryLeft, countryRight, isSeaInvasion, _padding), fragment-only). Max 64 battles → fits acceptance 50+.

**Uniform budget guard (boot-time runtime check, primary LUT-texture path đã chống được vấn đề này nhưng vẫn check):**
```ts
const gl = renderer.gl as WebGL2RenderingContext;
const maxFU = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
const REQUIRED_FU = 128; // 64 battle pairs + headroom
assert(maxFU >= REQUIRED_FU, `MAX_FRAGMENT_UNIFORM_VECTORS=${maxFU} < ${REQUIRED_FU}`);
```
WebGL2 spec minimum `MAX_FRAGMENT_UNIFORM_VECTORS = 224` (Khronos) — should always pass. LUT-texture primary path means no 177-uniform-array dependency.
- Fragment shader checks `(ownerLeft, ownerRight) ∈ activeBattlePairs` → modulate alpha với `sin(uPulseTime * 6) * 0.5 + 0.5`.
- Sea invasion = dashed: shader thêm condition `isSeaPair` → stipple mask qua `step(0.5, fract(gl_FragCoord.x * 0.1))`.
- Per frame cost: 1 uniform array update (~64 vec4 = 1KB), no draw call multiplication.

**Why not `cacheAsTexture()` everywhere?** Texture cache cho 177 country bbox-sized canvases ở DPR=2 trên iPhone 12 (1170×2532) có thể ngốn 100-180MB VRAM, đặc biệt khi country lớn (RU, CA, US) chạm/vượt **device max texture size** (Pixi fail silently khi vượt). Tinted Mesh tránh hoàn toàn vấn đề này.

**`cacheAsTexture()` chỉ dùng có chọn lọc:**
- Tier-0 LOD aggregate render (zoom < 0.5): cache toàn bộ ocean+borders+aggregate balls thành 1 texture; refresh on owner-set diff (debounced 100ms).
- KHÔNG dùng cho per-country fills.

**Texture budget hard caps (Section 14.2 estimator):**
- Total render textures: ≤ 80MB ước tính trên iPhone 12 (~50% memory budget cho rendering).
- Each `cacheAsTexture` snapshot: bbox capped tại 2048×2048. Vượt → fallback Mesh path, log warning.
- DPR cap: `min(window.devicePixelRatio, 2)`.

Result: 99% frames chỉ touch tint mutations + troop sprites + battle effects. Geometry buffer uploaded **1 lần** lifetime app.

### 5.4 Viewport, events & culling

**Viewport construction (Pixi v8 + pixi-viewport 6 — bắt buộc):**
```ts
import { Viewport } from 'pixi-viewport';
const viewport = new Viewport({
  events: app.renderer.events,        // BẮT BUỘC v8 — không có thì gesture chết im
  screenWidth: app.screen.width,
  screenHeight: app.screen.height,
  worldWidth: 3600,                   // Section 4.4
  worldHeight: 1800,
  passiveWheel: false,
});
viewport.drag().pinch().wheel().decelerate().clampZoom({ minScale: 0.3, maxScale: 3 });
// maxScale=3 đồng bộ với LOD tier-2 threshold (Section 5.2). Vượt 3× không có thêm tier = wasted range.
```

**Culling pipeline (Pixi v8 explicit):**
- `cullable=true` một mình **không cull** trong Pixi v8.
- Phải `import { CullerPlugin } from 'pixi.js'` và `extensions.add(CullerPlugin)` ở app boot, hoặc gọi `Culler.shared.cull(stage, viewport.getVisibleBounds())` trong ticker.
- Set `cullable=true` + `cullArea = country.bbox` (projected) cho mỗi country sub-mesh.
- **SplitBBox handling (countries cross antimeridian):** nếu `country.bbox.kind === 'split'`, register **2 cull areas** (`bboxWest` + `bboxEast`) qua duplicate sub-mesh entries trong CullerPlugin registry. RU/US/FJ sẽ vẽ 2 lần khi viewport intersect cả 2 halves; mỗi half cull độc lập.
- Ocean layer + UI overlay set `cullable=false` (always render).

**Resize handler:** subscribe `window.matchMedia('(orientation:portrait)')` + `ResizeObserver` → update `viewport.resize(screenW, screenH)`.

### 5.5 Troop rendering

**Pixi v8 ParticleContainer API (BẮT BUỘC dùng `Particle`, không phải `Sprite`, BẮT BUỘC side-effect import cho dynamic color):**
```ts
import 'pixi.js/particle-container';   // BẮT BUỘC — registers shader extension cho dynamic tint
import { ParticleContainer, Particle, Texture, Rectangle } from 'pixi.js';

const container = new ParticleContainer({
  dynamicProperties: { position: true, scale: false, rotation: false, color: true },
  boundsArea: new Rectangle(0, 0, 3600, 1800),
});
const particle = new Particle({
  texture: troopAtlas,
  x, y,
  tint,
  anchorX: 0.5, anchorY: 0.5,   // BẮT BUỘC anchor center, default top-left = visually offset
});
container.addParticle(particle);
```

`dynamicProperties` chỉ enable cái thật sự change (position + tint cho team color); scale/rotation static → enable=false để cắt vertex updates.

Atlas: shared texture atlas (4 frames march anim), single `Texture` reference shared across all particles → 1 batch.

**Phase 5 acceptance test:** spawn 5 particles với 5 distinct tints, screenshot diff vs golden image — verify tint apply per-particle (catches missing side-effect import).

**BlendMode + premultiplied alpha:** Pixi v8 default = **premultiplied alpha**. Atlas builder phải emit textures với pre-multiplied RGB (`canvas.getImageData` → multiply RGB × A / 255). Nếu atlas straight alpha → tint blend incorrect (dark fringe). Verify in build script `scripts/build-atlas.ts`.

**LOD tier sprite counts:**
- Tier 0 (zoom < 0.5): N=177 particles (1/country, sized = sqrt(troops)).
- Tier 1 (zoom 0.5-2): bucket clusters per 16px, ~500-1000 particles.
- Tier 2 (zoom > 2): up to 5000 individual particles.

**Tier switch protocol:**
- Hysteresis (asymmetric): tier transitions có +0.05/-0.05 dead-band asymmetric quanh threshold.
  - Tier 0 → 1: trigger khi `zoom > 0.55` (threshold 0.5 + 0.05).
  - Tier 1 → 0: trigger khi `zoom < 0.45` (threshold 0.5 - 0.05).
  - Tier 1 → 2: trigger khi `zoom > 2.05`.
  - Tier 2 → 1: trigger khi `zoom < 1.95`.
- Build new tier container off-screen → swap visibility → destroy old (Section 15). Switch < 100ms.

### 5.6 Label collision avoidance

Section 5.1 z=6 country labels visible >= zoom 0.8. 177 labels ở zoom 1× whole-world = mass overlap.

**Strategy: priority-based greedy with capital-first:**
1. Sort labels by priority desc:
   - Priority 1: capital cities (`country.capital !== null`) — always render.
   - Priority 2: top-12 countries by area.
   - Priority 3: rest, sorted by current `troops` desc (large factions visible first).
2. Greedy iteration: render label nếu bbox không overlap với labels đã render. Use simple AABB rejection.
3. Re-evaluate khi zoom change OR ownership flip in top-12 (debounced 500ms).
4. Tier 2 (zoom > 2): all labels visible (sparse enough).

Cost: O(N²) AABB worst case = 177² = 31K ops per re-evaluation. Run off-frame (idle callback or `requestAnimationFrame` post-render). Cache result in `viewport.scale`-keyed map.

---

## 6. Gameplay Loop

### 6.1 Combat resolution (per tick @ 4 ticks/sec base)

Với mỗi cặp `(attacker, defender)` có `attacker.ownerId !== defender.ownerId` AND adjacency edge tồn tại (land hoặc sea, Section 4.5):

```
Tick 1: AI quyết định attack (Section 6.2). Tạo Battle entry với isSeaInvasion = adjacencyType === 'sea'.

Tick N: Battle ongoing. Các hằng số dưới đây có rationale:
  // Base rates: 0.02 attacker, 0.015 defender = defender slight advantage default
  attackerRate = 0.02
  defenderRate = 0.015
  // Defender bonus: terrain + home morale boost
  defenderBonus = 1.0 + 0.3 * defender.morale     // morale ∈ [0,1] used here
  // Capital under siege: defender desperate-defense boost (helper, Section 4.2)
  // Reads local TickContext (Section 4.2 TickContext semantics) — chống race khi nhiều battles resolve trong cùng tick.
  if isCapitalUnderSiege(defender, tickCtx): defenderBonus *= 1.4
  // Sea-invasion penalty (4.5)
  if battle.isSeaInvasion:
    attackerRate *= 0.7
    defenderRate *= 1.3   // defender lethality vs invasion fleet

  // Seeded RNG (Section 8.5)
  r1 = rng(); r2 = rng()
  damage_to_defender = attacker.troops * attackerRate * (0.8 + 0.4*r1)
  damage_to_attacker = defender.troops * defenderRate * defenderBonus * (0.8 + 0.4*r2)
  defender.troops = max(0, defender.troops - damage_to_defender)
  attacker.troops = max(0, attacker.troops - damage_to_attacker)
  battle.intensity = clamp(0.3 + Math.log(troops_engaged)/10, 0.3, 1.0)
                                              // Math.log = natural log

// capitalUnderSiege derivation: see Section 4.2 helper isCapitalUnderSiege().
// Sides re-derived at end of each sim-tick batch (Section 4.2 mutation rules).

Defender troops <= 0:
  defender.ownerId = attacker.ownerId   (CAPTURE)
  transferred = floor(attacker.troops * 0.5)  // 50% remaining attacker, NOT initial
  attacker.troops -= transferred
  defender.troops = transferred
  defender.morale = 0.3                  // newly captured = low morale
  // capitalUnderSiege NOT set — it's derived (Section 4.2). Sides re-derived end-of-tick.
  battle resolved, removed
  emit "capture" { attacker, defender, isSeaInvasion } event
```

**Reinforcement (per sim tick):**
```
each country with ownerId active:
  homelandBonus = (country.code === country.ownerId) ? 1.5 : 1.0
                                              // home country reinforces 50% faster
  capitalBonus = (country.capital !== null && country.ownerId owns capital) ? 1.5 : 1.0
                                              // capital nationally adds bonus
  moraleMult = 0.5 + 0.7 * country.morale     // morale ∈ [0,1] → mult ∈ [0.5, 1.2]
  country.reinforceRate = sqrt(country.area) * 0.1 * homelandBonus * capitalBonus * moraleMult
  country.troops += country.reinforceRate * dtGameSeconds

  // Morale recovery toward 1.0 nếu peaceful
  if no adjacent enemy AND no recent battle (lastBattleTick > 30 ticks ago):
    country.morale = min(1.0, country.morale + 0.01 * dtGameSeconds)
```

**Speed rule:** speed chỉ scale game clock ở scheduler/accumulator. Subsystem combat/reinforcement nhận `dtGameSeconds` đã scale và không multiply thêm hệ số speed. Spiral-of-death cap: max 8 sim ticks per render frame (Section 8.5).

**Tie-break (tick cap):** nếu `state.tick > TIE_BREAK_TICKS`, declare winner = side với most territories (tie-break by total troops). Tick-based để khử dependency on real-time + thermal stalls (Section 8.5 rule 6).

**TIE_BREAK_TICKS calculation** (target acceptance "trận average 3-7 phút real time at 32× speed", Section 1):
- 1 sim tick = 0.25s game-time @ base 4Hz.
- At speed 32×, real-time-to-game-time = 32×; 1 real-second = 32 game-seconds = 128 sim ticks.
- 7 minutes real-time × 60 × 128 = **53,760 ticks**.
- 3 minutes real-time × 60 × 128 = 23,040 ticks (lower acceptance bound).
- **`TIE_BREAK_TICKS = 53,760`** (7-minute upper bound; resolves R3).
- Bench Scenario B (60s real @ 32×) covers ≤ 7,680 ticks — well under tie-break, không trigger.

### 6.2 AI behavior

Per AI cycle, iterate sides theo **sorted owner code** (deterministic, Section 8.5). Mỗi side (active owner of ≥ 1 country) làm:

1. **Threat assessment:** đếm enemy neighbor troops trên all owned territories.
2. **Pick target candidates:** với mỗi owned territory, list adjacent enemies. Score per target:
   - `score = (myTroops / theirTroops) * sizeBonus * proximityBonus * (isSeaInvasion ? 0.6 : 1.0)`
   - `sizeBonus = 1 / sqrt(target.area)` (smaller = faster capture).
   - `proximityBonus = 1.2` if target shares ≥2 land borders với my territories (concentrate force), else 1.0.
3. **Attack decision:** target với score cao nhất. Nếu `myTroops/theirTroops > 1.3` AND territory hiện tại không attack (allowed: 1 attacking battle per territory + bất kỳ số defending battles → max 2-3 battles/territory tổng) → tạo Battle. Cho phép territory attack trong khi đang defend nơi khác.
4. **Reinforce:** troops idle (territory không có enemy neighbor) → "march" 5%/tick toward nearest frontline territory (BFS shortest path on adjacency graph).

AI tick frequency: every ~0.5s game time, **sub-batched** thành 4 phases — each phase processes 25% of sides theo deterministic offset `(tick / 4) % 4 === sideIndex % 4`. Stagger giảm CPU spike.

### 6.3 Win condition

Last side với ≥ 1 country alive thắng. Tie-break (tick cap) Section 6.1 (`TIE_BREAK_TICKS = 53,760` ≈ 7min real-time at 32×). Acceptance: average battle 3-7 phút real-time at 32× speed.

### 6.4 Initial state

- Mỗi country = own faction (~177 sides).
- Initial troops = sqrt(area) × 1000 (proportional to size).
- Capital cities marked từ `CountryMeta.capital` khi có data; nếu thiếu lookup thì không vẽ marker giả ở centroid.

---

## 7. Performance Targets

### 7.1 Hard targets (acceptance gate)

| Metric | iPhone 12 (Safari) | MacBook M1 (Chrome) | Galaxy S22 (Chrome) |
|---|---|---|---|
| FPS p50 idle world view | 60 | 60 | 60 |
| Frame time p95 heavy combat | ≤ 18.2 ms | ≤ 17.2 ms | ≤ 20.0 ms |
| Frame time p99 worst frame | ≤ 33.3 ms | ≤ 22.2 ms | ≤ 40.0 ms |
| Init time (boot → playable) | ≤ 1500ms (stretch ≤ 800ms) | ≤ 1000ms | ≤ 2000ms |
| Memory peak | < 250 MB | < 300 MB | < 250 MB |
| Battery drain | < 5% / 5min | n/a | < 6% / 5min |

### 7.2 Sub-budgets per frame (16.6ms at 60fps)

```
Sim tick:           ≤ 2.0 ms (ticks ≤ 4/s, không mỗi frame)
Pixi render:        ≤ 12.0 ms
React HUD render:   ≤ 1.0 ms (memoized, ít re-render)
GC + misc:          ≤ 1.5 ms
─────────────────────────
Total:              ≤ 16.5 ms
```

### 7.3 Profiling tools

- **Chrome DevTools Performance** — desktop profiling.
- **Safari Web Inspector → Timelines** — iOS profiling (USB connect iPhone).
- **In-game FPS overlay** (top-left, optional) → show p50/p95/p99 last 600 frames.
- **`performance.measure()` markers** trong sim + render hot paths.

---

## 8. Benchmark Protocol — đo thực tế

### 8.1 Built-in benchmark mode

URL flag `?bench=1` → bật bench mode:
- Skip menu, vào trận trực tiếp với deterministic seed (Section 8.5).
- Top-left **always-visible JSON panel** (textarea, selectable, copyable trên cả mobile và desktop): FPS (now / p50 / p5 / p1 last 30s) + frame time (p95 / p99) + JS heap (Chromium) hoặc `null` (Safari, marked) + battle count + draw call count.
- Auto-record 60s session, dump JSON vào panel **and** offer Blob download via `<a download="bench.json">`. **Không** rely vào `navigator.clipboard.writeText` (fail trên iOS Safari without user-gesture / non-secure context).
- Mobile-friendly trigger: long-press top-left overlay (500ms) = export. Desktop: `Cmd/Ctrl+B`.
- POST endpoint optional: `?bench=1&post=https://…` → POST JSON kết quả (CI mode).

**Memory metric platform notes:**
| Platform | Source | Auto-collect |
|---|---|---|
| Chrome/Edge desktop | `performance.memory.usedJSHeapSize` | yes |
| Chrome Android | `performance.memory.usedJSHeapSize` | yes |
| Safari iOS / macOS | **manual** via Web Inspector → Timelines → Memory tab | **no** — record `null`, ghi tay vào baseline |
| Cross-origin-isolated only | `performance.measureUserAgentSpecificMemory()` | optional `?bench=1&deepmem=1`, **requires COOP/COEP headers** (Section 13.6); Vercel default deploy KHÔNG isolated → feature off unless user adds headers |

VRAM estimate (Section 14.2) reported separately, computed từ texture inventory — not OS-truth, only ballpark.

### 8.2 3 scenario chuẩn

Mỗi scenario chạy 60s, record frame-time samples mỗi frame. FPS percentile được derive từ frame time để worst-frame metric không bị đảo nghĩa.

**Scenario A — Idle world view:**
- Zoom 1× (whole world).
- Speed 1× (slow).
- Không pan, không zoom.
- Kỳ vọng: highest FPS (baseline).

**Scenario B — Heavy combat:**
- Zoom 1×.
- Speed 32×.
- Force-spawn 50 simultaneous battles ở mid-game state (auto-skip 30s đầu để map đã chia mảnh).
- Kỳ vọng: lowest FPS (worst case).

**Scenario C — Pan/zoom stress:**
- Speed 16×.
- Auto-pan + zoom oscillate 0.5× ↔ 3× theo sin curve.
- Kỳ vọng: stress LOD tier switching.

### 8.3 Benchmark runner script

`src/bench/runBench.ts`:

```ts
// Emits BenchOutput[] (one per scenario) — schema in Section 14.1
async function runBench(): Promise<BenchOutput[]> {
  const results: BenchOutput[] = [];
  for (const scenario of ['idle', 'combat', 'panzoom'] as const) {
    await loadScenario(scenario);
    const samples: FrameSample[] = [];
    const drawCalls: number[] = [];
    const battleCounts: number[] = [];
    const startTime = performance.now();
    while (performance.now() - startTime < 60_000) {
      const sample = await collectFrameSample(); // marker-driven, Section 14.1 FrameSample
      samples.push(sample);
      drawCalls.push(sample.drawCalls);
      battleCounts.push(sample.battleCount);
    }
    const frameMs = samples.map(s => s.frameMs);
    const frameP50 = percentile(frameMs, 0.5);
    const frameP95 = percentile(frameMs, 0.95);
    const frameP99 = percentile(frameMs, 0.99);
    // Thermal split (Section 16 R7 detect)
    const half = samples.length >> 1;
    const frameMsFirst30 = frameMs.slice(0, half);
    const frameMsLast30 = frameMs.slice(half);
    results.push({
      schemaVersion: 1,
      scenario,
      startedAt: new Date().toISOString(),
      device: {
        ua: navigator.userAgent,
        dpr: Math.min(window.devicePixelRatio, 2),
        screen: { w: window.innerWidth, h: window.innerHeight },
      },
      seed: BENCH_SEED, // Section 8.5
      fps: {
        p50: 1000 / frameP50,
        p5: 1000 / frameP95,
        p1: 1000 / frameP99,
      },
      frameMs: { p50: frameP50, p95: frameP95, p99: frameP99 },
      frameMsFirst30Win: { p95: percentile(frameMsFirst30, 0.95) },
      frameMsLast30Win: { p95: percentile(frameMsLast30, 0.95) },
      heapBytes: ('memory' in performance) ? (performance as any).memory.usedJSHeapSize : null,
      vramEstimateBytes: estimateVram(), // Section 14.2
      drawCalls: { p50: percentile(drawCalls, 0.5), p95: percentile(drawCalls, 0.95) },
      battles: { p50: percentile(battleCounts, 0.5), max: Math.max(...battleCounts) },
      determinism: {
        simHash: hashSimState(state),  // FNV-1a 64-bit
        damageTotal: state.statsDamageTotal,
        captureCount: state.statsCaptureCount,
        winnerCode: state.winner,
        totalTicks: state.tick,
        spiralOfDeathDropped: state.statsSpiralDropped,
      },
      samples: includeSamples ? samples : undefined, // gated by `?bench=auto&samples=full`
    });
  }
  // Show in panel + download blob, không dùng clipboard API
  showBenchPanel(results);
  triggerDownload(`bench-${Date.now()}.json`, JSON.stringify(results, null, 2));
  return results;
}
```

Chạy bằng `?bench=auto` hoặc nút trong settings. CI mode: `?bench=auto&post=URL` → POST kết quả.

### 8.4 Baseline targets (mark DONE after measured on real device)

| Device         | A FPS p50 | B frame p95 | C frame p95 |
|---|---:|---:|---:|
| iPhone 12      | 60        | ≤18.2 ms    | ≤20.0 ms    |
| MacBook M1     | 60        | ≤17.2 ms    | ≤17.2 ms    |
| Galaxy S22     | 60        | ≤20.0 ms    | ≤22.2 ms    |

Nếu không đạt → optimization pass thêm. Không ship cho đến khi đạt.

### 8.5 Determinism contract

**Mục tiêu:** mọi metric trong baseline.json reproducible cross-run, cross-commit, cross-machine (cùng platform). Cho phép regression detection mỗi PR.

**Rules:**

1. **Seeded PRNG** mọi nơi trong Sim/AI/Combat:
   ```ts
   import seedrandom from 'seedrandom';
   const rng = seedrandom(state.rngSeed);
   const r = rng();              // [0,1)
   const damage = base * (0.8 + 0.4 * r);
   ```
   `state.rngSeed` lưu trong Zustand (Section 4.2), default = `'mw2-default'`.

2. **`Math.random()` BANNED trong `src/sim/**`, `src/data/**`** — enforced bằng ESLint rule `no-restricted-globals` + CI check.
   - UI/render layer được phép `Math.random()` (vd particle jitter visual-only).

3. **Bench mode hard-codes seed:**
   ```ts
   const BENCH_SEED = 'mw2-bench-v1';
   store.setState({ rngSeed: BENCH_SEED });
   ```

4. **Mid-game fixture (Scenario B):**
   - Build script `scripts/build-fixture.ts` chạy sim 30s game time với `BENCH_SEED` từ initial state, snapshot toàn bộ `GameState` → `bench/baseline-fixtures/midgame.json`.
   - Bench Scenario B load fixture trực tiếp thay vì simulate 30s mỗi run (faster bench, identical state).
   - Re-generate khi sim/AI logic thay đổi (PR check: nếu `src/sim/**` đổi → fixture phải re-emit + commit).

5. **Sim tick ordering deterministic:**
   - Iterate countries theo sorted ISO codes (alphabetical), KHÔNG `Object.keys()` order.
   - Battles[] sorted theo `(startTick, attackerCode, defenderCode)` trước khi resolve.
   - AI per-side: iterate sides theo sorted code.

6. **Time accumulator:** fixed-step (250ms game-time per sim tick @ base 4Hz). Spiral-of-death guard: max 8 sim ticks per render frame in **gameplay mode**; over → drop `dtGameSeconds` excess + emit telemetry event `sim-spiral-of-death { dropped }`.
   - **Bench mode disables spiral cap** (allow up to 64 ticks/frame) để fixture replay deterministic regardless of frame stalls. Bench acceptance asserts `dropped === 0` cho all 3 scenarios.

7. **Iteration order rules:**
   - Use `Array.prototype.sort()` (codepoint default), **NEVER `localeCompare`** (depends on runtime locale → CI/dev mismatch).
   - Iterate countries: `Object.keys(state.countries).sort()`.
   - Iterate battles: sorted theo `(startTick, attackerCode, defenderCode)`.

8. **Acceptance gate:** CI runs bench Scenario B 3 times → `BenchOutput.determinism.simHash` phải identical 3 lần AND `spiralOfDeathDropped === 0` (bench mode disables cap, Section 8.5 rule 6). Khác = sim non-determinism leak → fail.

   **`simHash` = FNV-1a 64-bit hash của canonical full sim state** (KHÔNG chỉ aggregate tuple, để catch divergence hiếm như morale drift):
   ```
   const canonical = JSON.stringify({
     totalTicks: state.tick,
     winnerCode: state.winner,
     // Sorted by code (deterministic — Section 8.5 rule 7)
     countries: Object.keys(state.countries).sort().map(c => [
       c, state.countries[c].ownerId, Math.round(state.countries[c].troops),
       Math.round(state.countries[c].morale * 1000), state.countries[c].lastBattleTick,
     ]),
     // Sorted by (startTick, attackerCode, defenderCode) — codepoint compare, NEVER localeCompare (Section 8.5 rule 7)
     battles: state.battles
       .slice()
       .sort((a, b) => {
         if (a.startTick !== b.startTick) return a.startTick - b.startTick;
         if (a.attacker !== b.attacker) return a.attacker < b.attacker ? -1 : 1;
         return a.defender < b.defender ? -1 : (a.defender > b.defender ? 1 : 0);
       })
       .map(b => [b.id, b.attacker, b.defender, b.startTick, Math.round(b.intensity * 1000), b.isSeaInvasion]),
     counters: { ownership: state.ownershipVersion, troops: state.troopsVersion, battles: state.battlesVersion, sides: state.sidesVersion },
     statsAggregate: { damageTotal: state.statsDamageTotal, captureCount: state.statsCaptureCount },
   });
   simHash = fnv1a64(canonical);
   ```
   Round troops/morale to integer to avoid float-bit drift. Aggregate tuple alone (damageTotal, captureCount, winnerCode, totalTicks) cũng được expose trong `determinism` block cho debugging convenience.

---

## 9. Implementation Phases (giao Claude Code)

Mỗi phase = 1 commit riêng + 1 round benchmark + reviewer check.

> **Time estimates revised** dựa trên review feedback. Original estimate "10-12h" là lạc quan dangerously; thực tế 18-26h cho MVP đạt acceptance gate (Section 7.1) trên 3 devices.

### Phase 0 — Project bootstrap (1h)
- Vite 7 + TypeScript 5.4 + React 18 + Pixi v8.6 setup; ESLint with `no-restricted-globals` cho `Math.random` trong sim/data folders.
- Folder structure (Section 10).
- Pixi `Application.init({ resolution, antialias, powerPreference: 'high-performance' })` mount vào React component (Section 5.4).
- `extensions.add(CullerPlugin)` ở app boot.
- Hello world: 1 colored rect + FPS overlay + visible bench panel placeholder.
- **Deliverable:** `npm run dev` chạy; FPS overlay 60 trên empty scene; bundle analyzer reports < 280KB initial gzipped.

### Phase 1a — Build-time world data pipeline (2h)
- `scripts/build-world.ts`: load NE 50m → project equirectangular → split antimeridian → simplify (2 LOD tiers, tier-0 omitted) → triangulate (earcut, MultiPolygon-aware Section 4.6) → tessellate borders → compute land adjacency (rbush) → compute sea-lane adjacency (Section 4.5) → 4-color graph → emit `world.json` + `world.polygons.tier{1,2}.json` + `world.borders.tier{1,2}.json` + `adjacency.json` + `bench/baseline-fixtures/midgame.json` placeholder.
- Validation: graph connected, no self-loops, all ISO codes unique.
- Test: USA land neighbors = {CA, MX}; CU sea-lane neighbors include {US, MX, JM}; JP sea-lane includes {KR}.
- **Deliverable:** `npm run build:world` chạy < 30s offline; outputs valid; tests pass.

### Phase 1b — Boot loader + render (2h)
- Parallel fetch 4 JSON files (`world.json`, `world.polygons.tier1.json`, `world.borders.tier1.json`, `adjacency.json`); schema-version validate; reject mismatch with user-facing error (Section 13).
- pixi-viewport construct với `events: app.renderer.events` (Section 5.4).
- Render all country meshes (tinted via parent Container, geometry from `world.polygons.tier1.json`; Section 4.6 sub-mesh handling).
- Borders single pre-tessellated stroke ribbon Mesh (Section 5.3 border block).
- **Deliverable:** map hiển thị ≤ 1500ms sau click Start (iPhone 12 Safari measured, canonical gate); pan/zoom mượt 60fps zoom 1×; CullerPlugin reports culled count > 0 khi pan vào 1 region.

### Phase 2 — State + sim loop (2h)
- Zustand + immer store với GameState shape (Section 4.2); seedrandom integration (Section 8.5).
- Init each country = own faction; sorted ISO iteration order.
- Sim layer: fixed-step accumulator 4 ticks/sec game time; spiral-of-death guard max 8 sim steps/frame.
- HUD: pause, speed buttons (1/2/4/8/16/32/64).
- Render layer: subscribe `ownershipVersion` (Section 4.2 mutation rules) → re-tint country fills khi capture event. Subscribe `troopsVersion` cho troop sprite count update.
- **Deliverable:** game starts; all countries idle; speed control works; FPS stable 60 zoom 1×; React DevTools Profiler shows leaderboard re-render < 1 ms/update.

### Phase 3 — Combat core (3h)
- AI logic (Section 6.2) với deterministic iteration order.
- Battle struct + resolver (Section 6.1) với seeded RNG; sea-invasion damage modifier (Section 4.5).
- Capture event handler; win check.
- Combat highlight: pre-computed border segments + shader uniform pulse (no per-frame Graphics redraw).
- **Deliverable:** trận chạy đến winner; 50+ battles concurrent test pass; **CI: bench Scenario B 3 lần → identical hash** (Section 8.5 acceptance).

### Phase 4 — UI + leaderboard (1.5h)
- Top-12 leaderboard React component subscribes `sidesVersion` selector + memoized derive (debounce 100ms cho speed > 8×).
- Battle counter, alive count, sea-invasion count.
- Winner overlay screen + replay seed display (cho user reproduce).
- Settings panel: bench mode toggle, audio toggle, RNG seed override.
- **Deliverable:** UI cập nhật real-time đúng; React Profiler check < 1ms/update; no `key` warnings; no re-render khi state diff không relevant.

### Phase 5 — Audio + game feel (2h)
- **Lazy-load Tone.js** (`const Tone = await import('tone')`) on first user gesture (audio unlock); cleanup transport in unmount (Section 15).
- SFX: capture chime, win fanfare, ambient drone, sea-invasion swoosh.
- Mobile haptic: `navigator.vibrate?.(10)` on capture (feature-detect).
- Battle effect sprites (Particle pool, Section 5.5).
- Capital city marker icons (only nếu `country.capital !== null`).
- **Deliverable:** game có cảm giác sống; audio không lag/jitter; lazy-load không tăng initial bundle (analyzer verify).

### Phase 6a — LOD implementation (2h)
- LOD tier switching với hysteresis (Section 5.5).
- Aggregate render tier-0 sử dụng centroid+balls (no polygon geometry). cacheAsTexture có thể snap toàn ocean+borders+balls thành 1 texture, refresh debounced 100ms on owner-set diff.
- Tier teardown protocol (Section 15) — destroy old container off-screen.
- **Deliverable:** zoom oscillation Scenario C smooth; no flicker; tier switch < 100ms measured.

### Phase 6b — Benchmark + telemetry (2h)
- Bench mode (`?bench=auto`); fixture loader for Scenario B.
- Telemetry schema emit (Section 14).
- Run all 3 scenarios trên iPhone 12 + MacBook M1 + Android. Bench JSON downloaded, committed.
- **Deliverable:** `bench/baseline.json` committed; all Section 7.1 targets pass; bench reproducibility hash identical 3 lần.

### Phase 7 — Optimization pass (2-6h, conditional)
- Trigger nếu Phase 6 fail.
- Profile (Chrome DevTools / Safari Web Inspector); fix top 3 hotspots.
- Common fixes: increase tier-1 simplification tolerance, reduce particle count, batch tint updates, defer tier-2 lazy-load, throttle border palette uniform updates.
- Re-bench, re-commit; goto Phase 6 acceptance.

### Phase 8 — Resilience hardening (1.5h)
- WebGL context-loss handler (Section 13.3).
- ResizeObserver + orientation handler.
- Asset preload manifest + loading state UI.
- Error boundary cho Pixi mount.
- **Deliverable:** Section 13 fully implemented; manual test: DevTools "Lose WebGL context" → recovery < 2s, no blank screen.

**Total realistic: 18-26h** cho MVP qua acceptance gate. Phase 7 conditional có thể đẩy lên 28h nếu perf fail nhiều round.

---

## 10. File Structure

```
src/
├── main.tsx                    # React mount + Pixi mount
├── App.tsx                     # Layout, Setup vs Combat phase routing
│
├── data/
│   ├── loadWorld.ts            # GeoJSON parse → WorldData
│   ├── adjacency.ts            # Neighbor computation
│   ├── centroids.ts            # Polygon centroid math
│   ├── colors.ts               # 4-color greedy assignment
│   ├── capitals.ts             # ISO_A2 → capital name/lng/lat lookup
│   └── countryNamesVi.ts       # ISO_A2 → tên Việt lookup
│
├── state/
│   ├── store.ts                # Zustand root store
│   ├── selectors.ts            # Memoized derived state
│   └── slices/
│       ├── gameSlice.ts        # countries, battles, tick
│       ├── settingsSlice.ts    # speed, paused, audio
│       └── statsSlice.ts       # winner, alive count
│
├── sim/
│   ├── tick.ts                 # Tick scheduler
│   ├── combat.ts               # Battle resolution
│   ├── ai.ts                   # AI per-side logic
│   ├── reinforce.ts            # Troop generation
│   └── adjacency.ts            # Runtime neighbor queries
│
├── render/
│   ├── PixiRoot.tsx            # React component mount Pixi app
│   ├── stage.ts                # PIXI.Application setup
│   ├── viewport.ts             # pixi-viewport setup
│   ├── layers/
│   │   ├── ocean.ts
│   │   ├── countryFills.ts     # Section 5.3 logic
│   │   ├── borders.ts
│   │   ├── battleHighlight.ts
│   │   ├── troops.ts           # ParticleContainer
│   │   ├── effects.ts          # Sprite pool
│   │   └── labels.ts
│   ├── lod.ts                  # Tier switching logic
│   └── atlas.ts                # Texture atlas builder
│
├── ui/
│   ├── HUD.tsx                 # Wrapper
│   ├── Leaderboard.tsx
│   ├── SpeedControl.tsx
│   ├── BattleCounter.tsx
│   ├── WinnerOverlay.tsx
│   ├── Settings.tsx
│   └── FpsOverlay.tsx
│
├── audio/
│   ├── engine.ts               # Tone.js synth setup
│   └── sfx.ts                  # Per-event sounds
│
├── bench/
│   ├── runBench.ts             # Auto bench runner (Section 8.3)
│   ├── scenarios/
│   │   ├── idle.ts
│   │   ├── combat.ts           # loads midgame.json fixture
│   │   └── panzoom.ts
│   ├── panel.ts                # JSON panel + download blob (Section 8.1)
│   ├── vram.ts                 # VRAM estimator (Section 14.2)
│   └── samples.ts              # FrameSample schema (Section 14.1)
│
├── telemetry/
│   ├── events.ts               # TelemetryEvent types (Section 14.4)
│   └── emit.ts                 # window.__mw2Telemetry hook
│
└── utils/
    ├── perf.ts                 # performance.measure helpers
    ├── math.ts                 # vec2, lerp, etc.
    ├── rng.ts                  # seedrandom wrapper (Section 8.5)
    └── id.ts                   # deterministic ID helpers (no nanoid in sim/data per Section 8.5)

scripts/
├── build-world.ts              # Section 4.3 build-time pipeline
├── build-fixture.ts            # Section 8.5 mid-game fixture
└── build-atlas.ts              # Texture atlas pack

public/
└── geo/
    ├── world.json              # WorldFile (CountryMeta[], Section 4.1)
    ├── world.polygons.tier1.json   # Default LOD country fills
    ├── world.polygons.tier2.json   # Detail LOD country fills (lazy zoom > 1.5)
    ├── world.borders.tier1.json    # Default LOD stroke ribbon Mesh + per-vertex country index attrs
    ├── world.borders.tier2.json    # Detail LOD borders (lazy zoom > 1.5)
    # No tier0 file — aggregate render (zoom < 0.5) uses centroid+balls, no polygons/borders
    └── adjacency.json              # Land + sea-lane edges with type tag

vendor/
└── ne_50m_admin_0_countries.geojson  # Source GeoJSON COMMITTED + SHA256 in CHECKSUMS.txt (Section 4.3 step 1)

bench/
├── baseline.json                  # Committed bench results
└── baseline-fixtures/
    └── midgame.json               # Section 8.5 deterministic state snapshot

src/data/migrations/
└── from-1-to-2.ts                 # Section 14.3 schema migrations (added when needed)

index.html                          # Section 13.2 preload hints
vite.config.ts                      # Bundle analyzer + budget plugin
tsconfig.json
package.json
.eslintrc.cjs                       # no-restricted-globals: Math.random in sim/data
```

---

## 11. Open Questions (Justin review trước khi giao)

**Status: ALL ANSWERED 2026-04-25.**

1. ~~**Tên Việt cho countries**~~ → **ANSWERED**: keep hardcoded VN list (194 nước), fallback Natural Earth NAME field cho countries thiếu trong VN list.
2. ~~**Visual style**~~ → **ANSWERED**: **Option A — Terminal/sci-fi vibe** (Defcon/Bloomberg Terminal aesthetic). Implementation contract → Section 20.
3. ~~**Player faction option**~~ → **ANSWERED**: KHÔNG. Spec giữ 100% spectator/AI-only cho MVP.
4. ~~**Ngôn ngữ implementation**~~ → **ANSWERED**: TypeScript strict mode.
5. ~~**Mobile-first hay desktop-first**~~ → **ANSWERED**: Mobile-first. iPhone 12 Safari là acceptance gate primary; desktop optimized but không decision driver.
6. ~~**Deployment target**~~ → **ANSWERED**: Section 19 — Vercel chính + GH Pages alternative documented.
7. ~~**Bundle GeoJSON vs fetch CDN**~~ → **ANSWERED**: Bundle vào `public/geo/` (same-origin, no runtime CDN dependency), content-hashed via manifest (Section 19.2).

---

## 12. Reviewer checklist (trước khi merge mỗi phase)

**Code quality:**
- [ ] Code compiles không warning. TS strict, no `any` (use `unknown` + narrow nếu cần).
- [ ] No `Math.random()` trong `src/sim/**` hoặc `src/data/**` (CI lint check).
- [ ] No `Map`/`Set` trong Zustand store (Section 4.2).

**Performance:**
- [ ] Bundle analyzer run; initial route ≤ 350KB gzipped, total ≤ 500KB. **Hard fail nếu vượt** (CI gate).
- [ ] Tone.js trong async chunk, không initial bundle.
- [ ] Mỗi PR có before/after benchmark JSON nếu touch `src/render/**`, `src/sim/**`, `src/data/**`.
- [ ] No layout thrash: React HUD render < 1ms (Profiler verify).
- [ ] LOD tier switch < 100ms measured.

**Correctness:**
- [ ] Bench Scenario B 3-run hash identical (Section 8.5 acceptance).
- [ ] Adjacency graph connected (build script test).
- [ ] No `console.error` trên happy path.
- [ ] Schema version bumped if `world.json`/`adjacency.json`/store shape changed.

**Resilience:**
- [ ] Mobile gesture works (real iPhone test).
- [ ] WebGL context-loss recovery test pass (DevTools "Lose context").
- [ ] Resource lifecycle: `destroy()` called on unmount; no leaked textures (Section 15).
- [ ] Error boundary catches Pixi mount failure.

**Documentation:**
- [ ] Section 11 Open Question updated nếu trả lời mới.
- [ ] Section 16 Risks updated nếu phát sinh risk mới.

---

## 13. Error & Loading states

### 13.1 Loading lifecycle (boot → playable)

State machine:
```
idle → fetchingAssets → parsingAssets → buildingScene → ready
                ↓               ↓               ↓
              error          error          error
```

UI:
- `idle`: Splash screen với "Start" button.
- `fetchingAssets`: Progress bar với % của 4 JSON file boot-eager (sum bytes downloaded / total Content-Length).
- `parsingAssets`/`buildingScene`: Indeterminate spinner + step label ("Building map…", "Initializing renderer…").
- `ready`: Splash fades, game visible.
- `error`: Error card với message + Retry button + Report-link.

**Definition: "boot → playable" timing window:**
- T0 = `performance.now()` ngay sau click Start (user gesture).
- T_playable = first non-skeleton frame rendered (Pixi `app.ticker` fired ≥ 1 lần với map mesh visible).
- Acceptance gate (Section 7.1): `T_playable - T0 < 1500ms` trên iPhone 12.
- Logged to `performance.measure('boot-to-playable', T0, T_playable)`.

### 13.2 Asset preload strategy

- Preload hints generated **dynamically** từ `src/data/manifest.ts` (auto-gen tại build, includes content-hashed filenames per Section 19.2). Vite plugin injects `<link rel="preload" as="fetch" href="/geo/world.{hash}.json" crossorigin="anonymous">` cho 4 eager files vào `index.html`. **Note:** preload `as="fetch"` **requires `crossorigin` attribute** even cho same-origin để preload reuse với `fetch()` request (W3C resource hints spec). Without `crossorigin`, browser warns "preload was not used" và double-downloads.
- `world.polygons.tier1.json` + `world.borders.tier1.json` preload riêng (default tier render).
- `world.polygons.tier2.json` + `world.borders.tier2.json` lazy-load chỉ khi viewport zoom > 1.5 (Section 4.3).
  - **Lazy-load contract:** parallel fetch 2 file via `Promise.all`. Cache result in `WorldData.polygons.tier2`/`borders.tier2`. Debounce trigger by 300ms (chống thrash khi user pump zoom). Single failure → log telemetry, retry 1× (exponential backoff 500ms); persistent failure → degraded mode (stay on tier-1 geometry, không escalate sang tier-2 anymore in this session).
- Service worker (optional Phase 9): cache-first cho `/geo/*` với content-hash trong filename (`world.{hash}.json`).

### 13.3 WebGL context loss recovery

iOS Safari **lose WebGL context** thường xuyên: background tab > 30s, low memory pressure, high thermal state.

Handler:
```ts
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  store.setState({ paused: true });
  showOverlay('Pausing — graphics restoring…');
});
canvas.addEventListener('webglcontextrestored', async () => {
  await rebuildPixiResources(); // re-upload geometry buffers, atlases
  store.setState({ paused: false });
  hideOverlay();
});
```

`rebuildPixiResources` re-creates: country sub-meshes (geometry from cached tier files, Section 4.6), troop atlas, border ribbon Mesh, particle containers. Audio (Tone.js) survives context loss — không cần rebuild.

Test: DevTools → Rendering → "WebGL context loss" extension hoặc `WEBGL_lose_context.loseContext()` direct.

### 13.4 Browser fallback

WebGL2 detect at boot:
```ts
const gl2 = document.createElement('canvas').getContext('webgl2');
if (!gl2) {
  showFatalError('Trình duyệt không hỗ trợ WebGL2. Vui lòng cập nhật Safari ≥15 / Chrome ≥56.');
  return;
}
```

Pixi v8 require WebGL2 — fallback WebGL1 không official supported. Block + clear message tốt hơn render lỗi.

### 13.5 Audio unlock

- iOS Safari require user gesture trước AudioContext.resume().
- First "Start" click triggers Tone.js dynamic import + `Tone.start()` resolve.
- Failure (user denied / quota) → game vẫn chạy, audio toggle disabled, banner notify.
- **High-speed rate limiting:** capture chime token-bucket max **5 chimes/sec** real-time; vượt → drop. Speed 64× heavy combat sẽ generate 10-20 captures/sec → unbearable spam. Win fanfare exempt.

### 13.6 Cross-origin isolation (deepmem optional)

`?bench=1&deepmem=1` (Section 8.1) gọi `performance.measureUserAgentSpecificMemory()` — chỉ work khi `crossOriginIsolated === true`. Để enable trên Vercel:

```ts
// vercel.json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
      { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
    ]
  }]
}
```

**Trade-off:** COEP=`require-corp` blocks embeds (iframes, third-party images) — không matter cho game này (no third-party). MVP **không** ship headers; deepmem là power-user feature documented chứ không default.

### 13.7 HMR behavior (dev only)

Vite HMR re-mounts React component without page reload. Pixi destroy/recreate cycle:
- `useEffect` cleanup gọi `app.destroy(true, ...)` (Section 15).
- New mount creates fresh app instance.
- Texture registry (Section 14.2) cleared on destroy → no leak.
- Dev-only assert: `console.warn(`HMR cycle ${count}, VRAM=${estimateVram()/1e6}MB`)` — manual eyeball check không leak across cycles.

---

## 14. Telemetry & schema versioning

### 14.1 Frame sample schema (`src/bench/samples.ts`)

```ts
type FrameSample = {
  t: number;          // performance.now() epoch
  frameMs: number;    // total frame duration
  simMs: number;      // measured via performance.measure markers
  renderMs: number;
  reactMs: number;
  drawCalls: number;  // Pixi renderer.stats?
  battleCount: number;
};

type BenchOutput = {
  schemaVersion: 1;
  scenario: 'idle' | 'combat' | 'panzoom';
  startedAt: string;  // ISO timestamp
  device: { ua: string; dpr: number; screen: { w:number, h:number } };
  seed: string;
  fps: { p50:number; p5:number; p1:number };
  frameMs: { p50:number; p95:number; p99:number };
  frameMsFirst30Win: { p95:number }; // Thermal throttle detect (R7)
  frameMsLast30Win: { p95:number };
  heapBytes: number | null;     // null trên Safari
  vramEstimateBytes: number;    // Section 14.2
  drawCalls: { p50:number; p95:number };
  battles: { p50:number; max:number };
  // Determinism block (Section 8.5 acceptance gate fields):
  determinism: {
    simHash: string;           // FNV-1a 64-bit hash of canonical FULL sim state (Section 8.5 contract — NOT just aggregate tuple)
    // Aggregate tuple fields exposed for debugging / human-readable diff:
    damageTotal: number;
    captureCount: number;
    winnerCode: string | null; // null nếu game chưa kết thúc trong 60s window
    totalTicks: number;
    spiralOfDeathDropped: number; // sim ticks dropped by spiral guard; bench-mode disable (Section 8.5) → 0
  };
  samples?: FrameSample[];      // raw samples (optional; gated by `?bench=auto&samples=full`)
};
```

### 14.2 VRAM estimator

**Pixi v8 không expose stable `TextureSource.all` public API.** Maintain own registry trong `src/render/textureRegistry.ts`:

```ts
const registry = new Set<TextureSource>();

export function trackTexture(src: TextureSource) { registry.add(src); }
export function untrackTexture(src: TextureSource) { registry.delete(src); }

export function estimateVram(): number {
  let total = 0;
  for (const s of registry) {
    if (s.destroyed) { registry.delete(s); continue; }
    const w = s.width * (s.resolution ?? 1);
    const h = s.height * (s.resolution ?? 1);
    const bytesPerPixel = 4; // assume RGBA8 (no compressed format trong MVP)
    const mipmapMultiplier = s.autoGenerateMipmaps ? 1.34 : 1.0; // sum geometric series 1+1/4+1/16+…
    total += w * h * bytesPerPixel * mipmapMultiplier;
  }
  return total;
}
```

Atlas builder + mesh creator gọi `trackTexture()` khi alloc, `untrackTexture()` khi destroy (Section 15).

**Caveat:** ballpark estimate, không phải OS-truth (compression, fragmentation, framebuffer attachments, GPU driver overhead không tính). Đủ để regression-detect cho R1. Walk every 1s off-frame; emit telemetry event `texture-budget-exceeded` nếu vượt 80MB threshold.

### 14.3 Schema versioning rules

- `world.json`, `adjacency.json`, `bench/baseline*.json`, Zustand `GameState`, store-persisted settings — **mỗi cái có `schemaVersion: number`**.
- Bump rules:
  - **MAJOR (incompatible):** add/remove/rename required field, change type. Forces full re-build (`build:world`) + breaks old fixtures.
  - **MINOR (additive):** new optional field. Loader tolerates missing.
- Loader behavior: if `loaded.schemaVersion > CODE_KNOWS_VERSION` → fail-fast với error. If `<` → run migration if registered, else fail.
- Migration registry: `src/data/migrations/{from-1-to-2}.ts` — pure functions, tested.

### 14.4 Production telemetry (post-MVP, not blocking)

Hooks reserved (no-op trong MVP):
```ts
type TelemetryEvent =
  | { type: 'boot-to-playable', ms: number }
  | { type: 'frame-budget-violation', frameMs: number, scenario: string }
  | { type: 'webgl-context-lost' }
  | { type: 'sim-spiral-of-death', dropped: number }
  | { type: 'texture-budget-exceeded', bytes: number };

window.__mw2Telemetry?.push?.(event);
```

Production wires `__mw2Telemetry` to backend (Vercel Analytics, Sentry, etc.). MVP chỉ console.warn.

---

## 15. Resource lifecycle

### 15.1 Pixi destroy contract

On React unmount của `PixiRoot`:
```ts
useEffect(() => {
  const app = createPixiApp();
  return () => {
    app.ticker.stop();
    cullerCleanup();
    viewport.destroy({ children: true, texture: false }); // shared atlas keep
    app.destroy(true, { children: true, texture: true, textureSource: true });
  };
}, []);
```

### 15.2 Texture inventory (singleton lifetime)

Owned modules:
- `src/render/atlas.ts` — troop sprite atlas. Created once, destroyed on app unmount.
- `src/data/loadWorld.ts` — geometry buffers (Float32Array). Persisted, freed on app unmount.

KHÔNG share textures across app remount (e.g. dev HMR) — luôn rebuild để tránh "ghost texture leak".

### 15.3 Tone.js cleanup

```ts
const audio = await import('./audio/engine');
return () => {
  audio.transport.stop();
  audio.transport.cancel();
  audio.context.close(); // releases Web Audio resources
};
```

Nếu user navigate away (visibilitychange hidden > 30s): pause sim + suspend AudioContext (battery saving).

### 15.4 Subscription cleanup

- Zustand `subscribe` returns unsubscribe — store trong useEffect cleanup.
- ResizeObserver / matchMedia listeners — disconnect/removeEventListener trong cleanup.
- Pixi event listeners (`webglcontextlost`, `webglcontextrestored`) — removeEventListener trong cleanup.

### 15.5 Memory leak test (CI optional)

Headless Chrome test: load app → unmount → load → unmount × 5. Heap grew should be < 5MB. Run nightly, not per-PR.

---

## 16. Risks & Mitigations

(Tách khỏi Open Questions vì đây là technical risks đã identified, không cần stakeholder approve.)

| # | Risk | Likelihood | Impact | Mitigation | Detect |
|---|---|---|---|---|---|
| R1 | VRAM blowup từ cached textures lớn (RU/CA/US) | M | H (iOS tab kill) | Section 5.3 hybrid mesh+tint; tier-0 aggregate cache có 2048² cap; VRAM estimator (14.2) | Section 8 bench memory |
| R2 | Safari iOS WebGL context loss khi background | H | M (UX) | Section 13.3 handler + auto-pause | Manual test + telemetry event |
| R3 | AI equilibrium (game không kết thúc) | M | H (gameplay broken) | Sea-lane (4.5) ensures connected; reinforcement snowball Section 6.1; tick cap `TIE_BREAK_TICKS = 53,760` (= 7min real @ 32×) → tie-break by territories | Bench Scenario B win rate + tickCount |
| R4 | Bundle size drift > 500KB | M | M (perf budget fail) | CI hard-fail gate; lazy Tone.js; Pixi tree-shake | rollup-plugin-visualizer mỗi PR |
| R5 | Sim non-determinism leak (e.g. accidental Math.random) | M | H (bench broken) | ESLint `no-restricted-globals` + 3-run hash check (Section 8.5) | CI fail |
| R6 | Build script timing > 30s blocks dev iteration | L | L | Cache tier files by content hash; only rebuild if NE source GeoJSON changes | Build time log |
| R7 | iPhone 12 thermal throttle ở Scenario B 60s | M | M (FPS drop late in run) | Bench protocol require Low Power Mode OFF, device cool start; split p95 vào early-30s / late-30s windows để detect throttle | Bench JSON `frameMs_first30 / frameMs_last30` split |
| R8 | pixi-viewport v6 + Pixi v8.next breaking change | L | M | Pin Pixi `8.6.6` exact (Section 2); vendor fork pixi-viewport nếu cần | `npm ci` lockfile |
| R9 | NE 50m polygon errors (self-intersect, holes wrong winding) | M | M (render glitch) | `@turf/rewind` + `@turf/cleanCoords` build-time | Build script validates |
| R10 | Mobile orientation change loses Pixi state | M | L (UX hiccup) | ResizeObserver re-bounds viewport; Section 15 cleanup test | Manual rotate test |

---

## 17. Accessibility (MVP minimal acknowledgment)

**Spectator-only design** đơn giản hóa accessibility scope (no input flow). MVP commitments:

- **Color-blind palette:** 4-color HSL output từ Welsh-Powell (Section 4.3 step 8) tested với 3 simulators (deuteranopia, protanopia, tritanopia) trong build script. Fail nếu adjacent colors có ΔE < 25 trong simulated mode → escalate to 5-color palette.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` → battle highlight pulse uniform `uPulseTime` set tới fixed value (no oscillation), particle anim freezes.
- **Keyboard nav:** spectator vẫn có pause/speed/zoom hotkeys: `Space` pause, `1/2/4/8` speed, `+/-` zoom, `Arrow keys` pan.
- **Screen reader:** HUD elements semantic HTML (`<button>`, `<output>`, `aria-live="polite"` cho leaderboard). Pixi canvas marked `aria-hidden="true"` (purely visual).
- **Out of scope MVP:** full screen reader narrative for game state (post-MVP).

## 18. Faction convergence — DEFERRED to Phase 9 conditional

**Decision (Justin 2026-04-25): defer**. Chạy E2E thật trước khi quyết.

Vấn đề: 177 sides initial = mid-game có thể stuck với isolated islands. Acceptance "trận average 3-7 phút real time at 32× speed" (Section 1).

**Trigger condition để add mechanics**: nếu E2E test sau Phase 6 cho thấy median trận > 10 phút real-time at 32×, OR > 5% trận hit `TIE_BREAK_TICKS = 53,760` (Section 6.1).

**Mechanics ready để add (Phase 9 conditional, ~90min):**
- **Surrender**: side có ≤ 1 territory AND `troops < 0.1 × strongest enemy neighbor` → auto-cede territory cho attacker (eliminate).
- **Migration**: idle side, 0 enemy adjacency suốt 60+ ticks → auto-merge into largest land-adjacent neighbor (preserves territory count, reduces faction count).

Cả 2 chống "stuck island side". Detection telemetry trong bench output (`battles.medianDurationTicks`, `tieBreakHitRate`).

---

## 19. Deployment & CI/CD

### 19.1 Repo + GitHub setup

**Repo location:** `github.com/{justin}/modern-wars-2` (private hoặc public).

**Branches:**
- `main` — protected, only merge via PR + CI green.
- `dev` — integration branch, deploys → staging Vercel preview.
- Feature branches → PR vào `dev`.

**Required CI gates (GitHub Actions, `.github/workflows/ci.yml`):**

```yaml
name: CI
on: { pull_request: {}, push: { branches: [main, dev] } }
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run lint           # ESLint no-restricted-globals (Section 8.5)
      - run: npm run typecheck      # tsc --noEmit
      - run: npm run build:world    # Section 4.3 build pipeline
      - run: npm run build          # Vite build
      - run: npm run test:unit      # Vitest sim/data tests
      - run: npm run bench:headless # Headless Chrome bench Scenario B 3-run hash check
      - run: npm run check:bundle   # Hard fail nếu initial > 350KB hoặc total > 500KB gz
```

**Bundle gate:** `scripts/check-bundle.ts` reads Vite build manifest, asserts:
- Initial route gzipped ≤ 350KB.
- Total app gzipped ≤ 500KB (excl. `public/geo/*`).
- Tone.js trong async chunk (verify by checking entry chunk does NOT contain "tone").

**Determinism gate:** `npm run bench:headless` chạy Puppeteer/Playwright headless Chrome → load `http://localhost:5173/?bench=auto&seed=mw2-bench-v1`, scenario B 3 lần, hash `(damage_total, capture_count, winner_code, total_ticks)`. Fail nếu khác.

### 19.2 Vercel deployment

**`vercel.json`:**
```json
{
  "buildCommand": "npm run build:world && npm run build",
  "outputDirectory": "dist",
  "framework": "vite",
  "headers": [
    {
      "source": "/geo/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/(.*\\.html)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }
      ]
    }
  ],
  "rewrites": [
    { "source": "/(.*)", "destination": "/" }
  ]
}
```

**Vercel project config (UI):**
- Connect GitHub repo.
- Branch deploy: `main` → production (`modern-wars-2.vercel.app` hoặc custom domain).
- Branch deploy: `dev` + every PR → preview URL (auto-comment trong PR).
- No env vars required (game runs entirely client-side).

**Asset hashing contract:** Vite tự động hash `assets/*.{js,css}` (filename `assets/index-{hash}.js`). For `public/geo/*` (Vite không hash by default vì đặt ở `public/`):
- Build script `scripts/build-world.ts` emits filename với content-hash: `world.{hash}.json`, `world.polygons.tier1.{hash}.json`, etc.
- Inject hash mapping vào `src/data/manifest.ts` (auto-gen) → loader reads filenames at runtime.
- Vercel `Cache-Control: max-age=31536000, immutable` rule below valid because filename changes when content changes.

### 19.3 Alternative: GitHub Pages

Nếu Justin chọn không dùng Vercel:

**`.github/workflows/deploy-pages.yml`:**
```yaml
name: Deploy Pages
on: { push: { branches: [main] } }
permissions: { pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci && npm run build:world && npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Vite config cho GitHub Pages:** `base: '/modern-wars-2/'` trong `vite.config.ts` (subpath URL).

**Trade-offs:**
| | Vercel | GitHub Pages |
|---|---|---|
| Preview URL per PR | ✅ auto | ❌ manual |
| Custom domain | ✅ free | ✅ free |
| Edge cache | ✅ global | ✅ global (Fastly) |
| HTTP/2 push, brotli | ✅ | ✅ |
| Bundle limit | 100MB free | 1GB |
| COOP/COEP headers (Section 13.6) | ✅ vercel.json | ❌ không hỗ trợ custom headers |
| Setup time | 5 phút | 10 phút |

**Recommendation:** Vercel cho dev workflow (preview URL) + Vercel custom domain cho production. GitHub Pages backup nếu Vercel quota issue.

### 19.4 View-online checklist (post Phase 6 deployment)

- [ ] PR `dev → main` merged sau khi all Phase 0-8 pass.
- [ ] Vercel auto-deploy triggers; production URL active.
- [ ] Manual smoke test trên 3 devices: iPhone 12 Safari, MacBook M1 Chrome, Galaxy S22 Chrome.
- [ ] Bench `?bench=1` accessible từ production URL.
- [ ] `bench/baseline.json` updated với production-build numbers (build optimization có thể khác dev).
- [ ] README.md có live URL + screenshot.

### 19.5 Domain & analytics (optional)

- Suggest custom domain `modernwars2.app` hoặc `mw2.{justin}.dev`.
- Vercel Analytics enable → free tier traffic insights.
- No PII collected (spectator game). No cookies.
- Tinybird/PostHog optional cho Section 14.4 telemetry sink (post-MVP).

---

## 20. Visual Style contract (Option A — Terminal/Sci-fi)

**Reference aesthetic**: Defcon (Introversion 2006), Bloomberg Terminal, Watch Dogs / Mr. Robot HUD, retro CRT war room.

### 20.1 Color palette

```ts
// src/style/palette.ts — Pin exact hex; design system token source
export const palette = {
  // Backgrounds
  bgVoid: '#000814',          // page background, deepest
  bgPanel: '#001220',         // HUD panel background
  bgPanelHover: '#001a2e',
  oceanFill: '#001a2e',       // map ocean (slightly lighter than bg)

  // Accents (4-color faction palette anchors)
  cyan: '#00e5ff',            // primary accent — links, focus, capture flash
  cyanDim: '#0088aa',         // muted variant
  magenta: '#ff00aa',         // secondary — battle highlight pulse
  amber: '#ffb800',           // tertiary — warnings, capital cities
  emerald: '#00ff88',         // success — winner banner

  // Text
  textPrimary: '#e0f7ff',     // body text, slight cyan tint
  textMuted: '#7a9eb8',       // secondary text
  textDim: '#3d5a73',         // labels, axis

  // Country fill base (4-color theorem palette — designed cho color-blind safe)
  // Welsh-Powell greedy assigns one of these to each country (Section 4.3 step 8)
  faction: ['#0088aa', '#aa0066', '#aa6600', '#006644'],

  // Effects
  scanlineAlpha: 0.04,        // subtle horizontal scanline overlay
  glowSpread: '0 0 12px',
};
```

### 20.2 Typography

- **Display / HUD**: `JetBrains Mono` (web font, lazy-loaded; system fallback `'SF Mono', 'Menlo', monospace`).
- **Body / labels**: cùng JetBrains Mono — toàn UI mono cho terminal vibe.
- **Sizes**: HUD 12-14px, leaderboard 11-13px, country labels 10-12px (zoom-dependent).
- **Letter spacing**: HUD `0.02em`, labels `0.05em` (uppercase).

### 20.3 Effects

- **Scanline overlay**: full-screen `<div>` với `repeating-linear-gradient` 2px scanlines @ alpha 0.04. Toggleable trong Settings (default ON).
- **Glow on accent**: cyan elements (FPS counter, capture flash, capital markers) có CSS `filter: drop-shadow(0 0 6px #00e5ff)` hoặc Pixi `BlurFilter` cho canvas elements.
- **CRT warp (optional, default OFF)**: subtle `transform: scale(1.005)` + radial vignette via overlay. `prefers-reduced-motion: reduce` → disable.
- **Capture flash**: 200ms cyan glow burst on captured country fill (Pixi tween).
- **Battle highlight pulse**: shader uniform `uPulseTime` Section 5.3 — 6Hz sin pulse alpha trên battle border segment, magenta tint cho sea-invasion (dashed) vs cyan cho land battle.

### 20.4 HUD layout (mobile-first)

```
┌─────────────────────────────────┐
│  TOP BAR (44px, fixed)          │
│  [PAUSE] [1×|2×|4×|8×|16×|32×|64×]  [tick]  │
├─────────────────────────────────┤
│                                 │
│       MAP CANVAS                │
│       (Pixi viewport)           │
│                                 │
├─────────────────────────────────┤
│  LEADERBOARD (collapsible       │
│  drawer, swipe-up on mobile)    │
│  Top-12 sides + battle count    │
└─────────────────────────────────┘
```

- Top bar: blur backdrop (`backdrop-filter: blur(8px)`).
- Bottom drawer: collapsed = 64px peek, expanded = 50% viewport height.
- Settings gear: top-right, modal slide-in from right.
- Bench panel (Section 8.1): top-left textarea, always visible khi `?bench=1`.

### 20.5 Audio aesthetic (Section 5)

- **Ambient drone**: Tone.js synth (sub-bass + filtered noise) cho map idle.
- **Capture chime**: short 220Hz → 440Hz pitch sweep (200ms), low pass filter sweep.
- **Win fanfare**: 4-note arpeggio C-E-G-C (cyan side wins) hoặc minor (magenta loses).
- **Battle hit**: subtle white noise burst, low volume (rate-limited Section 13.5).

### 20.6 Implementation phase

Visual style locked vào **Phase 0** (palette + typography setup) + **Phase 4** (HUD layout) + **Phase 5** (effects + audio). No new phase needed.

---

**Ready cho Claude Code khi:** ✅ All Open Questions answered (Section 11 + 18 + 20) → spec finalized 2026-04-25 → Claude Code đọc + execute Phase 0..8 → Phase 9 deploy theo Section 19.
