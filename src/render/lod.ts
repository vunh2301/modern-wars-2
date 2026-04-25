/**
 * Zoom → tier picker. SPEC v1.0 Section 6 LOD mapping.
 *
 * Phase 1 MVP: simple zoom-band lookup. Hysteresis Phase 4.
 */

export type TierName = '50km' | '25km' | '10km' | '5km' | '2km' | '1km';

const ZOOM_BANDS: Array<{ minZoom: number; tier: TierName }> = [
  { minZoom: 32, tier: '1km' },
  { minZoom: 16, tier: '2km' },
  { minZoom: 8, tier: '5km' },
  { minZoom: 4, tier: '10km' },
  { minZoom: 2, tier: '25km' },
  { minZoom: 0, tier: '50km' },
];

export function pickTier(zoom: number, available: ReadonlySet<string>): TierName {
  for (const band of ZOOM_BANDS) {
    if (zoom >= band.minZoom && available.has(band.tier)) return band.tier;
  }
  // Fallback to coarsest available.
  for (const t of ['50km', '25km', '10km', '5km', '2km', '1km'] as TierName[]) {
    if (available.has(t)) return t;
  }
  throw new Error('No tier available');
}
