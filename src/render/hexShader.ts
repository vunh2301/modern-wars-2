/**
 * Phase 7.4 + 7.8 hex shader (MWCK v2 instanced).
 *
 * Per-vertex (template, 6 verts):
 *   aTemplate (vec2) — pre-scaled hex vertex offset from instance center
 *
 * Per-instance (one per hex):
 *   aInstancePos   (vec2) — chunk-local hex center in world px
 *   aInstanceColor (vec4) — RGBA from u8×4 unorm
 *
 * Pixi v8 auto-binds matrices:
 *   uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix.
 *
 * Phase 7.8 (2026-04-26): added WGSL counterpart for WebGPU renderer
 * (iOS Safari 18.4+ enables WebGPU mặc định trên iPhone). Pixi v8
 * Shader.from accepts both gl + gpu configs; runtime picks based on
 * active renderer.
 */
import { Shader } from 'pixi.js';

const GL_VERTEX = /* glsl */ `
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

const GL_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec4 vColor;
  void main() {
    gl_FragColor = vColor;
  }
`;

// Pixi v8 WebGPU pipeline:
//   - extractAttributesFromGpuProgram parses @location(...) ONLY from
//     vertex fn args (NOT from struct fields). Must inline attributes.
//   - autoAssignGlobalUniforms triggers when WGSL var name = "globalUniforms"
//     at @group(0)@binding(0). Same cho localUniforms ở @group(1)@binding(0).
//   - Struct field order phải khớp Pixi v8 globalUniformsBit / localUniformBit
//     (canonical: uProjectionMatrix, uWorldTransformMatrix, uWorldColorAlpha,
//     uResolution / uTransformMatrix, uColor, uRound).
const GPU_VERTEX = /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vColor: vec4<f32>,
}

@vertex
fn main(
  @location(0) aTemplate: vec2<f32>,
  @location(1) aInstancePos: vec2<f32>,
  @location(2) aInstanceColor: vec4<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = aInstancePos + aTemplate;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let pos = mvp * vec3<f32>(worldPos, 1.0);
  output.position = vec4<f32>(pos.xy, 0.0, 1.0);
  output.vColor = aInstanceColor;
  return output;
}
`;

const GPU_FRAGMENT = /* wgsl */ `
@fragment
fn main(
  @location(0) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
  return vColor;
}
`;

export function createHexShader(): Shader {
  return Shader.from({
    gl: { vertex: GL_VERTEX, fragment: GL_FRAGMENT },
    gpu: {
      vertex: { source: GPU_VERTEX, entryPoint: 'main' },
      fragment: { source: GPU_FRAGMENT, entryPoint: 'main' },
    },
  });
}
