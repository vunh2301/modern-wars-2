/**
 * Ocean background layer (z=0). SPEC Section 5.1.
 *
 * Single solid-color sprite covering the entire world canvas. Always rendered
 * (cullable=false). Tinted via `palette.oceanFill`.
 */
import { Sprite, Texture } from 'pixi.js';
import { hexToPixiTint, palette } from '../../style/palette';
import { WORLD_W, WORLD_H } from '../viewport';

export function createOceanLayer(): Sprite {
  const sprite = new Sprite(Texture.WHITE);
  sprite.tint = hexToPixiTint(palette.oceanFill);
  sprite.width = WORLD_W;
  sprite.height = WORLD_H;
  sprite.x = 0;
  sprite.y = 0;
  sprite.cullable = false;
  sprite.label = 'ocean';
  return sprite;
}
