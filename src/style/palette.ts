/**
 * Visual style palette — Terminal/Sci-fi (Defcon / Bloomberg Terminal aesthetic).
 *
 * SPEC Section 20.1: pin exact hex values; this file is the design system token source.
 * SPEC Section 4.3 step 8: `faction` array used by Welsh-Powell 4-color greedy at build time.
 */

export const palette = {
  // Backgrounds
  bgVoid: '#000814',
  bgPanel: '#001220',
  bgPanelHover: '#001a2e',
  oceanFill: '#001a2e',

  // Accents (4-color faction palette anchors)
  cyan: '#00e5ff',
  cyanDim: '#0088aa',
  magenta: '#ff00aa',
  amber: '#ffb800',
  emerald: '#00ff88',

  // Text
  textPrimary: '#e0f7ff',
  textMuted: '#7a9eb8',
  textDim: '#3d5a73',

  // Country fill base — 4-color theorem palette (color-blind safe per Section 4.3 step 8)
  faction: ['#0088aa', '#aa0066', '#aa6600', '#006644'] as const,

  // Effects
  scanlineAlpha: 0.04,
  glowSpread: '0 0 12px',
} as const;

export type Palette = typeof palette;

/**
 * Convert `#RRGGBB` to Pixi numeric tint (0xRRGGBB).
 * Used by render layer to set Container.tint for country fills (SPEC Section 5.3).
 */
export function hexToPixiTint(hex: string): number {
  const cleaned = hex.startsWith('#') ? hex.slice(1) : hex;
  return parseInt(cleaned, 16);
}
