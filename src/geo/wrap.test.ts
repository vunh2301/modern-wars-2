/**
 * Phase 6.8 wrap helper tests. Vitest.
 *
 * Deterministic seeded LCG (Math.random banned per SPEC Section 2).
 *
 * Run: npm test
 */
import { describe, test, expect } from 'vitest';
import {
  getWrapHexCount,
  normalizeHex,
  wrapNeighbor,
  wrapAllNeighbors,
  wrapHexDistance,
  wrapShortestQDir,
  sameHex,
} from './wrap';

const TIER_50KM = 50;
const TIER_25KM = 25;

const W50 = getWrapHexCount(TIER_50KM);
const W25 = getWrapHexCount(TIER_25KM);

/** Deterministic LCG (Numerical Recipes constants). Seeded per test. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

describe('wrap helpers', () => {
  test('getWrapHexCount scales by tier', () => {
    expect(W25).toBe(W50 * 2);
    expect(getWrapHexCount(10)).toBe(W50 * 5);
  });

  test('normalizeHex idempotent', () => {
    const cases: Array<[number, number]> = [
      [99999, -50000],
      [W50 * 3 + 7, 12],
      [-W50 * 2 - 3, -8],
      [0, 0],
    ];
    for (const [q, r] of cases) {
      const [q1, r1] = normalizeHex(q, r, TIER_50KM);
      const [q2, r2] = normalizeHex(q1, r1, TIER_50KM);
      expect([q1, r1]).toEqual([q2, r2]);
    }
  });

  test('normalizeHex maps to canonical range', () => {
    const rng = makeRng(0xC0DECAFE);
    const halfWrap = Math.floor(W50 / 2);
    for (let i = 0; i < 50; i++) {
      const q = randInt(rng, -50000, 50000);
      const r = randInt(rng, -500, 500);
      const [nq] = normalizeHex(q, r, TIER_50KM);
      expect(nq).toBeGreaterThanOrEqual(-halfWrap);
      expect(nq).toBeLessThanOrEqual(-halfWrap + W50 - 1);
    }
  });

  test('wrapHexDistance symmetric', () => {
    const rng = makeRng(0xDEADBEEF);
    for (let i = 0; i < 30; i++) {
      const a: [number, number] = [randInt(rng, -1000, 1000), randInt(rng, -500, 500)];
      const b: [number, number] = [randInt(rng, -1000, 1000), randInt(rng, -500, 500)];
      const d1 = wrapHexDistance(a[0], a[1], b[0], b[1], TIER_50KM);
      const d2 = wrapHexDistance(b[0], b[1], a[0], a[1], TIER_50KM);
      expect(d1).toEqual(d2);
    }
  });

  test('wrapHexDistance ≤ direct axial distance', () => {
    const rng = makeRng(0xFEEDFACE);
    for (let i = 0; i < 100; i++) {
      const aq = randInt(rng, -1000, 1000);
      const ar = randInt(rng, -500, 500);
      const bq = randInt(rng, -1000, 1000);
      const br = randInt(rng, -500, 500);
      const dq = bq - aq;
      const dr = br - ar;
      const direct = (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
      const wrap = wrapHexDistance(aq, ar, bq, br, TIER_50KM);
      expect(wrap).toBeLessThanOrEqual(direct);
    }
  });

  test('wrap distance close near seam', () => {
    // Two hexes near seam edges (same r, q at opposite ends) — should be
    // distance 1 via wrap, not W50 via direct.
    const halfWrap = Math.floor(W50 / 2);
    const wrapDist = wrapHexDistance(halfWrap, 0, -halfWrap + 1, halfWrap, TIER_50KM);
    expect(wrapDist).toBeLessThan(5);
  });

  test('wrapShortestQDir picks shorter side', () => {
    // a=0, b=halfWrap-1 → direct +halfWrap-1, wrap -halfWrap-1 → direct shorter
    const halfWrap = Math.floor(W50 / 2);
    expect(wrapShortestQDir(0, halfWrap - 1, TIER_50KM)).toBe(1);
    // a=0, b=-halfWrap+1 → direct -halfWrap+1, wrap +halfWrap+1 → direct shorter
    expect(wrapShortestQDir(0, -halfWrap + 1, TIER_50KM)).toBe(-1);
    // a=0, b=W50-2 → direct +W50-2 (huge), wrap -2 (close) → wrap shorter
    expect(wrapShortestQDir(0, W50 - 2, TIER_50KM)).toBe(-1);
    // same q
    expect(wrapShortestQDir(5, 5, TIER_50KM)).toBe(0);
  });

  test('sameHex modulo wrap', () => {
    const halfWrap = Math.floor(W50 / 2);
    expect(sameHex(0, 0, W50, -halfWrap, TIER_50KM)).toBe(true);
    expect(sameHex(0, 0, -W50, halfWrap, TIER_50KM)).toBe(true);
    expect(sameHex(0, 0, 1, 0, TIER_50KM)).toBe(false);
    expect(sameHex(10, 5, 10, 5, TIER_50KM)).toBe(true);
  });

  test('wrapAllNeighbors returns 6 canonical neighbors', () => {
    const neighbors = wrapAllNeighbors(0, 0, TIER_50KM);
    expect(neighbors).toHaveLength(6);
    const halfWrap = Math.floor(W50 / 2);
    for (const [nq] of neighbors) {
      expect(nq).toBeGreaterThanOrEqual(-halfWrap);
      expect(nq).toBeLessThanOrEqual(-halfWrap + W50 - 1);
    }
  });

  test('wrapNeighbor at seam wraps', () => {
    const halfWrap = Math.floor(W50 / 2);
    // q at qMax, +1 neighbor → wraps to qMin with r adjust
    const [nq, nr] = wrapNeighbor(halfWrap, 0, 0 /* +1, 0 */, TIER_50KM);
    expect(nq).toBe(-halfWrap + 1);
    expect(nr).toBe(0 + halfWrap);
  });
});
