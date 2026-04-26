/**
 * Phase 7.4 hex shader (MWCK v2 instanced).
 *
 * Per-vertex (template, 6 verts):
 *   aTemplate (vec2) — pre-scaled hex vertex offset from instance center
 *
 * Per-instance (one per hex):
 *   aInstancePos   (vec2) — chunk-local hex center in world px
 *   aInstanceColor (vec4) — RGBA from u8×4 unorm
 *
 * Pixi v8 Mesh auto-binds: uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix.
 *
 * Fragment: passthrough. GLSL ES 1.0 (max iOS Safari compat).
 */
import { Shader } from 'pixi.js';

const VERTEX_SRC = /* glsl */ `
  precision highp float;
  attribute vec2 aTemplate;
  attribute vec2 aInstancePos;
  attribute vec4 aInstanceColor;
  varying vec4 vColor;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    vec2 worldPos = aInstancePos + aTemplate;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec3 pos = mvp * vec3(worldPos, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    vColor = aInstanceColor;
  }
`;

const FRAGMENT_SRC = /* glsl */ `
  precision mediump float;
  varying vec4 vColor;
  void main() {
    gl_FragColor = vColor;
  }
`;

export function createHexShader(): Shader {
  return Shader.from({
    gl: { vertex: VERTEX_SRC, fragment: FRAGMENT_SRC },
  });
}
