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
 * Curated political-map palette (Risk / Hearts of Iron style).
 * Justin feedback 2026-04-26: random HSL hues "không đẹp, không đúng màu bản đồ
 * thế giới". 14 hand-picked colors with high saturation + medium lightness +
 * good distinction; assigned via ISO hash so adjacent neighbors get different
 * indices. Repeats acceptable (only 195 countries, 14 palette → ~14 same-color,
 * but golden-ratio spread + neighbor-aware would be Phase 4).
 */
const POLITICAL_PALETTE = [
  0xc0392b, // brick red
  0x2980b9, // strong blue
  0xf39c12, // amber
  0x16a085, // teal green
  0x8e44ad, // purple
  0x27ae60, // emerald
  0xd35400, // pumpkin orange
  0x2c3e50, // midnight blue
  0xc71585, // medium violet red
  0x1abc9c, // turquoise
  0xe67e22, // carrot orange
  0x34495e, // wet asphalt
  0x9b59b6, // amethyst
  0xe74c3c, // bright red
];

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

void hslToHex; // kept for future fallback

export function isoToColor(iso: string): number {
  const h = fnv1a(iso);
  return POLITICAL_PALETTE[h % POLITICAL_PALETTE.length] ?? 0x808080;
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
