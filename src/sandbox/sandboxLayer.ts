/**
 * Sandbox hex layer — single Mesh wrapping 64×64 synthetic grid.
 *
 * Bypass tier/chunk/manifest infrastructure. Direct render path để iterate
 * texture / shader experiments rất nhanh (no CDN, no LRU, no LOD).
 *
 * Reuse hexShader.ts — identical attribute layout (aTemplate vec2 +
 * aInstancePos vec2 + aInstanceColor unorm8x4).
 */
import 'pixi.js/mesh';
import {
  Buffer as PixiBuffer,
  BufferUsage,
  Container,
  Geometry,
  Mesh,
  type Application,
  type Shader,
} from 'pixi.js';
import { createSandboxShader } from './sandboxShader';
import { generateSandboxData } from './sandboxData';

export interface SandboxLayer {
  root: Container;
  hexCount: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  destroy(): void;
}

export function createSandboxLayer(
  _app: Application,
  rows = 256,
  cols = 128,
  seed = 1,
): SandboxLayer {
  const root = new Container();
  root.label = 'sandbox-hex-layer';
  root.cullable = false;

  const shader: Shader = createSandboxShader();
  const data = generateSandboxData(rows, cols, seed);

  const templateBuf = new PixiBuffer({
    data: data.templateBuffer,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const instanceBuf = new PixiBuffer({
    data: data.instanceBuffer,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const indexBuf = new PixiBuffer({
    data: data.indexBuffer,
    usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
  });

  // Sandbox extended buffer 16 bytes/instance (vs production 12):
  //   [0..7]   pos     float32x2
  //   [8..11]  color   unorm8x4
  //   [12..15] meta    unorm8x4 (terrainId, seed, pad, pad)
  const geom = new Geometry({
    attributes: {
      aTemplate: { buffer: templateBuf, format: 'float32x2', offset: 0, stride: 8 },
      aInstancePos: { buffer: instanceBuf, format: 'float32x2', offset: 0, stride: 16, instance: true },
      aInstanceColor: { buffer: instanceBuf, format: 'unorm8x4', offset: 8, stride: 16, instance: true },
      aMeta: { buffer: instanceBuf, format: 'unorm8x4', offset: 12, stride: 16, instance: true },
    },
    indexBuffer: indexBuf,
    topology: 'triangle-list',
    instanceCount: data.hexCount,
  });

  const mesh = new Mesh<Geometry, Shader>({ geometry: geom, shader });
  mesh.label = 'sandbox-mesh';
  mesh.cullable = false;

  // Mesh<Geometry, Shader> generics confuse Container.addChild overload (giống
  // pattern trong meshHexLayer.ts). Runtime Pixi accept any Container child.
  root.addChild(mesh as unknown as Container);

  // Bounds estimate cho flat-top hex layout (kmToWorldPx(25) ≈ 4px).
  // flat-top pitch: x = size*1.5, y = size*√3
  const SIZE_PX = 4;
  const halfX = (cols / 2) * 1.5 * SIZE_PX;
  const halfY = (rows / 2) * Math.sqrt(3) * SIZE_PX + SIZE_PX * Math.sqrt(3) / 2;

  const destroy = (): void => {
    mesh.destroy({ children: true });
    geom.destroy(true);
    shader.destroy();
    root.destroy({ children: true });
  };

  return {
    root,
    hexCount: data.hexCount,
    bounds: { minX: -halfX, minY: -halfY, maxX: halfX, maxY: halfY },
    destroy,
  };
}
