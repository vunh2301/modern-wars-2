/**
 * Tiny math helpers. Keep this module dependency-free so sim layer can use it
 * without breaking the no-Math.random ESLint guard (it never reaches Math.random).
 */

export type Vec2 = [number, number];

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
