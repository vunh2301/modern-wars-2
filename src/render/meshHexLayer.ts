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
import { QueueFullError } from '../workers/pool';
import { kmToWorldPx, WRAP_DISTANCE_PX } from '../geo/projection';
import { createHexShader } from './hexShader';

const WRAP_OFFSETS: ReadonlyArray<number> = [-WRAP_DISTANCE_PX, 0, WRAP_DISTANCE_PX];
// Hotfix 2026-04-26: 2-chunk margin can put ~36 chunk-instances visible at
// once. LRU cap raised 24→48 so eviction never starves visible set.
// Memory cost: ~48 × ~5 MB / Pixi instance ≈ 240 MB GPU buffers (under cap).
const MAX_BUILT_INSTANCES = 48;
// Phase 7.9 (2026-04-26): chunkCache decoupled from GPU mesh cap. CPU
// ChunkBuffers are cheap (~50KB each), 256 × 50KB ≈ 13MB. Cross-tier
// cache key = `${tier}:${chunkId}` — prefetch warm cache for adjacent
// tiers (eliminate cold-cache flash on zoom in/out).
const MAX_CHUNK_CACHE = 256;

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
  /** Phase 7.9: best-effort warm cache for adjacent tier (idle-paced fetch). */
  prefetchTier(tierName: string, signal?: AbortSignal): Promise<void>;
  /** Phase 8.3: wire cullNow reference for static-viewport rAF retry driver. */
  setCullNow(fn: () => void): void;
  /** Phase 8 H3 cold-cache stress: clear ChunkCache, dispatch N decode jobs
   *  through the worker pool sequentially (or concurrently up to pool size).
   *  Returns { latencies: number[], failedCount: number } where latencies are
   *  per-job roundtrip ms and failedCount is the number of jobs that errored.
   *  Used by bench scenario 4. */
  forceWorkerStress(jobCount: number): Promise<{ latencies: number[]; failedCount: number }>;
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
  const chunkCache = new ChunkCache(MAX_CHUNK_CACHE);

  let manifest: ChunksManifest | null = null;
  let rbush: HexRBush = new HexRBush();
  let currentTierName: string | null = null;
  let currentBorderWidth = 0;
  let bordersVisible = true;
  let abortController = new AbortController();
  // Hotfix 2026-04-26 (Justin iPhone fast-pan/zoom test): viewport.center.x
  // can drift far past ±W/2 during fast drag/decelerate/pinch. Instead of
  // snapping viewport (caused mid-drag jumps), shift mesh positions to track
  // viewport's actual world position. Updated each updateVisibility cull.
  let currentWrapShift = 0;

  const meshByKey = new Map<string, Mesh<Geometry, Shader>>();
  const bordersByKey = new Map<string, Graphics>();
  // Phase 7.9 (A): tier-overlap "graveyard". On setTier, current meshes/borders
  // remain mounted until new tier covers viewport (xem updateVisibility) hoặc
  // safety timer 1500ms. Prevents cold-cache flash khi user zoom in lần đầu.
  let oldTierMeshes: Mesh<Geometry, Shader>[] = [];
  let oldTierBorders: Graphics[] = [];
  let oldTierClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-render-instance loading state — distinguishes "this (chunk, offset) is awaiting mount". */
  const inFlight = new Set<string>();
  /** Per-CHUNK-FILE in-flight promises — dedupes fetch across wrap-instance offsets. Codex-review HIGH fix. */
  const inFlightByCache = new Map<string, Promise<ChunkBuffers>>();
  let visibleSet = new Set<string>();
  const builtOrder: string[] = [];

  // Phase 8.3: QueueFullError retry support.
  // Keys that failed with QueueFullError — re-attempted on next cullNow().
  // Bounded: ≤ visible chunk count (capped ≤ MAX_BUILT_INSTANCES per Phase 7.9 baseline).
  const retryNextCull = new Set<string>();
  // Guard: at most one rAF in-flight for static-viewport drain.
  let retryRafScheduled = false;
  // Callable reference to cullNow — set by the layer consumer (main.ts).
  // Used to schedule rAF retry when viewport is static (no 'moved'/'zoomed' events).
  let cullNowRef: (() => void) | null = null;

  // BLOCKER fix: Pixi v8 Mesh.destroy({children:true}) does NOT cascade to
  // Geometry/Buffer destroy. Codex review found leaking GPU buffers across
  // LRU eviction, tier switch, and layer destroy. Helper enforces explicit
  // geom.destroy(true) after mesh.destroy.
  const destroyMesh = (m: Mesh<Geometry, Shader>): void => {
    const geom = m.geometry;
    m.destroy({ children: true });
    geom.destroy(true);
  };

  // Phase 7.9 (A): sweep tier-overlap graveyard once new tier rendered.
  const clearOldTier = (): void => {
    if (oldTierClearTimer !== null) {
      clearTimeout(oldTierClearTimer);
      oldTierClearTimer = null;
    }
    if (oldTierMeshes.length === 0 && oldTierBorders.length === 0) return;
    for (const m of oldTierMeshes) destroyMesh(m);
    for (const g of oldTierBorders) g.destroy();
    oldTierMeshes = [];
    oldTierBorders = [];
  };

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
      if (m) { destroyMesh(m); meshByKey.delete(evicted); }
      const g = bordersByKey.get(evicted);
      if (g) { g.destroy(); bordersByKey.delete(evicted); }
      stats.builtChunks--;
    }
  };

  const buildMesh = (key: string, buffers: ChunkBuffers, offsetX: number): void => {
    if (meshByKey.has(key)) return;
    performance.mark('chunk-build-start');
    const t0 = performance.now();

    // Phase 7 Iter 2: instanced rendering (MWCK v2). 10× smaller GPU footprint
    // than v1. Template (48 B) + per-hex instance (12 B) + shared static index.
    // Codex-review HIGH fix: ChunkBuffers fields are now zero-copy views;
    // PixiBuffer accepts the typed-array view directly (no extra wrap).
    const templateBuf = new PixiBuffer({
      data: buffers.templateBuffer,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const instanceBuf = new PixiBuffer({
      data: buffers.instanceBuffer,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const idxBuf = new PixiBuffer({
      data: buffers.indexBuffer,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });

    const geom = new Geometry({
      attributes: {
        // stride explicit cho cả aTemplate vì WebGPU yêu cầu arrayStride;
        // Pixi v8 PipelineSystem._createVertexBufferLayouts không auto-fill,
        // WebGL2 thì tự suy ra từ format nên trước đó đã chạy được.
        aTemplate: { buffer: templateBuf, format: 'float32x2', offset: 0, stride: 8 },
        aInstancePos: { buffer: instanceBuf, format: 'float32x2', offset: 0, stride: 12, instance: true },
        aInstanceColor: { buffer: instanceBuf, format: 'unorm8x4', offset: 8, stride: 12, instance: true },
      },
      indexBuffer: idxBuf,
      topology: 'triangle-list',
      instanceCount: buffers.hexCount,
    });

    const mesh = new Mesh<Geometry, Shader>({ geometry: geom, shader });
    mesh.label = `mesh-${key}`;
    mesh.x = offsetX + currentWrapShift;
    mesh.cullable = false;

    // Borders (Graphics overlay) — same data as Phase 6.
    // Edges baked with offsetX inline; g.x adds currentWrapShift.
    const g = new Graphics();
    g.label = `borders-${key}`;
    g.cullable = false;
    g.visible = bordersVisible;
    g.x = currentWrapShift;
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

  /**
   * Codex-review HIGH fix: dedupe fetch by chunk-file key (`${tier}:${chunkId}`)
   * not render key (`${chunkId}@${offsetX}`). 3 wrap copies of the SAME chunk
   * binary now share a single fetch + decompress + parse pipeline (avoids 3×
   * redundant work + transient ArrayBuffers).
   */
  const startCacheFetch = (cacheKey: string, entry: ChunkManifestEntry, tierAtRequest: string): Promise<ChunkBuffers> => {
    const sig = abortController.signal;
    stats.cacheMisses++;
    // Capture promise ref so finally() only deletes its OWN entry (not a
    // newer promise registered after this one was aborted+restarted under
    // rapid LOD churn — Codex re-review LOW fix).
    const promise: Promise<ChunkBuffers> = loadChunk(entry, sig, tierAtRequest)
      .then((buffers) => {
        if (currentTierName === tierAtRequest) chunkCache.set(cacheKey, buffers);
        return buffers;
      })
      .finally(() => {
        if (inFlightByCache.get(cacheKey) === promise) {
          inFlightByCache.delete(cacheKey);
        }
      });
    inFlightByCache.set(cacheKey, promise);
    return promise;
  };

  const fetchAndMount = (key: string, entry: ChunkManifestEntry, offsetX: number): void => {
    if (meshByKey.has(key)) return;
    if (inFlight.has(key)) return;
    if (!currentTierName) return;
    const cacheKey = `${currentTierName}:${entry.id}`;
    const cached = chunkCache.get(cacheKey);
    if (cached) {
      stats.cacheHits++;
      buildMesh(key, cached, offsetX);
      evictIfNeeded();
      return;
    }
    inFlight.add(key);
    stats.inFlight = inFlight.size;
    const tierAtRequest = currentTierName;
    let promise = inFlightByCache.get(cacheKey);
    if (!promise) promise = startCacheFetch(cacheKey, entry, tierAtRequest);
    void promise
      .then((buffers) => {
        inFlight.delete(key);
        stats.inFlight = inFlight.size;
        if (currentTierName !== tierAtRequest) return;
        if (!visibleSet.has(key)) return;
        buildMesh(key, buffers, offsetX);
        evictIfNeeded();
      })
      .catch((err: unknown) => {
        inFlight.delete(key);
        stats.inFlight = inFlight.size;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof QueueFullError) {
          // Worker pool queue full — schedule retry on next cull.
          // Static-viewport rAF driver: if this is the first retry key added
          // (Set was empty), schedule a one-shot rAF to drive the drain.
          // This handles static viewports where no 'moved'/'zoomed' events fire.
          const wasEmpty = retryNextCull.size === 0;
          retryNextCull.add(key);
          if (wasEmpty && !retryRafScheduled && cullNowRef) {
            retryRafScheduled = true;
            requestAnimationFrame(() => {
              retryRafScheduled = false;
              cullNowRef?.();
            });
          }
          return;
        }
        console.warn(`[mesh-hex] chunk ${key} (${cacheKey}) load failed`, err);
      });
  };

  const setTier = async (tierName: string, sizeKm: number): Promise<void> => {
    const t0 = performance.now();
    performance.mark('tier-switch-start');

    // Cancel in-flight loads from previous tier.
    abortController.abort();
    abortController = new AbortController();

    // Phase 7.9 (A): KEEP current meshes/borders mounted as "graveyard" — old
    // tier render stays visible while new tier loads. Sweep on first frame
    // where new tier covers viewport (updateVisibility), or 1500ms safety.
    // Replaces old "destroy-then-load" path that caused cold-cache flash.
    clearOldTier(); // sweep stale graveyard from chained switches.
    oldTierMeshes = Array.from(meshByKey.values());
    oldTierBorders = Array.from(bordersByKey.values());

    meshByKey.clear();
    bordersByKey.clear();
    builtOrder.length = 0;
    visibleSet = new Set();
    inFlight.clear();
    inFlightByCache.clear();
    // Phase 7.9 (C): chunkCache giữ cross-tier (key bao tierName, không
    // collision). Cho phép prefetch warm cache trước cho tier kế.
    stats.builtChunks = 0;
    stats.visibleChunks = 0;
    stats.inFlight = 0;

    oldTierClearTimer = setTimeout(clearOldTier, 1500);

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

    // Phase 8.3: drain QueueFullError retry set.
    // Re-attempt chunks that failed with QueueFullError last cull.
    // retryNextCull is cleared before issuing new fetches so that
    // a second QueueFullError re-adds the key cleanly.
    if (retryNextCull.size > 0) {
      const retryKeys = Array.from(retryNextCull);
      retryNextCull.clear();
      for (const retryKey of retryKeys) {
        // Find the rbush entry for this key to get entry + offsetX.
        // Key format: `${chunkId}@${offsetX}` — parse offsetX.
        const atIdx = retryKey.lastIndexOf('@');
        if (atIdx < 0) continue;
        const offsetX = parseFloat(retryKey.slice(atIdx + 1));
        // Re-issue fetch (inFlight guard prevents duplicates).
        // rbush lookup by scanning current tier entries.
        const allEntries = rbush.all();
        const rbEntry = allEntries.find((e) => e.key === retryKey);
        if (rbEntry && visibleSet.has(retryKey)) {
          fetchAndMount(retryKey, rbEntry.manifestEntry, offsetX);
        }
      }
    }

    // Hotfix: compute wrapShift = nearest multiple of W to viewport center.
    // Then normalize bbox into canonical range for rbush query, and shift
    // mesh positions by wrapShift on render so they cover viewport's actual
    // world position. Lets viewport drift arbitrarily far without losing map.
    const cx = (bbox.minX + bbox.maxX) / 2;
    currentWrapShift = Math.round(cx / WRAP_DISTANCE_PX) * WRAP_DISTANCE_PX;
    const normMinX = bbox.minX - currentWrapShift;
    const normMaxX = bbox.maxX - currentWrapShift;

    // 2-chunk margin (Phase 7 hotfix 2026-04-26): pre-fetch chunks before
    // they enter viewport — at fast pan, async fetch (~50ms) was outpaced by
    // user motion → "ô vuông đen nháy" on iPhone. 2-chunk gives ~100ms head
    // start at typical mobile fling velocity. Trade-off: ~2× more chunks in
    // LRU pressure (still capped at 24).
    const sample = rbush.all()[0];
    const chunkW = sample ? sample.maxX - sample.minX : 0;
    const chunkH = sample ? sample.maxY - sample.minY : 0;
    const marginX = chunkW * 2;
    const marginY = chunkH * 2;
    const expanded = {
      minX: normMinX - marginX,
      minY: bbox.minY - marginY,
      maxX: normMaxX + marginX,
      maxY: bbox.maxY + marginY,
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

    // Show entries that entered viewport. Always set mesh.x + g.x to track
    // currentWrapShift (cheap; Pixi caches dirty internally).
    for (const e of nowEntries) {
      const cacheKey = `${currentTierName}:${e.chunkId}`;
      let m = meshByKey.get(e.key);
      if (!m) {
        // Try CPU cache first
        const cached = chunkCache.get(cacheKey);
        if (cached) {
          stats.cacheHits++;
          buildMesh(e.key, cached, e.offsetX);
          evictIfNeeded();
          m = meshByKey.get(e.key);
        } else {
          // Fully cold — issue async fetch (mounts on completion if still visible).
          fetchAndMount(e.key, e.manifestEntry, e.offsetX);
          continue; // mesh not yet available this frame
        }
      }
      if (m) {
        m.visible = true;
        m.x = e.offsetX + currentWrapShift;
        const g = bordersByKey.get(e.key);
        if (g) {
          g.visible = bordersVisible;
          g.x = currentWrapShift;
        }
      }
    }

    visibleSet = nowSet;

    // Phase 7.9 (A): tier-overlap sweep. Once new tier mesh-instances cover
    // every visible key, drop the graveyard mounted from previous tier.
    if (oldTierMeshes.length > 0 && nowEntries.length > 0) {
      let allBuilt = true;
      for (const k of visibleSet) {
        if (!meshByKey.has(k)) { allBuilt = false; break; }
      }
      if (allBuilt) clearOldTier();
    }

    stats.visibleChunks = nowEntries.length;
    stats.lastCullMs = performance.now() - t0;
    performance.mark('cull-query-end');
    performance.measure('cull-query', 'cull-query-start', 'cull-query-end');
  };

  const getStats = (): MeshHexLayerStats => ({ ...stats });

  // Phase 7.9 (C): warm-cache prefetch cho 1 tier. Idle-paced (yields between
  // fetches via requestIdleCallback). Dùng signal RIÊNG (warmAbortController
  // ở main.ts) — KHÔNG share với main fetch's abortController. Nếu user
  // chuyển tier, main.ts abort prefetch độc lập. Best-effort: silent on error.
  const prefetchTier = async (tierName: string, signal?: AbortSignal): Promise<void> => {
    if (!manifest) manifest = await loadChunksManifest();
    const tier = manifest.tiers[tierName];
    if (!tier) return;
    let warmed = 0;
    for (const entry of tier.chunks) {
      if (signal?.aborted) return;
      const cacheKey = `${tierName}:${entry.id}`;
      if (chunkCache.has(cacheKey)) continue;

      // Yield to main thread between fetches (don't compete với active render).
      await new Promise<void>((r) => {
        const w = window as unknown as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
        };
        if (w.requestIdleCallback) w.requestIdleCallback(() => r(), { timeout: 500 });
        else setTimeout(r, 50);
      });
      if (signal?.aborted) return;

      try {
        const buffers = await loadChunk(entry, signal, tierName);
        if (signal?.aborted) return;
        chunkCache.set(cacheKey, buffers);
        warmed++;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Best-effort prefetch — silent on transient errors.
      }
    }
    if (warmed > 0) console.info(`[mesh-hex] prefetch ${tierName}: warmed ${warmed} chunks (cache size ${chunkCache.size})`);
  };

  const destroy = (): void => {
    abortController.abort();
    // BLOCKER fix: explicit geom.destroy on every mesh.
    for (const m of meshByKey.values()) destroyMesh(m);
    for (const g of bordersByKey.values()) g.destroy();
    meshByKey.clear();
    bordersByKey.clear();
    clearOldTier(); // Phase 7.9 (A): sweep graveyard on layer destroy.
    inFlightByCache.clear();
    retryNextCull.clear();
    chunkCache.clear();
    shader.destroy();
    root.destroy({ children: true });
  };

  // Phase 8.3: wire cullNow reference for static-viewport rAF retry driver.
  const setCullNow = (fn: () => void): void => {
    cullNowRef = fn;
  };

  /**
   * Phase 8 H3: cold-cache decode stress. Clears ChunkCache, then issues
   * `jobCount` loadChunk() calls back-to-back against the active tier's
   * manifest entries. Returns array of per-job roundtrip latencies in ms.
   * Bench scenario 4 uses this to compute true postMessage roundtrip p95.
   *
   * If no manifest is loaded yet or the active tier is empty, returns [].
   */
  const forceWorkerStress = async (jobCount: number): Promise<{ latencies: number[]; failedCount: number }> => {
    if (!manifest) manifest = await loadChunksManifest();
    if (!currentTierName) return { latencies: [], failedCount: 0 };
    const tier = manifest.tiers[currentTierName];
    if (!tier || tier.chunks.length === 0) return { latencies: [], failedCount: 0 };

    chunkCache.clear();

    const entries = tier.chunks;
    const latencies: number[] = [];
    let failedCount = 0;
    const stressAbort = new AbortController();
    for (let i = 0; i < jobCount; i++) {
      const entry = entries[i % entries.length]!;
      const t0 = performance.now();
      try {
        await loadChunk(entry, stressAbort.signal, currentTierName);
      } catch (err) {
        // Abort on capability fallback or hard error so caller sees a clear signal.
        if (err instanceof DOMException && err.name === 'AbortError') break;
        // Don't fail the whole loop on transient errors — count as failure.
        failedCount++;
        latencies.push(-1);
        continue;
      }
      latencies.push(performance.now() - t0);
    }
    return { latencies, failedCount };
  };

  return {
    root,
    setTier,
    setBordersVisible,
    updateVisibility,
    getStats,
    prefetchTier,
    setCullNow,
    forceWorkerStress,
    destroy,
  };
}
