# Coordinate System Contract

> **STATUS**: LOCKED v1 — Phase 6.8 (2026-04-26)
> **Authority**: `src/geo/wrap.ts` is the single source of truth.
> **Audience**: anyone touching gameplay (Phase 7+), pathfinding, AI,
> rendering, or save/load.

This document locks the coordinate-system invariants for **Modern Wars** so
that gameplay logic (combat, movement, AI, pathfinding) survives horizontal
world wrap without per-feature re-invention.

---

## 1. The world is a cylinder

Mercator projection wraps horizontally — longitude +180° ≡ −180°. Latitude
is clamped at ±85°, never wraps. Hex grid follows: q-axis wraps, r-axis
does not.

```
                       ┌────── world (Mercator) ──────┐
                       │                              │
            +85°N      ████████████████████████████████      Greenland
                       ████████████████████████████████
                       ████████████████████████████████
            +20°N      ████████████████████████████████      Vietnam | Mexico
                       ████████████████████████████████
            equator    ████████████████████████████████      Brazil  | Indonesia
                       ████████████████████████████████
            −20°       ████████████████████████████████      Australia
                       ████████████████████████████████
            −85°S      ████████████████████████████████      Antarctica
                       │                              │
                       └─lng −180°            lng +180°┘
                          ↑                          ↑
                          │  THESE ARE THE SAME LINE │
                          │  (antimeridian seam)     │
                          │                          │
                       Aleutians            Russia / Chukotka
                       (US, lng −175°)      (lng +175°)

Distance Aleutians → Chukotka: ~10° longitude via wrap, ~350° via direct.
A naive Euclidean / axial distance picks 350° → AI ignores Alaska as a target.
This is the bug R-4 prevents.
```

The hex grid maps onto this cylinder via flat-top axial coords `(q, r)`
where:
- `q` increments left → right around the cylinder, wraps mod `WRAP_HEX_COUNT`
- `r` increments north → south, no wrap
- Pitch: horizontal `1.5 × hexSize`, vertical `√3 × hexSize`

---

## 2. The 3 LOCKED invariants

### INVARIANT 1 — Canonical coordinates

Every hex has a **unique** `(q, r)` in canonical range:

```
Q_MIN = −halfWrap                    where halfWrap = floor(WRAP_HEX_COUNT / 2)
Q_MAX = Q_MIN + WRAP_HEX_COUNT − 1
R: unconstrained (latitude bounded by Mercator, no wrap)

WRAP_HEX_COUNT scales by tier:
  50 km tier: WRAP_HEX_COUNT_BASE          (~535 columns at default scale)
  25 km tier: 2 × base                     (~1070)
  10 km tier: 5 × base                     (~2675)
   5 km tier: 10 × base
   2 km tier: 25 × base
   1 km tier: 50 × base
```

**All gameplay state stores `(q, r)`** (and the tier name to interpret them).
NEVER store a screen position — viewport zoom/scroll changes constantly,
hex coords are stable.

### INVARIANT 2 — Normalization

Two `(q, r)` pairs may name the same hex if `q1 ≡ q2 (mod WRAP_HEX_COUNT)`,
**provided** `r` is also adjusted by `±halfWrap` per wrap step (this is the
flat-top axial geographic-continuity rule).

Implication:
- Before saving, comparing, or indexing a hex, call `normalizeHex(q, r,
  tierKm)`.
- Equality comparison: use `sameHex(aq, ar, bq, br, tierKm)`. Never `===`
  on `q` or `r` directly when wrap may apply.

### INVARIANT 3 — Shortest-path distance

Distance between two hexes on a cylinder is `min(direct_axial, wrap_axial)`.
The wrap variant accounts for the cylinder shortcut.

Implication:
- Pathfinding cost / heuristic: `wrapHexDistance(...)`.
- AI target selection: `wrapHexDistance(...)`.
- Render direction (which way an entity moves visually):
  `wrapShortestQDir(...)`.

---

## 3. Mandatory API (`src/geo/wrap.ts`)

| Function                              | Signature                                                      | Use case                                          |
|---------------------------------------|----------------------------------------------------------------|---------------------------------------------------|
| `getWrapHexCount`                     | `(tierKm) → number`                                            | Compute Q_MIN / Q_MAX                             |
| `normalizeHex`                        | `(q, r, tierKm) → [q', r']`                                    | Save / index / compare                            |
| `wrapNeighbor`                        | `(q, r, dir, tierKm) → [q', r']`                               | Step in one direction                             |
| `wrapAllNeighbors`                    | `(q, r, tierKm) → Array<[q, r]>`                               | Pathfinding successor function                    |
| `wrapHexDistance`                     | `(aq, ar, bq, br, tierKm) → number`                            | Heuristic / AI / range checks                     |
| `wrapShortestQDir`                    | `(aq, bq, tierKm) → -1 | 0 | 1`                                | Render movement direction                         |
| `sameHex`                             | `(aq, ar, bq, br, tierKm) → boolean`                           | Equality replacement for `===`                    |

**Tests**: `src/geo/wrap.test.ts` — 10 vitest cases including idempotency,
symmetry, ≤-direct-distance, seam adjacency, sameHex modulo wrap.

---

## 4. Layer model: 3 coordinate spaces

```
┌──────────────────────────────────────────────────────────────────────┐
│  GAMEPLAY (immutable):  hex (q, r) + tierKm                          │
│        │                                                              │
│        │  axialToPx(q, r, hexSizeWorldPx)         (src/geo/hex.ts)   │
│        ▼                                                              │
│  WORLD PX (rendering):  (worldX, worldY) ∈ [-W/2, +W/2] × [minY, maxY]│
│        │                                                              │
│        │  pixi-viewport projection (zoom, scroll)                    │
│        ▼                                                              │
│  SCREEN PX:             (screenX, screenY) ∈ [0, screenW] × [0, screenH]
└──────────────────────────────────────────────────────────────────────┘
```

- **Gameplay layer never sees screen px**. AI, combat, movement work in
  hex coords. Render layer translates to world / screen on demand.
- **World px** is the cylindrical projection — `WRAP_DISTANCE_PX = W` is
  the wrap period. Rendering pre-emits hex copies at `±W` for visible-near-
  seam coverage; viewport snaps `center.x` modulo `W` (Phase 6.7).
- **Screen px** depends on viewport zoom + scroll; no game logic uses it.

---

## 5. Concrete examples

### 5.1 Vatican across zooms

Vatican is a force-assigned hex (Section 4.4 of SPEC.md) — guaranteed ≥ 1
hex from tier 25 km onward. Its canonical coord depends on tier; example
illustrative numbers (actual depend on bake output):

| Tier   | (q, r)              | World px (hexSize)   | Visible at zoom |
|--------|---------------------|----------------------|-----------------|
| 50 km  | NOT GUARANTEED      | n/a                  | n/a             |
| 25 km  | `(412, −207)`       | (~826, ~-394)        | ≥ 2×            |
| 10 km  | `(1030, −517)`      | same world px        | ≥ 4×            |
| 5 km   | `(2060, −1034)`     | same world px        | ≥ 8×            |
| 1 km   | `(10300, −5170)`    | same world px        | ≥ 32×           |

Note: world-px coords are tier-INDEPENDENT (controlled by `kmToWorldPx`).
Only `(q, r)` changes by tier scale.

### 5.2 Aleutian → Chukotka (cross-seam neighbor)

Both in tier 50 km. Suppose:
- Aleutian westmost: `(qA = halfWrap − 2, rA = R0)`
- Chukotka eastmost: `(qC = -halfWrap + 1, rC = R0 + halfWrap)` *(r adjusted per
  wrap rule)*

**Wrong (raw axial)**:
```ts
const dq = qC - qA; // = -wrap_count + 3 ≈ -533 (huge)
const dist = (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
// ~533 hexes — AI thinks they're far apart.
```

**Right**:
```ts
import { wrapHexDistance } from '../geo/wrap';
const dist = wrapHexDistance(qA, rA, qC, rC, 50);
// = 3 — actually adjacent across seam.
```

### 5.3 Pathfinding Vietnam → Mexico

Vietnam ~ `lng=105°, lat=15°`. Mexico ~ `lng=-100°, lat=22°`.
Direct longitude delta: 205°. Wrap delta: 155°.

`wrapShortestQDir(qVN, qMX, tierKm)` → returns `-1` (go west via Pacific).

A pathfinder using `wrapAllNeighbors` as successor function naturally
expands westward neighbors and finds the wrap path. A pathfinder using
the original 6 axial neighbors (no wrap) would expand only east, never
reach Mexico, return path-not-found.

---

## 6. Anti-patterns (DO NOT DO THIS)

### Anti-pattern 1 — raw `===` for hex equality

```ts
// ❌ WRONG
if (hex1.q === hex2.q && hex1.r === hex2.r) { /* same hex */ }

// ✅ RIGHT
if (sameHex(hex1.q, hex1.r, hex2.q, hex2.r, currentTierKm)) { /* same hex */ }
```

Failure mode: same hex stored as `(0, 0)` and `(WRAP_HEX_COUNT, -halfWrap)`
fail equality, treated as different units.

### Anti-pattern 2 — hand-rolled neighbor lookup

```ts
// ❌ WRONG
const NEIGHBORS = [[+1,0], [+1,-1], [0,-1], [-1,0], [-1,+1], [0,+1]];
for (const [dq, dr] of NEIGHBORS) {
  const nq = hex.q + dq;
  const nr = hex.r + dr;
  // ... use (nq, nr)
}

// ✅ RIGHT
for (const [nq, nr] of wrapAllNeighbors(hex.q, hex.r, currentTierKm)) {
  // ... use (nq, nr) — already canonical
}
```

Failure mode: at seam, `nq` falls outside canonical range; downstream
lookups (in spatial index, save file, comparison) silently fail.

### Anti-pattern 3 — Manhattan / Euclidean distance for AI range

```ts
// ❌ WRONG — AI ignores wrap-reachable targets
function distanceToTarget(unit, target) {
  return Math.abs(unit.q - target.q) + Math.abs(unit.r - target.r);
}

// ✅ RIGHT
function distanceToTarget(unit, target) {
  return wrapHexDistance(unit.q, unit.r, target.q, target.r, currentTierKm);
}
```

Failure mode (R-4 in Phase 6 risk register): Russia ignores Alaska, US
ignores Russia.

### Anti-pattern 4 — hardcoded WRAP_HEX_COUNT for one tier

```ts
// ❌ WRONG — breaks when tier changes
const WRAP_50KM = 535;
function neighbor(q, r) {
  let q2 = q + 1;
  if (q2 > WRAP_50KM / 2) q2 -= WRAP_50KM;
  return [q2, r];
}

// ✅ RIGHT — uses helper, tier passed in
function neighbor(q, r, tierKm) {
  return wrapNeighbor(q, r, 0 /* dir +1 */, tierKm);
}
```

Failure mode: gameplay zooms to 10 km, hardcoded constant doesn't apply,
neighbor lookup wraps to wrong hex.

---

## 7. Migration / refactor list (Phase 6 cleanup)

Existing code paths inspected for raw wrap logic. Status as of 2026-04-26:

| File                           | Inline wrap?   | Refactor?                                    |
|--------------------------------|----------------|----------------------------------------------|
| `src/render/chunkGrid.ts`      | YES (was)      | ✅ Phase 6.8 commit — uses `normalizeHex`    |
| `src/render/hexLayer.ts`       | only via chunkGrid | ✅ no direct wrap math, OK                |
| `src/data/tiers.ts`            | none           | ✅                                            |
| `src/render/lod.ts`            | none           | ✅                                            |
| `scripts/bake-hex-tiers.ts`    | bake-time only | accept (bake is offline; doesn't run in app) |

**Pre-Phase-7 lint hint**: any new file under `src/gameplay/**` should
fail lint if it imports `axialToPx` directly without going through
`wrap.ts` helpers. Future work; current Phase 1 codebase has no
gameplay/ directory.

---

## 8. Frequently asked

**Q: Why is `r` adjusted when `q` wraps?**
A: Flat-top axial coordinates encode geographic position via
`y = -size·√3·(r + q/2)`. When `q` wraps by `WRAP_HEX_COUNT` (a full lap),
the `q/2` term shifts `y` by `±halfWrap·size·√3/2`. To preserve
geographic latitude (i.e., the same hex on the same parallel), `r` must
shift by `∓halfWrap` to cancel.

**Q: Does Y wrap?**
A: No. Mercator clamped at ±85° latitude — beyond that, the projection
diverges. Vertical pan is clamped via pixi-viewport normal Y bounds.

**Q: What about elevation / 3-D?**
A: Out of scope for SPEC v1.0. If future Phase 7+ adds elevation, attach
to hex as a separate field; coordinate system unchanged.

**Q: How fast are the helpers?**
A: `normalizeHex` is 1–2 modulo + add ops per call (< 50 ns).
`wrapHexDistance` does 2 distance computes + min (< 200 ns). Used in
inner loops (pathfinding, edge tessellation) the cost is negligible vs
the gameplay logic itself.

---

## 9. Sign-off

This contract is LOCKED for SPEC v1.0. Changes require:

1. New invariant or rule discussion in PR with rationale.
2. Update of all callers (`src/geo/wrap.ts` is the only file to change
   for behavior; callers should remain stable).
3. Re-run `npm test` covering `wrap.test.ts`.
4. Justin's approval for any signature change.

---

> END OF COORDINATE SYSTEM CONTRACT v1
