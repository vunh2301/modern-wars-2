# Modern Wars — Hex Map Renderer SPEC

> **v1.0** — Phase 1 only: render hex grid world map với pinch-zoom. **Không có gameplay.**
>
> Scope cực hẹp đã được lock với Justin sau ~10 vòng iteration design lệch hướng.

---

## 1. Mục tiêu duy nhất

**Vẽ map thế giới bằng hex grid lên iPhone 13 Pro Max ở 60 FPS với pinch-zoom mượt, 100% quốc gia hiện diện.**

### IN SCOPE (chỉ làm những việc này)

- Render hex grid full world (~150M hexes logic, render trong viewport).
- Pinch zoom (1× → 32×) + pan.
- LOD switch hex display size theo zoom.
- Mỗi hex tô màu theo intrinsic country owner (HSL deterministic).
- Tier offline bake → browser cache aggressive.
- 100% quốc gia (kể cả Vatican) hiện diện ít nhất ở zoom level cao nhất.
- 60 FPS p95 trên iPhone 13 Pro Max.

### OUT OF SCOPE (CẤM làm)

- ❌ Combat / battles / damage
- ❌ Corps / quân đoàn
- ❌ Cities / control zones
- ❌ AI / decision logic
- ❌ Game modes (chaos / bloc / diplomatic)
- ❌ Leaderboard / UI / HUD
- ❌ Diplomacy / relations
- ❌ Speed controls (1×/2×/4×…)
- ❌ Win condition
- ❌ Tick scheduler / sim loop
- ❌ Sound / Tone.js
- ❌ ANY gameplay logic

Nếu Claude Code có ý định viết bất kỳ thứ gì trong "OUT OF SCOPE" → **dừng ngay**, hỏi lại Justin.

### Acceptance criteria

- Boot → map hiện < 1500 ms (lần load đầu, network 4G); < 300 ms (cached).
- Pinch zoom từ 1× → 32× không drop frame quá 3 lần liên tiếp.
- Zoom 1×: full world fit màn hình, 100% mainland countries hiện diện rõ.
- Zoom 16× tới Italy: Vatican hiển thị ít nhất 1 hex màu riêng.
- Pan/zoom inertia smooth (60 FPS p95).
- Memory peak < 250 MB (JS heap).

---

## 2. Tech stack — quyết định cứng

| Layer | Tech | Lý do |
|---|---|---|
| Build | **Vite ≥7** + **TypeScript ≥5.4** | HMR fast, type safety |
| Renderer | **Pixi.js 8.6.6** (vanilla, exact patch pin) | WebGL2 sprite batching, ParticleContainer |
| State | **Zustand 4** | Minimal, no Map/Set trong store |
| Map data | **Natural Earth 50m + 10m admin0** | Country polygons, free, accurate enough |
| Viewport | **pixi-viewport 6** | Pinch/pan/zoom mobile-friendly |
| Culling | **Pixi `CullerPlugin`** | Cull off-screen hexes |
| Spatial index | **`rbush` v4** (build-time only) | Hex ↔ country lookup offline |
| Hex math | **`honeycomb-grid` v4** | Flat-top axial coord, neighbor calc |
| Cache | **Service Worker** + **Cache-Control immutable** | Lần 2+ instant load |
| Storage | **IndexedDB** (binary cache) | Skip parse step lần 2 |
| Compression | **Brotli** (build-time) | Static asset gzip không đủ |

**Cấm dùng**: Math.random (deterministic seed required), Map/Set trong Zustand, runtime GeoJSON parse.

---

## 3. Architecture — 3 layer

```
┌──────────────────────────────────────────────┐
│ VIEWPORT LAYER (pixi-viewport)                │
│   - Pinch zoom, pan, drag, momentum           │
│   - Emits: zoom level, viewport bbox          │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│ RENDER LAYER (Pixi.js v8)                     │
│   - LOD tier picker (zoom → tier)             │
│   - Visible hex query (rbush spatial)         │
│   - ParticleContainer batch render            │
│   - Color from country intrinsic owner        │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│ DATA LAYER (offline bake + IndexedDB cache)   │
│   - Tier files: 50km/25km/10km/5km/2km/1km    │
│   - Lazy load tier khi zoom tới               │
│   - Binary format Uint16Array (countryId)     │
│   - Service Worker pre-cache                  │
└───────────────────────────────────────────────┘
```

**Quy tắc cứng:**

- Data layer immutable sau khi bake offline. Runtime KHÔNG modify hex assignment.
- Render layer pure function: `(viewport, zoom, tier) → visible hexes`.
- Viewport layer là source of truth về camera state.

---

## 4. Data pipeline (offline bake)

### 4.1 Input

- Natural Earth `ne_50m_admin_0_countries.geojson` (cho tier 50km/25km).
- Natural Earth `ne_10m_admin_0_countries.geojson` (cho tier 10km/5km/2km/1km).

### 4.2 Bake script (Node.js, run once at build time)

```ts
// scripts/bake-hex-tiers.ts
const TIERS = [
  { name: '50km', sizeKm: 50, source: 'ne_50m' },
  { name: '25km', sizeKm: 25, source: 'ne_50m' },
  { name: '10km', sizeKm: 10, source: 'ne_10m' },
  { name: '5km',  sizeKm: 5,  source: 'ne_10m' },
  { name: '2km',  sizeKm: 2,  source: 'ne_10m' },
  { name: '1km',  sizeKm: 1,  source: 'ne_10m' },
];

for (const tier of TIERS) {
  // 1. Generate hex grid trên Mercator-projected world bbox
  // 2. For each hex: compute centroid (lng, lat)
  // 3. Point-in-polygon: tag hex với country code (using rbush spatial index)
  // 4. Post-process: ensure 100% countries có ≥ 1 hex
  //    - For each country in admin0 list:
  //      if (count === 0): force-assign hex closest to country.centroid
  //      override neighbor hex's countryCode
  // 5. Output binary: Uint16Array of countryId per hex (row-major)
  // 6. Brotli compress → public/data/tiles/{tier}.bin.br
}
```

### 4.3 Output files

```
public/data/
├── countries.json          # ID → ISO_A2 + name + nameVi (5 KB)
├── tiles/
│   ├── world-50km.bin.br   # ~80 KB compressed (~6,000 hexes land)
│   ├── world-25km.bin.br   # ~280 KB (~24,000 hexes)
│   ├── world-10km.bin.br   # ~1.5 MB (~150,000 hexes)
│   ├── world-5km.bin.br    # ~5 MB (~600,000 hexes)
│   ├── world-2km.bin.br    # ~25 MB (~3.7M hexes)  ← lazy
│   └── world-1km.bin.br    # ~80 MB (~15M hexes)   ← lazy
└── manifest.json           # tier filenames + content hashes
```

**Initial load** (zoom 1×): chỉ `world-50km.bin.br` (~80 KB). Boot time ngắn.

**Lazy load**: tier nhỏ hơn fetch khi user zoom tới level đó. Cache aggressively.

### 4.4 Force-assignment cho mini-states

Sau khi bake xong tier 25km, trong tổng ~195 quốc gia có thể có ~5-10 nước có 0 hex (Vatican, Monaco, Nauru, Tuvalu, San Marino, Liechtenstein…).

Pseudocode:

```
for country in ALL_COUNTRIES:
  if hexCountByCountry[country] === 0:
    // Find hex closest to country centroid
    closestHex = findNearestHex(country.centroid, allHexes)
    closestHex.countryCode = country.code  // override (steal from neighbor)
    log: "Force-assigned ${country.code} to hex at ${closestHex.coord}"
```

→ **100% quốc gia có ≥ 1 hex từ tier 25km trở xuống**.

Trade-off chấp nhận: Vatican "ăn" 1 hex 25km của Italy ở Rome area. Visually slight inaccurate but ensures presence.

---

## 5. Hex grid math

### 5.1 Projection: Mercator

```ts
function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = lng * Math.PI / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  return [x, y]; // in radians
}

function mercatorToLngLat(x: number, y: number): [number, number] {
  const lng = x * 180 / Math.PI;
  const lat = (Math.atan(Math.exp(y)) - Math.PI / 4) * 360 / Math.PI;
  return [lng, lat];
}
```

**Clamp lat ±85°** (Mercator vô hạn ở cực).

### 5.2 Hex orientation: Flat-top

```
   ___
  /   \
 /     \
 \     /
  \___/
```

Axial coordinates `(q, r)`. Six neighbors:

```ts
const NEIGHBORS = [
  [+1,  0], [+1, -1], [ 0, -1],
  [-1,  0], [-1, +1], [ 0, +1],
];
```

### 5.3 Hex → pixel (flat-top)

```ts
const HEX_WIDTH = 2 * size;           // size = hex inradius
const HEX_HEIGHT = Math.sqrt(3) * size;
const HORIZ_SPACING = 1.5 * size;
const VERT_SPACING = HEX_HEIGHT;

function hexToPixel(q: number, r: number, size: number): [number, number] {
  const x = size * 1.5 * q;
  const y = size * Math.sqrt(3) * (r + q / 2);
  return [x, y];
}
```

Library `honeycomb-grid` v4 wraps this đầy đủ. Em không tự implement.

---

## 6. LOD tiers — zoom → tier mapping

| Zoom | Tier file | Hex display size px | Visible hexes ước tính | Use case |
|---:|---|---:|---:|---|
| 1.0× – 1.9× | `world-50km` | 8 px | ~3,000 | Full world |
| 2.0× – 3.9× | `world-25km` | 8 px | ~6,000 | Continent |
| 4.0× – 7.9× | `world-10km` | 8 px | ~10,000 | Multi-country |
| 8.0× – 15.9× | `world-5km` | 8 px | ~15,000 | Country |
| 16.0× – 31.9× | `world-2km` | 8 px | ~20,000 | Region/state |
| 32.0× ↑ | `world-1km` | 8 px | ~30,000 | City |

**Display size luôn ~8 pixel** — không phải hex thật size. LOD pick tier có hex_km tương ứng zoom level để mỗi hex luôn ~8 pixel trên màn hình.

### Hysteresis chống flickering

```ts
// Nếu đang load tier N, không switch sang tier N+1 cho đến khi:
//  - zoom vượt threshold + 0.5 (buffer)
//  - tier mới đã pre-fetch xong
const TIER_HYSTERESIS = 0.5;
```

### Pre-fetch policy

Khi user zoom 4× → render tier 10km. Background fetch tier 5km (kế tiếp) để zoom 8× sẵn sàng.

---

## 7. Caching strategy

### 7.1 HTTP cache (lớp 1)

```http
Cache-Control: public, max-age=31536000, immutable
ETag: "{content-hash}"
```

Filename pattern: `world-25km.{hash}.bin.br`. Hash đổi → URL đổi → browser fetch lại.

### 7.2 Service Worker (lớp 2)

```ts
// sw.ts
const CACHE = 'modern-wars-v1';
const PRE_CACHE = [
  '/data/countries.json',
  '/data/manifest.json',
  '/data/tiles/world-50km.bin.br',  // initial only
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRE_CACHE)));
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/data/tiles/')) {
    e.respondWith(
      caches.match(e.request).then(r => r ?? fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      }))
    );
  }
});
```

Offline-first: tile đã cache → instant. Tile mới → fetch + cache.

### 7.3 IndexedDB (lớp 3) — skip parse

```ts
// Sau khi parse Uint16Array lần đầu, lưu vào IndexedDB
async function loadTier(name: string): Promise<Uint16Array> {
  const cached = await idb.get(`tier-${name}-parsed`);
  if (cached) return cached;  // skip fetch + decompress + parse

  const resp = await fetch(`/data/tiles/world-${name}.bin.br`);
  const buf = await resp.arrayBuffer();
  const decompressed = await brotliDecompress(buf);
  const u16 = new Uint16Array(decompressed);
  await idb.set(`tier-${name}-parsed`, u16);
  return u16;
}
```

Lần 1: fetch + decompress + parse + IDB write (~200-500 ms).
Lần 2+: IDB read (~10-30 ms).

---

## 8. Render pipeline (Pixi.js v8)

### 8.1 Layer stack

```
Stage
└── Viewport (pixi-viewport)
    ├── ocean-bg      Sprite      (full screen #040d18)
    └── hex-particles ParticleContainer (CHỈ 1 layer này, tất cả hexes)
```

Một ParticleContainer duy nhất, mỗi Particle = 1 hex sprite.

### 8.2 Texture atlas

```
hex-atlas.png:
  [solid-flat-top-hex.png]   ← 16×16 px white silhouette
```

Mỗi hex = 1 Sprite tint = country owner color (HSL).

### 8.3 Visible hex query

```ts
// Mỗi frame: get visible hexes trong viewport bbox
function updateVisibleHexes(viewport: Viewport, tier: TierData) {
  const bbox = viewport.getVisibleBounds();
  const hexes = tier.spatialIndex.search(bbox); // rbush query
  // Reuse Particle pool, update position + tint
  for (const hex of hexes) {
    const particle = particlePool.acquire();
    particle.position.set(hex.x, hex.y);
    particle.tint = countryColors[hex.countryId];
  }
  // Release unused particles back to pool
}
```

### 8.4 Color generation (deterministic HSL từ ISO)

```ts
function isoToColor(iso: string): number {
  // Hash 2 chars → hue 0-360
  const hash = iso.charCodeAt(0) * 137 + iso.charCodeAt(1) * 23;
  const hue = hash % 360;
  return hslToHex(hue, 60, 50);
}
```

Cache `countryColors[countryId]` lookup table (Uint32Array, 256 entries).

---

## 9. Performance targets — iPhone 13 Pro Max

### 9.1 Hard targets (acceptance gate)

- **Boot to playable**: < 1500 ms (cold), < 300 ms (cached).
- **FPS p50 idle**: 60 fps.
- **FPS p95 zoom/pan**: ≥ 55 fps.
- **Frame time p99**: < 25 ms (no spike > 33ms).
- **Memory peak**: < 250 MB.
- **Initial JS bundle**: < 350 KB gzipped.

### 9.2 Sub-budgets per frame (16.6 ms at 60 FPS)

| Stage | Budget |
|---|---:|
| Viewport input handling | < 1 ms |
| Spatial query (rbush) | < 2 ms |
| Particle update (position + tint) | < 4 ms |
| Pixi render | < 8 ms |
| Margin | < 1.6 ms |

### 9.3 Profiling tools

- Chrome DevTools Performance tab (desktop dev).
- Safari Web Inspector (real iPhone test).
- `stats.js` HUD overlay (FPS / frame time histogram).
- Built-in benchmark mode `?bench=auto` (3 scenarios).

---

## 10. Benchmark protocol

### 10.1 3 scenarios

```
Scenario A: Idle full world
  - Load page, zoom 1×, wait 30s
  - Measure FPS p50, p95, p99

Scenario B: Pinch zoom storm
  - Load page, zoom 1× → 32× → 1× cycle 5 lần (total 60s)
  - Measure FPS p95, frame drop count

Scenario C: Pan around world
  - Load page, zoom 4×, pan toàn world (60s programmatic)
  - Measure FPS p95, tier switch latency
```

### 10.2 Pass criteria

| Scenario | FPS p95 |
|---|---:|
| A | ≥ 58 |
| B | ≥ 55 |
| C | ≥ 56 |

Run on iPhone 13 Pro Max Safari. Result JSON output to console.

---

## 11. Implementation phases

### Phase 0: Bootstrap (1h)

- Vite + TS + Pixi.js v8 project setup.
- iPhone Safari config (viewport meta, no scaling).
- Empty Pixi canvas full-screen.

### Phase 1: Bake script (3h)

- `scripts/bake-hex-tiers.ts` Node.js.
- Generate 6 tier files in `public/data/tiles/`.
- Include force-assignment logic.
- Validate: 100% countries có ≥ 1 hex từ tier 25km trở đi.

### Phase 2: Data loader (2h)

- `src/data/tiers.ts` — load + parse + IndexedDB cache.
- `src/data/manifest.ts` — content-hash filename resolution.
- Service Worker pre-cache.

### Phase 3: Render pipeline (3h)

- `src/render/stage.ts` — Pixi.Application setup.
- `src/render/viewport.ts` — pixi-viewport setup, zoom 1-32.
- `src/render/hexLayer.ts` — ParticleContainer + visible query.
- Tier picker.

### Phase 4: LOD + lazy load (2h)

- Zoom level → tier mapping.
- Hysteresis logic.
- Pre-fetch next tier on background.
- Loading spinner khi tier mới fetch.

### Phase 5: Polish + benchmark (2h)

- Stats.js HUD.
- Benchmark mode `?bench=auto`.
- Tune particle pool size.
- Verify Vatican hiển thị ở zoom 16×.

**Total estimate: ~13h Claude Code work.**

---

## 12. File structure

```
modern-wars-3/
├── public/
│   ├── data/
│   │   ├── countries.json              # 5 KB
│   │   ├── manifest.json               # tier filenames + hashes
│   │   └── tiles/
│   │       ├── world-50km.{hash}.bin.br
│   │       ├── world-25km.{hash}.bin.br
│   │       ├── world-10km.{hash}.bin.br
│   │       ├── world-5km.{hash}.bin.br
│   │       ├── world-2km.{hash}.bin.br
│   │       └── world-1km.{hash}.bin.br
│   └── sw.js                           # Service Worker
│
├── scripts/
│   └── bake-hex-tiers.ts              # Offline data prep
│
├── src/
│   ├── main.ts                        # Bootstrap
│   ├── data/
│   │   ├── tiers.ts                   # Tier load + IDB cache
│   │   ├── manifest.ts                # Manifest resolver
│   │   └── countries.ts               # ID → ISO + nameVi
│   │
│   ├── geo/
│   │   ├── projection.ts              # Mercator helpers
│   │   └── hex.ts                     # Honeycomb wrapper
│   │
│   ├── render/
│   │   ├── stage.ts                   # Pixi.Application
│   │   ├── viewport.ts                # pixi-viewport
│   │   ├── hexLayer.ts                # ParticleContainer renderer
│   │   ├── lod.ts                     # Zoom → tier picker
│   │   └── colors.ts                  # ISO → HSL deterministic
│   │
│   ├── benchmark/
│   │   ├── runner.ts                  # ?bench=auto
│   │   └── scenarios.ts               # 3 scenarios
│   │
│   └── types.ts                       # TS types
│
├── tests/
│   └── bake.test.ts                   # Validate 100% country coverage
│
├── package.json
├── vite.config.ts
└── tsconfig.json
```

**Total ~15 files.** Không nhiều hơn. Nếu Claude Code muốn thêm file → hỏi trước.

---

## 13. Reviewer checklist

Trước khi Justin merge:

- [ ] `pnpm bake` chạy thành công, 6 tier files tạo trong `public/data/tiles/`.
- [ ] Test `tests/bake.test.ts` pass: mọi quốc gia trong admin0 list có ≥ 1 hex (assertion).
- [ ] Manifest.json chứa content hashes đúng.
- [ ] Service Worker active sau lần load đầu (DevTools → Application).
- [ ] iPhone 13 Pro Max test: zoom 1×, FPS ≥ 58 sau 30s.
- [ ] Pinch zoom 1× → 32× không crash, không freeze.
- [ ] Vatican hiện diện ở zoom 16× (color hex riêng tại Roma).
- [ ] Memory peak < 250 MB sau 60s pan/zoom.
- [ ] Lần 2 reload: boot < 300 ms (Service Worker hit).
- [ ] Initial JS bundle < 350 KB gzip.
- [ ] **KHÔNG có file nào** liên quan tới: combat, corps, cities, AI, leaderboard, battles, diplomacy, gameplay.

---

## 14. Open questions (review trước Phase 0)

1. Domain deploy: vẫn `modern-wars-2.vercel.app` hay tạo mới `modern-wars-3.vercel.app`?
2. Repo: tạo mới (recommended) hay overwrite repo cũ?
3. iPhone test: Justin có iPhone 13 Pro Max thật để test không, hay chỉ Safari iOS Simulator?
4. Country names tiếng Việt: dùng list 194 nước cũ Justin đã có, hay extract lại từ Natural Earth?
5. Initial zoom level: 1× (full world fit) hay 1.5× (zoom in slight)?
6. Bake script timing: chạy 1 lần khi setup repo, hay chạy lại khi update Natural Earth (annual)?
7. Pre-bake host: bake xong commit luôn vào repo `public/data/`, hay CI bake on deploy?

Em recommend default: 2 (new repo), 4 (extract lại), 5 (1×), 6 (chạy 1 lần), 7 (commit vào repo).

---

## 15. NEGATIVE list — không được làm

Lặp lại để cực kỳ rõ. Claude Code khi đọc SPEC này KHÔNG được:

- ❌ Implement bất kỳ combat logic nào (damage, attack, defend).
- ❌ Tạo entity Corps, Army, Unit, Soldier, Troop.
- ❌ Tạo concept City, Province, Region (ngoài việc hex grid).
- ❌ AI logic, decision tree, target picking.
- ❌ Faction grouping, alliance, bloc.
- ❌ Win/loss condition.
- ❌ Tick scheduler, sim loop, game time.
- ❌ Audio (Tone.js).
- ❌ Speed controls (1×/2×/4×…).
- ❌ Battle visual (red pulse rings, sword icons).
- ❌ Capture animation.
- ❌ Movement arrows.
- ❌ HUD elements (leaderboard, stats panel) — TRỪ FPS counter và tier indicator để debug.
- ❌ Country labels — TRỪ khi zoom level > 8 (optional, tách phase sau).
- ❌ Map mode toggle (political / terrain / etc).

Nếu nghi ngờ một feature thuộc IN/OUT scope → mặc định OUT, hỏi Justin.

---

## 16. Definition of Done

Phase này coi như **xong** khi:

1. Live URL load được trên iPhone 13 Pro Max Safari.
2. Map thế giới hiện diện đầy đủ với 195+ quốc gia tô màu khác nhau.
3. Pinch zoom 1× → 32× mượt, không drop frame quá 3 frames liên tiếp.
4. Vatican thấy được ở zoom 16×.
5. Reload trang lần 2 boot < 300 ms (cached).
6. Benchmark `?bench=auto` pass cả 3 scenarios.
7. Reviewer checklist (Section 13) tích đủ 12/12.

Sau khi DONE, Justin sẽ quyết định Phase 2 (gameplay) khởi động hay chưa.

---

**END OF SPEC v1.0**

> Yêu cầu duy nhất: vẽ map đẹp + chạy mượt. Không gameplay.
