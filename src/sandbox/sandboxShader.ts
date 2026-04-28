/**
 * Sandbox shader — extends production hexShader với:
 *  - aMeta unorm8x4 attribute (terrainId, seed, pad, pad)
 *  - vLocal varying (per-vertex template offset, used for in-hex coords)
 *  - vTerrainId, vSeed varyings
 *  - Fragment shader procedural texture per terrain (value noise + hash)
 *
 * Production main map (src/render/hexShader.ts) KHÔNG dùng shader này.
 * Sandbox-only — texture experiments isolated.
 *
 * Buffer layout (16 bytes/instance):
 *   [0..3]   cx           float32
 *   [4..7]   cy           float32
 *   [8..11]  color        unorm8x4
 *   [12]     terrainId    u8 (0..5 from Terrain enum, /255 in shader)
 *   [13]     seed         u8 (deterministic per-hex hash)
 *   [14..15] pad          u16
 */
import { Shader } from 'pixi.js';

const GL_VERTEX = /* glsl */ `
  precision highp float;
  attribute vec2 aTemplate;
  attribute vec2 aInstancePos;
  attribute vec4 aInstanceColor;
  attribute vec4 aMeta;
  varying vec4 vColor;
  varying vec2 vLocal;
  varying float vTerrainId;
  varying float vSeed;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    vec2 worldPos = aInstancePos + aTemplate;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec3 pos = mvp * vec3(worldPos, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    vColor = aInstanceColor;
    vLocal = aTemplate;
    vTerrainId = aMeta.r;
    vSeed = aMeta.g;
  }
`;

const GL_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec4 vColor;
  varying vec2 vLocal;
  varying float vTerrainId;
  varying float vSeed;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    vec3 base = vColor.rgb;
    // p = local offset within hex, scaled + seed-jittered for inter-cell variation.
    vec2 p = vLocal * 2.5 + vSeed * 17.0;
    float lo = vnoise(p * 0.6);
    float hi = vnoise(p * 3.0);
    float cellJitter = (vSeed - 0.5) * 0.06;

    int tid = int(vTerrainId * 255.0 + 0.5);
    vec3 finalColor = base;

    if (tid == 0) {
      // Ocean — subtle blue wave (low-freq)
      finalColor += vec3(0.0, 0.02, 0.06) * (lo - 0.5);
    } else if (tid == 1) {
      // Coast — brighter wave, lighter blue tint
      finalColor += vec3(0.04, 0.06, 0.10) * (lo - 0.5);
      finalColor += vec3(0.02) * (hi - 0.5);
    } else if (tid == 2) {
      // Plains — soft khaki/green patches + small grain
      finalColor += vec3(0.08, 0.06, -0.04) * (lo - 0.5);
      finalColor += vec3(0.04, 0.04, 0.02) * (hi - 0.5);
    } else if (tid == 3) {
      // Forest — clustered dark spots, leafy noise
      float clump = vnoise(p * 1.4);
      finalColor *= 1.0 - clump * 0.18;
      finalColor += vec3(0.04, 0.07, 0.04) * (hi - 0.5);
    } else if (tid == 4) {
      // Mountain — rocky grain, reddish-gray tint
      finalColor += vec3(0.10, 0.08, 0.06) * (hi - 0.5);
      finalColor += vec3(0.06) * (vnoise(p * 6.0) - 0.5);
    } else if (tid == 5) {
      // Urban — blocky variation (cell-block hash)
      vec2 block = floor(p * 0.4);
      finalColor += vec3(0.06) * (hash(block) - 0.5);
      finalColor += vec3(0.03) * (hi - 0.5);
    }

    finalColor += vec3(cellJitter);
    gl_FragColor = vec4(finalColor, vColor.a);
  }
`;

// WGSL counterpart — mirrors GL behavior. Pixi v8 bind group conventions same
// as production hexShader.ts (group 0 = global, group 1 = local).
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
  @location(1) vLocal: vec2<f32>,
  @location(2) vTerrainId: f32,
  @location(3) vSeed: f32,
}

@vertex
fn main(
  @location(0) aTemplate: vec2<f32>,
  @location(1) aInstancePos: vec2<f32>,
  @location(2) aInstanceColor: vec4<f32>,
  @location(3) aMeta: vec4<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = aInstancePos + aTemplate;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let pos = mvp * vec3<f32>(worldPos, 1.0);
  output.position = vec4<f32>(pos.xy, 0.0, 1.0);
  output.vColor = aInstanceColor;
  output.vLocal = aTemplate;
  output.vTerrainId = aMeta.r;
  output.vSeed = aMeta.g;
  return output;
}
`;

const GPU_FRAGMENT = /* wgsl */ `
fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x),
    mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x),
    u.y
  );
}

@fragment
fn main(
  @location(0) vColor: vec4<f32>,
  @location(1) vLocal: vec2<f32>,
  @location(2) vTerrainId: f32,
  @location(3) vSeed: f32,
) -> @location(0) vec4<f32> {
  var base = vColor.rgb;
  let p = vLocal * 2.5 + vSeed * 17.0;
  let lo = vnoise(p * 0.6);
  let hi = vnoise(p * 3.0);
  let cellJitter = (vSeed - 0.5) * 0.06;

  let tid = i32(vTerrainId * 255.0 + 0.5);
  var finalColor = base;

  if (tid == 0) {
    finalColor = finalColor + vec3<f32>(0.0, 0.02, 0.06) * (lo - 0.5);
  } else if (tid == 1) {
    finalColor = finalColor + vec3<f32>(0.04, 0.06, 0.10) * (lo - 0.5);
    finalColor = finalColor + vec3<f32>(0.02) * (hi - 0.5);
  } else if (tid == 2) {
    finalColor = finalColor + vec3<f32>(0.08, 0.06, -0.04) * (lo - 0.5);
    finalColor = finalColor + vec3<f32>(0.04, 0.04, 0.02) * (hi - 0.5);
  } else if (tid == 3) {
    let clump = vnoise(p * 1.4);
    finalColor = finalColor * (1.0 - clump * 0.18);
    finalColor = finalColor + vec3<f32>(0.04, 0.07, 0.04) * (hi - 0.5);
  } else if (tid == 4) {
    finalColor = finalColor + vec3<f32>(0.10, 0.08, 0.06) * (hi - 0.5);
    finalColor = finalColor + vec3<f32>(0.06) * (vnoise(p * 6.0) - 0.5);
  } else if (tid == 5) {
    let block = floor(p * 0.4);
    finalColor = finalColor + vec3<f32>(0.06) * (hash2(block) - 0.5);
    finalColor = finalColor + vec3<f32>(0.03) * (hi - 0.5);
  }

  finalColor = finalColor + vec3<f32>(cellJitter);
  return vec4<f32>(finalColor, vColor.a);
}
`;

export function createSandboxShader(): Shader {
  return Shader.from({
    gl: { vertex: GL_VERTEX, fragment: GL_FRAGMENT },
    gpu: {
      vertex: { source: GPU_VERTEX, entryPoint: 'main' },
      fragment: { source: GPU_FRAGMENT, entryPoint: 'main' },
    },
  });
}
