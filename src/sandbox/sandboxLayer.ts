/**
 * Sandbox hex layer — single Mesh wrapping synthetic grid với live regenerate.
 *
 * Bypass tier/chunk/manifest infrastructure. Direct render path để iterate
 * texture / shader experiments rất nhanh.
 *
 * Live regenerate API: cập nhật seed/params không cần reload page (Phase 6
 * debug panel UI sẽ gọi regenerate khi user kéo slider hoặc đổi preset).
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
import {
  generateSandboxData,
  DEFAULT_WORLDGEN_PARAMS,
  type WorldgenParams,
} from './sandboxData';

export interface SandboxLayer {
  root: Container;
  hexCount: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Live regenerate — destroy current mesh + rebuild với new seed/params. */
  regenerate(seed: number, params: WorldgenParams): void;
  destroy(): void;
}

export function createSandboxLayer(
  _app: Application,
  rows = 256,
  cols = 128,
  seed = 1,
  initialParams: WorldgenParams = DEFAULT_WORLDGEN_PARAMS,
): SandboxLayer {
  const root = new Container();
  root.label = 'sandbox-hex-layer';
  root.cullable = false;

  const shader: Shader = createSandboxShader();

  // Mutable mesh refs — replaced khi regenerate.
  let mesh: Mesh<Geometry, Shader> | null = null;
  let geom: Geometry | null = null;
  let templateBuf: PixiBuffer | null = null;
  let instanceBuf: PixiBuffer | null = null;
  let indexBuf: PixiBuffer | null = null;

  const buildMesh = (sd: number, params: WorldgenParams): void => {
    const data = generateSandboxData(rows, cols, sd, params);

    templateBuf = new PixiBuffer({
      data: data.templateBuffer,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    instanceBuf = new PixiBuffer({
      data: data.instanceBuffer,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    indexBuf = new PixiBuffer({
      data: data.indexBuffer,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });

    geom = new Geometry({
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

    mesh = new Mesh<Geometry, Shader>({ geometry: geom, shader });
    mesh.label = 'sandbox-mesh';
    mesh.cullable = false;
    root.addChild(mesh as unknown as Container);
  };

  const destroyMesh = (): void => {
    if (mesh) {
      mesh.destroy({ children: true });
      mesh = null;
    }
    if (geom) {
      geom.destroy(true);
      geom = null;
    }
    templateBuf = null;
    instanceBuf = null;
    indexBuf = null;
  };

  const regenerate = (sd: number, params: WorldgenParams): void => {
    destroyMesh();
    buildMesh(sd, params);
  };

  // Initial build.
  buildMesh(seed, initialParams);

  // Bounds estimate cho flat-top offset hex layout (kmToWorldPx(25) ≈ 4px).
  const SIZE_PX = 4;
  const halfX = (cols / 2) * 1.5 * SIZE_PX;
  const halfY = (rows / 2) * Math.sqrt(3) * SIZE_PX + SIZE_PX * Math.sqrt(3) / 2;

  const destroy = (): void => {
    destroyMesh();
    shader.destroy();
    root.destroy({ children: true });
  };

  return {
    root,
    hexCount: rows * cols,
    bounds: { minX: -halfX, minY: -halfY, maxX: halfX, maxY: halfY },
    regenerate,
    destroy,
  };
}
