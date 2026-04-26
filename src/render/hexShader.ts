/**
 * Phase 7.4 hex shader. Minimal WebGL shader for Mesh-based hex rendering.
 *
 * Vertex inputs:
 *   aPosition (vec2)  — world px coords (interleaved at offset 0, stride 12)
 *   aColor    (vec4)  — RGBA from 4×u8 unorm (interleaved at offset 8, stride 12)
 *
 * Pixi v8 Mesh auto-binds:
 *   uProjectionMatrix    — camera projection (mat3)
 *   uWorldTransformMatrix — world-space transform of the parent Container (mat3)
 *   uTransformMatrix     — local mesh transform (mat3, includes mesh.x for wrap offset)
 *
 * Fragment: passthrough vColor. No textures.
 *
 * GLSL ES 1.0 (attribute / varying / gl_FragColor) for max iOS Safari compat.
 */
import { Shader } from 'pixi.js';

const VERTEX_SRC = /* glsl */ `
  precision highp float;
  attribute vec2 aPosition;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec3 pos = mvp * vec3(aPosition, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    vColor = aColor;
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
