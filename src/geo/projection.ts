/**
 * Mercator projection helpers. SPEC v1.0 Section 5.1.
 *
 * Hex world coordinates use Mercator radians scaled by WORLD_SCALE_PX so
 * that 1 km on the equator ≈ 1/EARTH_R_KM × WORLD_SCALE_PX pixels.
 *
 * For default WORLD_SCALE_PX = 1024:
 *   - World width = 2π × 1024 ≈ 6435 px
 *   - 50km hex inradius ≈ 8 px (matches SPEC Section 6 hex display size)
 */
export const EARTH_R_KM = 6371;
export const MAX_LAT = 85;
export const WORLD_SCALE_PX = 1024;

export function lngLatToMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = (lng * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
  return [x, y];
}

export function mercatorToLngLat(x: number, y: number): [number, number] {
  const lng = (x * 180) / Math.PI;
  const lat = ((Math.atan(Math.exp(y)) - Math.PI / 4) * 360) / Math.PI;
  return [lng, lat];
}

/** Mercator radians → world pixels (centered at 0,0). Y negated for screen-down convention. */
export function mercatorToWorldPx(mx: number, my: number): [number, number] {
  return [mx * WORLD_SCALE_PX, -my * WORLD_SCALE_PX];
}

/** km → world pixels (used for hex sizing). */
export function kmToWorldPx(km: number): number {
  return (km / EARTH_R_KM) * WORLD_SCALE_PX;
}

/**
 * Wrap distance for horizontal world repetition. Justin 2026-04-26 "điểm nối
 * map bị cắt 1 lằn → cho nó sát vô".
 *
 * Naive W = 2π × WORLD_SCALE_PX không chia hết cho hex pitch → wrap copies
 * lệch subpixel ↔ visible seam. Fix: snap W xuống bội số gần nhất của
 * 50km hex pitch (mọi tier khác là chia chẵn của 50km, nên seamless mọi LOD).
 */
export const WRAP_BASE_TIER_KM = 50;
export const WRAP_HEX_COUNT_BASE: number = (() => {
  const pitchBaseRad = 1.5 * (WRAP_BASE_TIER_KM / EARTH_R_KM);
  return Math.round((2 * Math.PI) / pitchBaseRad);
})();
export const WRAP_DISTANCE_PX: number =
  WRAP_HEX_COUNT_BASE * 1.5 * kmToWorldPx(WRAP_BASE_TIER_KM);

/** World total bounds in pixels (Mercator clamped at ±MAX_LAT). Y inverted for screen-down. */
export function worldBoundsPx(): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  const minX = -Math.PI * WORLD_SCALE_PX;
  const maxX = Math.PI * WORLD_SCALE_PX;
  const [, ySouth] = lngLatToMercator(0, -MAX_LAT); // negative
  const [, yNorth] = lngLatToMercator(0, MAX_LAT);  // positive
  // Screen Y down → north (positive y_mercator) maps to negative screen Y.
  const minY = -yNorth * WORLD_SCALE_PX;
  const maxY = -ySouth * WORLD_SCALE_PX;
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
