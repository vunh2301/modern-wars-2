/**
 * Deterministic ISO_A2 → HSL color. SPEC v1.0 Section 8.4.
 *
 * Cached in Uint32 lookup table indexed by countryId for cheap render-time
 * tint resolution.
 */
import type { CountryEntry } from '../data/countries';

function hslToHex(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return (
    (Math.round((r + m) * 255) << 16) |
    (Math.round((g + m) * 255) << 8) |
    Math.round((b + m) * 255)
  );
}

/**
 * Deterministic ISO_A2 → hue 0..360. Uses FNV-1a 32-bit hash mixed with
 * golden-angle offset to spread adjacent ISO codes (US, CA, MX) into very
 * different hues. Justin feedback 2026-04-26: previous (code0*137 + code1*23) % 360
 * gave US (354) = CA (354) = same red. Big neighbors with identical color is unreadable.
 */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(s: string): number {
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

const GOLDEN_RATIO = 0.61803398875;

export function isoToColor(iso: string): number {
  const h = fnv1a(iso);
  // Map hash to [0, 1), apply golden-angle for hue spread.
  const fraction = (h / 0xffffffff + GOLDEN_RATIO) % 1;
  const hue = Math.floor(fraction * 360);
  const sat = 62 + ((h >>> 8) % 20);   // 62-81
  const lit = 50 + ((h >>> 16) % 12);  // 50-61
  return hslToHex(hue, sat, lit);
}

/**
 * Build a Uint32Array indexed by countryId. countryId 0 (ocean) → 0 (black).
 */
export function buildColorLut(countries: CountryEntry[]): Uint32Array {
  const maxId = countries.reduce((m, c) => Math.max(m, c.id), 0);
  const lut = new Uint32Array(maxId + 1);
  for (const c of countries) lut[c.id] = isoToColor(c.code);
  return lut;
}
