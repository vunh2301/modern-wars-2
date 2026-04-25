/**
 * Texture inventory + VRAM estimator. SPEC Section 14.2.
 *
 * Pixi v8 does not expose a stable `TextureSource.all` public API, so render
 * code is responsible for calling track/untrack as it allocs/destroys.
 */
import type { TextureSource } from 'pixi.js';

const registry = new Set<TextureSource>();

export function trackTexture(src: TextureSource): void {
  registry.add(src);
}

export function untrackTexture(src: TextureSource): void {
  registry.delete(src);
}

/**
 * Ballpark VRAM in bytes. Not OS-truth — see Section 14.2 caveat.
 */
export function estimateVram(): number {
  let total = 0;
  for (const s of registry) {
    if (s.destroyed) {
      registry.delete(s);
      continue;
    }
    const w = s.width * (s.resolution ?? 1);
    const h = s.height * (s.resolution ?? 1);
    const bytesPerPixel = 4; // RGBA8 — no compressed format in MVP
    const mip = s.autoGenerateMipmaps ? 1.34 : 1.0; // 1+1/4+1/16+… ≈ 4/3
    total += w * h * bytesPerPixel * mip;
  }
  return total;
}

export function textureCount(): number {
  return registry.size;
}
