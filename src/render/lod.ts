/**
 * Zoom → tier picker với hysteresis. SPEC v1.0 Section 6 LOD mapping.
 *
 * Hysteresis (asymmetric ±0.25 around threshold) prevents rapid tier switching
 * during pinch zoom oscillation around boundary — Justin feedback 2026-04-26
 * "nó bị flash khi di chuyển map".
 */

export type TierName = '50km' | '25km' | '10km' | '5km' | '2km' | '1km';

interface ZoomBand { minZoom: number; tier: TierName; }

const ZOOM_BANDS: ZoomBand[] = [
  { minZoom: 32, tier: '1km' },
  { minZoom: 16, tier: '2km' },
  { minZoom: 8, tier: '5km' },
  { minZoom: 4, tier: '10km' },
  // 2026-04-26 Justin feedback: 25km xuống tới zoom 1× (was 2×). 50km
  // chỉ tier-default cho fit-to-screen (zoom <1×). Trade-off: thêm chunks
  // 25km ở 1×-2× nhưng đỡ phải chuyển tier khi user zoom in lần đầu.
  { minZoom: 1, tier: '25km' },
  { minZoom: 0, tier: '50km' },
];

const HYSTERESIS = 0.25;

/**
 * Pick tier for given zoom. If `currentTier` provided, applies hysteresis
 * so the switch only happens when zoom decisively crosses the boundary.
 */
export function pickTier(
  zoom: number,
  available: ReadonlySet<string>,
  currentTier?: TierName,
): TierName {
  // Find the natural tier for this zoom.
  let natural: TierName = '50km';
  for (const band of ZOOM_BANDS) {
    if (zoom >= band.minZoom && available.has(band.tier)) {
      natural = band.tier;
      break;
    }
  }

  if (!currentTier || natural === currentTier) return natural;

  // Apply hysteresis: only switch if we're past the threshold + buffer.
  const naturalIdx = ZOOM_BANDS.findIndex((b) => b.tier === natural);
  const currentIdx = ZOOM_BANDS.findIndex((b) => b.tier === currentTier);

  if (naturalIdx < currentIdx) {
    // Zooming in (finer tier). Switch only if zoom is well past boundary.
    const boundary = ZOOM_BANDS[naturalIdx]?.minZoom ?? 0;
    if (zoom > boundary + HYSTERESIS) return natural;
    return currentTier;
  }
  // Zooming out (coarser tier). Switch only if zoom is well below boundary.
  const boundary = ZOOM_BANDS[currentIdx]?.minZoom ?? 0;
  if (zoom < boundary - HYSTERESIS) return natural;
  return currentTier;
}
