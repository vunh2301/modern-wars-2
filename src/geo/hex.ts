/**
 * Flat-top axial hex math. SPEC v1.0 Section 5.2 + 5.3.
 *
 * `size` = hex side length (== distance from center to vertex).
 * Width = 2*size, height = sqrt(3)*size.
 * Horizontal pitch = 1.5*size, vertical pitch = sqrt(3)*size.
 */
export const SQRT_3 = Math.sqrt(3);

/** Convert axial (q, r) → world px (size already in px). Y inverted to match screen-down convention. */
export function axialToPx(q: number, r: number, size: number): [number, number] {
  const x = size * 1.5 * q;
  const y = -size * SQRT_3 * (r + q / 2);
  return [x, y];
}

/** Hex outer width + height (for sprite scale). */
export function hexSpriteScale(size: number): { width: number; height: number } {
  return { width: 2 * size, height: SQRT_3 * size };
}
