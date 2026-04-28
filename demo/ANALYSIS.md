# Hex Terrain V2 — Analysis & Integration Plan

Demo HTML standalone (Canvas2D) làm reference cho hex terrain generation.
Mục tiêu: phân tích thành phần → port từng phần sang Pixi engine sandbox → build debug UI panel thay URL params.

---

## 1. Tổng quan kiến trúc demo

```
INPUT: seed + 5 sliders (waterLevel, mountainLevel, elevScale, moistScale, moistureBias)
   │
   ▼
GENERATION (per hex):
   ├─ elevation = fbmNoise(6 octaves) * 0.7 + radialFalloff^2.4 * 0.3, ^0.85
   ├─ moisture  = fbmNoise(4 octaves) + moistureBias
   ├─ temperature = (1 - latitude) * 0.85 + fbm(3 octaves) * 0.15 - elev penalty
   └─ biome     = classifyBiome(elev, moist, temp)  → 8 biomes
   │
   ▼
RENDER (5-pass):
   ├─ Pass 1: drawBaseTerrain     — biome color OR variant (local + macro + elev shade)
   ├─ Pass 2: drawBiomeTransitions — edge band 30% width tinted theo cặp biome
   ├─ Pass 3: drawTerrainDetails   — per-biome procedural (LOD 1+ for mountain, 2+ others)
   ├─ Pass 4: drawHexOutline       — debug grid (game: opacity 0.04, debug: 0.50)
   └─ Pass 5: hover highlight + axial text overlay
```

---

## 2. Generation components (chi tiết)

### A. Elevation field

```js
elevation = fbmNoise(seed, q*scale, r*scale, 6 octaves, persistence=0.5, lacunarity=2.0)
elevation = elevation * 0.7 + radialFalloff * 0.3  // radial bias
elevation = elevation^0.85  // contrast bump
```

**Key insights:**
- 6-octave fbm → smooth nhưng có detail (vs sandbox hiện chỉ 3 octave)
- `persistence=0.5` chuẩn (mỗi octave đóng góp 50% trước)
- `lacunarity=2.0` chuẩn (mỗi octave 2× freq)
- `radialFalloff = (1 - dist²·⁴)` → push edges toward ocean nhẹ nhàng (power 2.4 = soft falloff)
- Bias 70/30 noise/falloff (sandbox hiện 38/20/42 — quá radial-heavy)
- `^0.85` exponent → push values toward higher (more land if base random in 0..1)

**Sandbox hiện tại:** `landScore = lowFreq * 0.38 + medFreq * 0.20 + radial * 0.42`. Vấn đề: radial weight 0.42 + noise weight 0.58 = đối đầu nhau ở threshold zone → speckle. Demo dùng 70/30 với power curve = elegant.

### B. Moisture field

```js
moisture = fbmNoise(seed+9999, q*moistScale, r*moistScale, 4 octaves)
moisture += moistureBias  // user bias [-0.4, +0.4]
moisture = clamp(moisture, 0, 1)
```

- Independent noise (different seed offset 9999)
- Lower octave count (4 vs 6) → less detail, smoother regions
- User-controlled bias slider → easy tune wet/dry world

**Sandbox hiện tại:** moisture noise + proximity-to-water + elevation penalty. Demo SIMPLER — không dùng proximity, chỉ noise + bias. Trade-off: proximity bias forest về coast hợp lý hơn nhưng có thể skip cho v1.

### C. Temperature field (NEW so với sandbox)

```js
const lat = abs((r - MAP_H/2) / (MAP_H/2))
temperature = (1 - lat) * 0.85       // equator hot, poles cold
            + fbm(...) * 0.15        // some noise variation
            - max(0, elev - waterLvl) * 0.4  // mountains cold
```

- **Latitude-based** (rows gần equator = hot, rows ở pole = cold)
- Small fbm overlay (15%) cho variation
- Elevation penalty — núi cao = lạnh

**Use case:** desert classification cần `moist < 0.38 && temp > 0.50` — temperature ngăn không cho desert ở pole.

### D. Biome classification (8 biomes)

```js
function classifyBiome(elev, moist, temp) {
  if (elev < waterLevel)            return 'ocean';
  if (elev < waterLevel + 0.04)     return 'coast';      // ← elev band, NOT neighbor!
  if (elev > mountainLevel)         return 'mountain';
  if (elev > mountainLevel - 0.10)  return 'hill';       // ← elev band
  if (moist < 0.38 && temp > 0.50)  return 'desert';
  if (moist > 0.68 && elev < waterLevel + 0.20) return 'swamp';
  if (moist > 0.55)                 return 'forest';
  return 'plain';
}
```

**Ưu điểm vs sandbox hiện tại:**
1. **Coast** = elevation band 0.04 trên water level → 100% deterministic, không cần neighbor BFS
2. **Hill** = elevation band 0.10 dưới mountain level → tự động transition smooth
3. **Mountain** = pure elevation threshold, không cần ridge field — đơn giản hơn nhưng không có chains
4. **Swamp** = moist + low elev → near-coast wetland (concept hay)
5. **Order matters** — water/mountain/hill check trước moisture-based

**Mất so với sandbox:**
- Không có ridge field → mountains không thành dãy tự nhiên
- Không có proximity-to-water cho moisture
- Không smoothing pass → speckle có thể xuất hiện ở threshold zones

---

## 3. Visual rendering — multi-layer

### Layer 1: Base / Variant fill

```js
// Base: solid color
getBiomeBaseColor(biome) → '#9bc66a' (e.g.)

// Variant: base + per-hex local + macro region + elev shade
local     = (random(q,r,seed) - 0.5) * 2 * BIOME_LOCAL[biome]   // ±6..14
macro     = (fbm(q*0.012, r*0.012) - 0.5) * 2 * BIOME_MACRO[biome] // ±8..22
elevShade = (elev - threshold) * factor  // per-biome
final     = adjustColor(base, local + macro + elevShade)
```

**Insights:**
- **Per-hex local**: hash(q,r) cho subtle tile-to-tile variation
- **Macro variation**: noise scale 0.012 = ~80 hex per feature → vùng sáng/tối lớn xuyên qua nhiều hex (tạo "patches" effect)
- **Elev shading**: mỗi biome có hệ số riêng — mountain/ocean cường độ cao nhất (110/70), plain nhẹ (15)

**Adapt sandbox shader:** Sandbox đang dùng vertex-output `vSeed` cho per-cell jitter (đã ổn). Add 2 macro noise samples trong fragment để có macro patch effect.

### Layer 2: Biome transitions (edge bands)

```js
// Per pair (myBiome, neighborBiome): { color, alpha, width }
'plain|forest':  { color: 'rgb(40, 80, 45)', alpha: 0.50, width: 0.28 }
                                                          ^^^^^ inset 28% từ edge

drawEdgeBand:
  vẽ trapezoid từ outer edge (cạnh shared với neighbor) vào trong widthRatio·R
  fill với color + alpha
```

**Concept:** Mỗi cạnh hex có dải mờ tinted theo cặp biome. Forest cạnh Plain → dải xanh đậm 28% inset. 20+ pair definitions cho realistic transitions.

**Sandbox port challenge:** Pixi instanced mesh không native support per-edge attribute. Options:
1. Add attribute aBiomeNeighbors (uint8x6 = 6 neighbor biome IDs) → fragment computes per-pixel which edge it's near + tints
2. Separate Graphics overlay per chunk (như borders Phase 6) — cheap but expensive at scale
3. Skip transitions, rely on macro variation only

Recommend (1) — chi phí thêm 6 bytes/instance (8→14 bytes meta), fragment branching nhẹ.

### Layer 3: Procedural details (per biome)

| Biome | Detail | LOD trigger |
|---|---|---|
| Mountain | Ridge stroke (angle field) + peak triangle on local max + snow cap | LOD 1+ |
| Forest | 2-7 trees per hex (density = local + macro), highlight | LOD 2 |
| Hill | 2-3 small brown rocks | LOD 2 |
| Plain | 2-4 grass strokes | LOD 2 |
| Desert | 2 sand wave curves | LOD 2 |
| Swamp | 4 dark dots + occasional water pool | LOD 2 |
| Coast | 2 wave curves | LOD 2 |
| Ocean | Sparse wave curve (~40% tiles) | LOD 2 |

**Mountain ridge stroke** đặc biệt thú vị:
```js
angleN = fbm(q*0.05, r*0.05)  // slowly-varying angle field
angle = angleN * π - π/4       // bias NW-SE
// Vẽ stroke có angle ≈ neighbors → mountain visually liền nhau cùng hướng
```

→ **Dù không có ridge field trong generation**, visual ridge stroke với angle field tạo cảm giác chains.

### Layer 4: Hex outlines (game vs debug)

- Game mode: opacity 0.04 (gần invisible) hoặc tắt hoàn toàn
- Debug mode: opacity 0.50 + viền đậm
- Hover hex: yellow outline

**Chiến lược cho sandbox:** Add `uShowGrid: f32` uniform trong fragment. Khi enabled, dist-from-edge < threshold → tint border color. Hoặc Pixi Graphics overlay vẽ borders như production (Phase 6 pattern).

---

## 4. UI structure

### Layout
- **Topbar (fixed top)**: hamburger menu + Game/Debug view toggle + title
- **Controls panel (left)**: collapsible
  - Seed input + Regenerate + Random
  - Presets (Balanced, Dry, Wet)
  - 5 terrain sliders
  - Visual layer toggles
  - Game grid options
  - Debug overlays
  - Camera controls
  - Export JSON
- **Legend (right)**: biome color swatches
- **Info (bottom-left)**: hex info on hover (q/r, elev/moist/temp/biome)
- **LOD indicator (bottom-right)**: zoom + LOD tier

### Tech stack
- Vanilla JS, no framework
- CSS panels với backdrop-filter blur
- `transform: translateX()` cho slide-in/out
- Mobile responsive (<720px: panels full-width, larger touch targets)
- Touch + mouse + keyboard inputs

---

## 5. Integration plan — port sang sandbox

### Phase A — Generation (data layer, sandboxData.ts)

| Component | Demo | Sandbox hiện tại | Action |
|---|---|---|---|
| Elevation | fbm 6 oct + radial + ^0.85 | fbm 3 oct + radial 42% | **Adopt demo formula** — elegant + smooth |
| Moisture | fbm 4 oct + bias slider | fbm + proximity + elev | Keep proximity (better forest near coast) + add bias slider |
| Temperature | latitude + noise + elev penalty | NONE | **Add new field** — needed cho desert class |
| Coast | elev band 0.04 above water | BFS neighbor-of-ocean | **Switch to elev band** — simpler + deterministic |
| Hill | elev band 0.10 below mountain | NONE | **Add Hill biome** — smooth mountain↔plain transition |
| Mountain | pure elev > threshold | ridge field (chains) | Keep ridge for chains, OR demo's simpler if chains visual via ridge stroke |
| Swamp | moist > 0.68 + low elev | NONE | **Add Swamp biome** — wetland near coast |
| Smoothing | NONE | 4 passes neighbor-majority + ocean-fill | Keep sandbox's smoothing — kills speckle that demo will have |

**8 biomes total** (vs sandbox 7): Ocean, Coast, Plain, Forest, Hill, Mountain, Desert, Swamp, Urban. Drop Urban-as-base, treat Urban as overlay later.

### Phase B — Rendering (shader, sandboxShader.ts)

| Layer | Demo (Canvas2D) | Sandbox (WebGL/WGSL) | Port strategy |
|---|---|---|---|
| Base color | `getBiomeBaseColor(biome)` → solid | `aInstanceColor` from CPU | Same — already done |
| Variant | local hash + macro fbm + elev shade | Just per-cell vSeed jitter | **Add fragment macro fbm sample** + elev shade per biome |
| Transitions | Edge band 30% inset | NONE | **Add aBiomeNeighbors uint8x6 attribute** + fragment computes per-pixel tint |
| Mountain ridge | Stroke với angle field | NONE | **Add fragment ridge stroke** dùng vSeed + angle field noise |
| Forest density | macro fbm + tree count | NONE (just dark green tint) | Add fragment leafy noise + density vary |
| Hex outline | Canvas stroke | Pixi Graphics overlay (production pattern) | Add `uShowGrid: f32` uniform fragment dist-to-edge |

### Phase C — Debug UI panel

Replace URL params `?seed=N&worker=on` với floating panel:

**Tech choice:**
- Vanilla TS (no framework) — match production style
- Plain DOM elements styled với CSS module hoặc inline `<style>`
- Mount: append to `document.body` không touch Pixi canvas
- Position: `position: fixed; top: 8px; right: 8px;`
- Mobile: collapse-to-icon (hamburger)

**Components phase 1 (sandbox-only):**
1. Seed input + Regenerate
2. 5 terrain sliders (waterLevel, mountainLevel, elevScale, moistScale, moistureBias)
3. Visual toggles (variation, transitions, details, gridOverlay)
4. View mode (Game / Debug)
5. Hex info on hover
6. Camera controls (zoom buttons + fit map)

**Components phase 2 (production, sau merge):**
- Engine selector (mesh / particles)
- Worker mode (on / off)
- Tier lock
- Performance HUD (FPS, chunks, memory)
- Bench trigger

**File location:**
- `src/sandbox/sandboxDebugPanel.ts` (sandbox first)
- Sau khi stable → port to `src/render/debugPanel.ts` cho production

---

## 6. Test components individually

Roadmap để chạy thử từng phần demo trên sandbox engine:

### Step 1: Generation overhaul
- [ ] Port elevation formula (fbm 6 oct + radial 70/30 + ^0.85)
- [ ] Add temperature field (latitude + fbm + elev penalty)
- [ ] Switch coast to elev band (drop BFS)
- [ ] Add Hill biome (elev band)
- [ ] Add Swamp biome (moist + low elev)
- [ ] Keep sandbox's smoothing passes (demo lacks them, will speckle)
- [ ] Bench: generation time vs current

### Step 2: Variant color
- [ ] Add fragment macro fbm sample (scale 0.012)
- [ ] Add per-biome elev shading factor
- [ ] Test visual: zoom in 3-5×, check macro patches visible

### Step 3: Biome transitions
- [ ] Extend instance buffer 16→18 bytes (add aBiomeNeighbors uint8x6)
- [ ] Fragment: compute distance to each edge, tint with neighbor pair color
- [ ] CPU: pre-compute neighbor biome IDs per hex
- [ ] Test: visual smoothness at biome boundaries

### Step 4: Mountain ridges
- [ ] Add fragment ridge stroke với angle field noise
- [ ] Test at zoom 4-8× — chains visible?

### Step 5: Hex grid overlay
- [ ] Add uniform `uShowGrid: f32`
- [ ] Fragment: dist-to-edge < threshold → tint
- [ ] Toggle from debug panel

### Step 6: Debug UI panel
- [ ] Floating panel với 5 sliders + presets + view mode
- [ ] Replace URL params trong sandbox
- [ ] Mobile responsive

### Step 7: Hover info
- [ ] Pixi-side picking (axial coord from mouse pos)
- [ ] Display tile data overlay (biome, elev, moist, temp)

---

## 7. Open questions

1. **Map size sandbox**: demo 160×100, sandbox 64×64. Tăng lên 160×100 = 16k hex (vs 4k). Vẫn render OK (Pixi instanced mesh handle 100k+).
2. **Coast as elev-band vs BFS**: demo simpler, but BFS preserves "real coastline ring". Test cả 2.
3. **8 vs 7 biomes**: thêm Hill + Swamp = 9 biomes (kể Urban). Shader branch increase nhẹ.
4. **Ridge field**: keep cho mountain chains, OR drop và rely vào ridge stroke visual. Test side-by-side.
5. **Debug panel**: vanilla TS hoặc preact-htm tiny lib (~3KB)? Vanilla cho consistency với production.

---

## 8. Recommended order

**Iteration 1 — gen + base variation (1-2 commits):**
- Demo's elevation formula + temperature
- Coast as elev band
- Add Hill + Swamp
- Macro fragment noise

**Iteration 2 — UI panel (1 commit):**
- Sandbox debug panel với sliders + presets
- Replace ?seed/?rows URL params

**Iteration 3 — biome transitions (1 commit):**
- aBiomeNeighbors attribute
- Fragment edge band tint

**Iteration 4 — details (1-2 commits):**
- Mountain ridge stroke
- Forest density variation
- Hex grid overlay toggle

**Iteration 5 — picking + info (1 commit):**
- Hover hex info display

Total: ~6 commits, 1-2 days work. Each iteration testable trên Vercel preview.
