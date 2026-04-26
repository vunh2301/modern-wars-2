/**
 * Phase 7.3 mesh-based hex layer. Replaces ParticleContainer-based
 * hexLayer.ts. Loads pre-baked MWCK chunk binaries via src/data/chunks.ts,
 * uploads to GPU as Pixi v8 Mesh + Geometry, no per-hex JS iteration at
 * runtime.
 *
 * Wrap-aware visibility: 3 rbush entries per chunk (offsetX ∈ [-W, 0, +W]),
 * matches Phase 6 logic. Each (chunk, offsetX) gets its own Mesh + Graphics
 * instance — same data, position-shifted via mesh.x.
 *
 * LRU cap = 24 mesh-instances (matches Phase 6). Two-level cache:
 *   - ChunkCache (CPU): decoded ChunkBuffers, ~3 MB total
 *   - meshByKey (GPU): Pixi Mesh + Geometry (with own Buffer)
 *
 * AbortController per setTier — cancels in-flight fetches when user switches
 * tier mid-load (arch § 8.5).
 *
 * See docs/phase-7-architecture.md for full design.
 */
import 'pixi.js/mesh';
import {
  Buffer as PixiBuffer,
  BufferUsage,
  Container,
  Geometry,
  Graphics,
  Mesh,
  type Application,
  type Shader,
} from 'pixi.js';
import RBush from 'rbush';
import {
  ChunkCache,
  loadChunk,
  loadChunksManifest,
  type ChunkBuffers,
  type ChunkManifestEntry,
  type ChunksManifest,
} from '../data/chunks';
import { kmToWorldPx, WRAP_DISTANCE_PX } from '../geo/projection';
import { createHexShader } from './hexShader';

const WRAP_OFFSETS: ReadonlyArray<number> = [-WRAP_DISTANCE_PX, 0, WRAP_DISTANCE_PX];
const MAX_BUILT_INSTANCES = 24;

const BORDER_COLOR = 0x05101a;
const BORDER_ALPHA = 0.85;
const BORDER_WIDTH_FACTOR = 0.06;

interface RBushEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  chunkId: string;             // 'c-3-1'
  manifestEntry: ChunkManifestEntry;
  offsetX: number;
  key: string;                 // `${chunkId}@${offsetX}`
}

class HexRBush extends RBush<RBushEntry> {}

export interface ViewportBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MeshHexLayer {
  root: Container;
  setTier(tierName: string, sizeKm: number): Promise<void>;
  setBordersVisible(visible: boolean): void;
  updateVisibility(bbox: ViewportBbox): void;
  getStats(): MeshHexLayerStats;
  destroy(): void;
}

export interface MeshHexLayerStats {
  totalChunks: number;
  visibleChunks: number;
  builtChunks: number;
  cacheHits: number;
  cacheMisses: number;
  inFlight: number;
  lastCullMs: number;
  lastBuildMs: number;
  lastTierSwitchMs: number;
}

export function createMeshHexLayer(app: Application): MeshHexLayer {
  void app; // shader manages its own program registration
  const root = new Container();
  root.label = 'mesh-hex-layer';
  root.cullable = false;

  const shader: Shader = createHexShader();
  const chunkCache = new ChunkCache(MAX_BUILT_INSTANCES);

  let manifest: ChunksManifest | null = null;
  let rbush: HexRBush = new HexRBush();
  let currentTierName: string | null = null;
  let currentBorderWidth = 0;
  let bordersVisible = true;
  let abortController = new AbortController();

  const meshByKey = new Map<string, Mesh<Geometry, Shader>>();
  const bordersByKey = new Map<string, Graphics>();
  const inFlight = new Set<string>();
  let visibleSet = new Set<string>();
  const builtOrder: string[] = [];

  const stats: MeshHexLayerStats = {
    totalChunks: 0,
    visibleChunks: 0,
    builtChunks: 0,
    cacheHits: 0,
    cacheMisses: 0,
    inFlight: 0,
    lastCullMs: 0,
    lastBuildMs: 0,
    lastTierSwitchMs: 0,
  };

  const evictIfNeeded = (): void => {
    let safety = 64;
    while (builtOrder.length > MAX_BUILT_INSTANCES && safety-- > 0) {
      let evictIdx = -1;
      for (let i = 0; i < builtOrder.length; i++) {
        if (!visibleSet.has(builtOrder[i]!)) { evictIdx = i; break; }
      }
      if (evictIdx < 0) break;
      const evicted = builtOrder.splice(evictIdx, 1)[0]!;
      const m = meshByKey.get(evicted);
      if (m) { m.destroy({ children: true }); meshByKey.delete(evicted); }
      const g = bordersByKey.get(evicted);
      if (g) { g.destroy(); bordersByKey.delete(evicted); }
      stats.builtChunks--;
    }
  };

  const buildMesh = (key: string, buffers: ChunkBuffers, offsetX: number): void => {
    if (meshByKey.has(key)) return;
    performance.mark('chunk-build-start');
    const t0 = performance.now();

    // Vertex buffer (interleaved x:f32 y:f32 RGBA:u8×4 = 12B/vertex × 6 verts/hex)
    const vertBuf = new PixiBuffer({
      data: new Uint8Array(buffers.vertexBuffer),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const idxBuf = new PixiBuffer({
      data: buffers.indexBuffer,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });

    const geom = new Geometry({
      attributes: {
        aPosition: { buffer: vertBuf, format: 'float32x2', offset: 0, stride: 12 },
        aColor: { buffer: vertBuf, format: 'unorm8x4', offset: 8, stride: 12 },
      },
      indexBuffer: idxBuf,
      topology: 'triangle-list',
    });

    const mesh = new Mesh<Geometry, Shader>({ geometry: geom, shader });
    mesh.label = `mesh-${key}`;
    mesh.x = offsetX;
    mesh.cullable = false;

    // Borders (Graphics overlay) — same data as Phase 6
    const g = new Graphics();
    g.label = `borders-${key}`;
    g.cullable = false;
    g.visible = bordersVisible;
    const edges = buffers.edgeBuffer;
    for (let i = 0; i < edges.length; i += 4) {
      g.moveTo(edges[i]! + offsetX, edges[i + 1]!)
        .lineTo(edges[i + 2]! + offsetX, edges[i + 3]!);
    }
    if (edges.length > 0) {
      g.stroke({ color: BORDER_COLOR, alpha: BORDER_ALPHA, width: currentBorderWidth });
    }

    // Mesh<Geometry, Shader> generics confuse Container.addChild overload
    // resolution (it expects Mesh<MeshGeometry, TextureShader> default).
    // Runtime Pixi accepts any Container child; cast to base.
    root.addChild(mesh as unknown as Container);
    root.addChild(g);
    meshByKey.set(key, mesh);
    bordersByKey.set(key, g);
    builtOrder.push(key);
    stats.builtChunks++;

    const dt = performance.now() - t0;
    stats.lastBuildMs = dt;
    performance.mark('chunk-build-end');
    performance.measure('chunk-build', 'chunk-build-start', 'chunk-build-end');
  };

  const handleLoaded = (key: string, entry: ChunkManifestEntry, offsetX: number, tierAtRequest: string, buffers: ChunkBuffers): void => {
    inFlight.delete(key);
    stats.inFlight = inFlight.size;
    if (currentTierName !== tierAtRequest) return; // tier switched
    chunkCache.set(`${currentTierName}:${entry.id}`, buffers);
    if (visibleSet.has(key)) {
      buildMesh(key, buffers, offsetX);
      evictIfNeeded();
    }
  };

  const fetchAndMount = (key: string, entry: ChunkManifestEntry, offsetX: number): void => {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    stats.inFlight = inFlight.size;
    stats.cacheMisses++;
    const tierAtRequest = currentTierName!;
    const sig = abortController.signal;
    void loadChunk(entry, sig)
      .then((buffers) => handleLoaded(key, entry, offsetX, tierAtRequest, buffers))
      .catch((err: unknown) => {
        inFlight.delete(key);
        stats.inFlight = inFlight.size;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn(`[mesh-hex] chunk ${key} load failed`, err);
      });
  };

  const setTier = async (tierName: string, sizeKm: number): Promise<void> => {
    const t0 = performance.now();
    performance.mark('tier-switch-start');

    // Cancel in-flight loads from previous tier.
    abortController.abort();
    abortController = new AbortController();

    // Tear down current meshes + borders.
    for (const m of meshByKey.values()) m.destroy({ children: true });
    for (const g of bordersByKey.values()) g.destroy();
    meshByKey.clear();
    bordersByKey.clear();
    builtOrder.length = 0;
    visibleSet = new Set();
    inFlight.clear();
    chunkCache.clear();
    stats.builtChunks = 0;
    stats.visibleChunks = 0;
    stats.inFlight = 0;

    if (!manifest) manifest = await loadChunksManifest();
    const tier = manifest.tiers[tierName];
    if (!tier) throw new Error(`tier ${tierName} not in chunks manifest`);

    currentTierName = tierName;
    currentBorderWidth = kmToWorldPx(sizeKm) * BORDER_WIDTH_FACTOR;

    // Build rbush — 1 entry per (chunk × wrapOffset).
    rbush = new HexRBush();
    const entries: RBushEntry[] = [];
    for (const chunk of tier.chunks) {
      const [minX, minY, maxX, maxY] = chunk.bbox;
      for (const offsetX of WRAP_OFFSETS) {
        entries.push({
          minX: minX + offsetX,
          minY,
          maxX: maxX + offsetX,
          maxY,
          chunkId: chunk.id,
          manifestEntry: chunk,
          offsetX,
          key: `${chunk.id}@${offsetX}`,
        });
      }
    }
    rbush.load(entries);
    stats.totalChunks = entries.length;

    const dt = performance.now() - t0;
    stats.lastTierSwitchMs = dt;
    performance.mark('tier-switch-end');
    performance.measure('tier-switch', 'tier-switch-start', 'tier-switch-end');
    console.info(
      `[mesh-hex] tier ${tierName}: ${tier.hexCount} hexes / ${tier.chunkCount} chunks ` +
      `(× ${WRAP_OFFSETS.length} wrap = ${entries.length} entries) — setTier ${dt.toFixed(1)}ms`,
    );
  };

  const setBordersVisible = (visible: boolean): void => {
    bordersVisible = visible;
    for (const g of bordersByKey.values()) g.visible = visible;
  };

  const updateVisibility = (bbox: ViewportBbox): void => {
    if (!currentTierName) return;
    const t0 = performance.now();
    performance.mark('cull-query-start');

    // 1-chunk margin (Phase 6 D-5) — covers cross-chunk borders + flicker.
    const sample = rbush.all()[0];
    const chunkW = sample ? sample.maxX - sample.minX : 0;
    const chunkH = sample ? sample.maxY - sample.minY : 0;
    const expanded = {
      minX: bbox.minX - chunkW,
      minY: bbox.minY - chunkH,
      maxX: bbox.maxX + chunkW,
      maxY: bbox.maxY + chunkH,
    };

    const nowEntries = rbush.search(expanded);
    const nowSet = new Set<string>();
    for (const e of nowEntries) nowSet.add(e.key);

    // Hide entries that left viewport (don't destroy — LRU manages eviction).
    for (const key of visibleSet) {
      if (nowSet.has(key)) continue;
      const m = meshByKey.get(key);
      if (m) m.visible = false;
      const g = bordersByKey.get(key);
      if (g) g.visible = false;
    }

    // Show entries that entered viewport.
    for (const e of nowEntries) {
      const cacheKey = `${currentTierName}:${e.chunkId}`;
      const m = meshByKey.get(e.key);
      if (m) {
        m.visible = true;
        const g = bordersByKey.get(e.key);
        if (g) g.visible = bordersVisible;
        continue;
      }
      // Mesh not built — try CPU cache first.
      const cached = chunkCache.get(cacheKey);
      if (cached) {
        stats.cacheHits++;
        buildMesh(e.key, cached, e.offsetX);
        evictIfNeeded();
        continue;
      }
      // Fully cold — issue async fetch (mounts on completion if still visible).
      fetchAndMount(e.key, e.manifestEntry, e.offsetX);
    }

    visibleSet = nowSet;
    stats.visibleChunks = nowEntries.length;
    stats.lastCullMs = performance.now() - t0;
    performance.mark('cull-query-end');
    performance.measure('cull-query', 'cull-query-start', 'cull-query-end');
  };

  const getStats = (): MeshHexLayerStats => ({ ...stats });

  const destroy = (): void => {
    abortController.abort();
    for (const m of meshByKey.values()) m.destroy({ children: true });
    for (const g of bordersByKey.values()) g.destroy();
    meshByKey.clear();
    bordersByKey.clear();
    chunkCache.clear();
    shader.destroy();
    root.destroy({ children: true });
  };

  return { root, setTier, setBordersVisible, updateVisibility, getStats, destroy };
}
