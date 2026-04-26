/**
 * Coordinate system contract — Phase 6.8 LOCKED invariants.
 *
 * Trái Đất là cylinder cylindrical: hex world wraps horizontally (longitude)
 * mỗi WRAP_HEX_COUNT cột. Y (latitude) KHÔNG wrap (Mercator clamped ±85°).
 *
 * 3 INVARIANTS (locked — gameplay code Phase 7+ MUST follow):
 *
 *   1. CANONICAL COORDS: hex (q, r) lưu trong canonical range [Q_MIN, Q_MAX]
 *      với Q_MAX − Q_MIN + 1 = WRAP_HEX_COUNT_BASE × (50 / tierKm).
 *      Gameplay state lưu (q, r); KHÔNG lưu screen position.
 *
 *   2. NORMALIZATION: mọi hex query/save/load PHẢI normalize qua normalizeHex
 *      (q wrap → r adjust ±halfWrap). Hai (q, r) khác có thể biểu diễn cùng
 *      hex nếu q1 ≡ q2 (mod WRAP_HEX_COUNT). Use sameHex() để compare.
 *
 *   3. SHORTEST-PATH DISTANCE: pathfinding/AI/render dùng wrapHexDistance()
 *      = min(direct, wrap-around). KHÔNG dùng plain Manhattan/axial distance.
 *
 * RULES (enforce qua review):
 *   R1. Gameplay code import from src/geo/wrap.ts. Không tự implement.
 *   R2. Không dùng `===` để so sánh hex coords. Dùng sameHex().
 *   R3. Pathfinding (A-star / BFS) dùng wrapHexDistance heuristic + wrapAllNeighbors successor.
 *   R4. AI target picking dùng wrapHexDistance (else Russia ignores Alaska across seam).
 *   R5. Render movement dùng wrapShortestQDir để pick visual direction.
 *
 * Xem docs/COORDINATE_SYSTEM.md cho full reference.
 */
import { WRAP_HEX_COUNT_BASE, WRAP_BASE_TIER_KM } from './projection';

/** 6 axial neighbor offsets (flat-top, q-axis right, r-axis down-left). */
const NEIGHBORS = [
  [+1, 0], [+1, -1], [0, -1],
  [-1, 0], [-1, +1], [0, +1],
] as const;

/**
 * Wrap hex count for a given tier (number of canonical q columns).
 *  50 km tier → WRAP_HEX_COUNT_BASE
 *  25 km tier → 2 × base
 *  10 km tier → 5 × base
 */
export function getWrapHexCount(tierKm: number): number {
  return WRAP_HEX_COUNT_BASE * (WRAP_BASE_TIER_KM / tierKm);
}

/**
 * Normalize (q, r) into canonical range [Q_MIN, Q_MAX]. Same hex (modulo
 * wrap), expressed canonically.
 *
 * IMPORTANT: r MUST shift ±halfWrap when q wraps to keep flat-top axial
 * y-coord continuous. Same logic as legacy chunkGrid.wrapLookup.
 */
export function normalizeHex(q: number, r: number, tierKm: number): [number, number] {
  const wrapCount = getWrapHexCount(tierKm);
  const halfWrap = Math.floor(wrapCount / 2);
  const qMin = -halfWrap;
  const qMax = qMin + wrapCount - 1;
  let qq = q;
  let rr = r;
  while (qq > qMax) { qq -= wrapCount; rr += halfWrap; }
  while (qq < qMin) { qq += wrapCount; rr -= halfWrap; }
  return [qq, rr];
}

/** Get neighbor in direction dir (0..5), wrap-aware → returns canonical. */
export function wrapNeighbor(
  q: number, r: number, dir: number, tierKm: number,
): [number, number] {
  const off = NEIGHBORS[dir]!;
  return normalizeHex(q + off[0], r + off[1], tierKm);
}

/** All 6 neighbors of (q, r), each canonical. */
export function wrapAllNeighbors(
  q: number, r: number, tierKm: number,
): Array<[number, number]> {
  return NEIGHBORS.map(([dq, dr]) => normalizeHex(q + dq, r + dr, tierKm));
}

/**
 * Hex distance with wrap (shortest path on cylindrical world).
 *
 * Standard hex axial distance: (|dq| + |dq+dr| + |dr|) / 2
 * Wrap variant: also try q wrapped ±wrapCount (with corresponding r shift),
 * pick min.
 */
export function wrapHexDistance(
  aq: number, ar: number,
  bq: number, br: number,
  tierKm: number,
): number {
  const wrapCount = getWrapHexCount(tierKm);
  const halfWrap = Math.floor(wrapCount / 2);

  const dq1 = bq - aq;
  const dr1 = br - ar;
  const dist1 = (Math.abs(dq1) + Math.abs(dq1 + dr1) + Math.abs(dr1)) / 2;

  // Wrap-around: dq2 = dq1 ± wrapCount, with r shift to maintain continuity
  const dq2 = dq1 > 0 ? dq1 - wrapCount : dq1 + wrapCount;
  const dr2 = dq1 > 0 ? dr1 + halfWrap : dr1 - halfWrap;
  const dist2 = (Math.abs(dq2) + Math.abs(dq2 + dr2) + Math.abs(dr2)) / 2;

  return Math.min(dist1, dist2);
}

/**
 * Direction of shortest q-path from a to b (-1 = wrap left, +1 = right, 0 = same).
 * Used by render to pick visual direction (and to avoid teleport across seam
 * when reasonable to go around).
 */
export function wrapShortestQDir(aq: number, bq: number, tierKm: number): -1 | 0 | 1 {
  if (aq === bq) return 0;
  const wrapCount = getWrapHexCount(tierKm);
  const dq1 = bq - aq;
  const dq2 = dq1 > 0 ? dq1 - wrapCount : dq1 + wrapCount;
  if (Math.abs(dq1) <= Math.abs(dq2)) {
    return dq1 > 0 ? 1 : -1;
  }
  return dq2 > 0 ? 1 : -1;
}

/** True if (aq, ar) and (bq, br) refer to the same hex (modulo wrap). */
export function sameHex(
  aq: number, ar: number,
  bq: number, br: number,
  tierKm: number,
): boolean {
  const [naq, nar] = normalizeHex(aq, ar, tierKm);
  const [nbq, nbr] = normalizeHex(bq, br, tierKm);
  return naq === nbq && nar === nbr;
}
