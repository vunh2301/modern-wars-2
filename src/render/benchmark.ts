/**
 * Phase 6 benchmark instrumentation.
 *
 * Collects per-frame FPS samples + per-build chunk durations + tier-switch
 * times. Snapshots aggregated stats via window.__mwBenchmark().
 *
 * Memory API: Chrome-only `performance.memory` (deprecated but functional).
 * Returns 0 on unsupported browsers (Safari, Firefox).
 */
import type { Application } from 'pixi.js';
import type { HexLayer } from './hexLayer';

export interface BenchmarkSnapshot {
  fps_p50: number;
  fps_p95: number;
  fps_p99: number;
  fps_min: number;
  /** Per-direction tier switches recorded so far, e.g. { '50km->25km': 42.3 } in ms. */
  tierSwitchMs: Record<string, number>;
  chunkBuildMs: { p50: number; p95: number; max: number; count: number };
  visibleChunks: { min: number; max: number; avg: number };
  memoryMb: number;
  samples: { fps: number; chunkBuild: number };
}

export interface Benchmark {
  recordTierSwitch(from: string, to: string, durationMs: number): void;
  snapshot(): BenchmarkSnapshot;
  /** Clears FPS / chunk-build / visible-chunks ring buffers (keeps tierSwitchMs). */
  reset(): void;
}

const FPS_BUFFER_MAX = 1800; // 30s @ 60fps
const CHUNK_BUILD_BUFFER_MAX = 500;
const VISIBLE_BUFFER_MAX = 1800;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx]!;
}

export function createBenchmark(app: Application, hexLayer: HexLayer): Benchmark {
  const fpsBuf: number[] = [];
  const chunkBuildBuf: number[] = [];
  const visibleBuf: number[] = [];
  const tierSwitchMs: Record<string, number> = {};

  // Per-frame FPS + visible-chunks sample.
  app.ticker.add(() => {
    const fps = app.ticker.FPS;
    if (fps > 0) {
      fpsBuf.push(fps);
      if (fpsBuf.length > FPS_BUFFER_MAX) fpsBuf.shift();
    }
    const stats = hexLayer.getStats();
    visibleBuf.push(stats.visibleChunks);
    if (visibleBuf.length > VISIBLE_BUFFER_MAX) visibleBuf.shift();
  });

  // Chunk-build durations via PerformanceObserver. measure entry name =
  // 'chunk-build' (set in hexLayer.buildChunkOffset).
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'chunk-build') {
          chunkBuildBuf.push(entry.duration);
          if (chunkBuildBuf.length > CHUNK_BUILD_BUFFER_MAX) chunkBuildBuf.shift();
        }
      }
    });
    observer.observe({ entryTypes: ['measure'] });
  } catch (err) {
    console.warn('[bench] PerformanceObserver unavailable', err);
  }

  const recordTierSwitch = (from: string, to: string, durationMs: number): void => {
    tierSwitchMs[`${from}->${to}`] = Math.round(durationMs * 100) / 100;
  };

  const snapshot = (): BenchmarkSnapshot => {
    const fpsSorted = [...fpsBuf].sort((a, b) => a - b);
    const buildSorted = [...chunkBuildBuf].sort((a, b) => a - b);
    const visibleSum = visibleBuf.reduce((a, b) => a + b, 0);
    const visibleAvg = visibleBuf.length > 0 ? visibleSum / visibleBuf.length : 0;
    const visibleMin = visibleBuf.length > 0 ? Math.min(...visibleBuf) : 0;
    const visibleMax = visibleBuf.length > 0 ? Math.max(...visibleBuf) : 0;

    let memoryMb = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mem = (performance as any).memory;
      if (mem && typeof mem.usedJSHeapSize === 'number') {
        memoryMb = Math.round((mem.usedJSHeapSize / 1024 / 1024) * 10) / 10;
      }
    } catch { /* unsupported browser */ }

    return {
      fps_p50: Math.round(percentile(fpsSorted, 0.50) * 10) / 10,
      fps_p95: Math.round(percentile(fpsSorted, 0.05) * 10) / 10, // p95 = 5th from low
      fps_p99: Math.round(percentile(fpsSorted, 0.01) * 10) / 10,
      fps_min: Math.round((fpsSorted[0] ?? 0) * 10) / 10,
      tierSwitchMs: { ...tierSwitchMs },
      chunkBuildMs: {
        p50: Math.round(percentile(buildSorted, 0.50) * 100) / 100,
        p95: Math.round(percentile(buildSorted, 0.95) * 100) / 100,
        max: Math.round((buildSorted[buildSorted.length - 1] ?? 0) * 100) / 100,
        count: buildSorted.length,
      },
      visibleChunks: {
        min: visibleMin,
        max: visibleMax,
        avg: Math.round(visibleAvg * 10) / 10,
      },
      memoryMb,
      samples: { fps: fpsBuf.length, chunkBuild: chunkBuildBuf.length },
    };
  };

  const reset = (): void => {
    // Phase 6 Iter 1 fix: KEEP chunkBuildBuf so cumulative chunk-build dist
    // survives reset() between scenarios. fpsBuf + visibleBuf cleared so each
    // scenario's percentiles are scenario-local.
    fpsBuf.length = 0;
    visibleBuf.length = 0;
  };

  return { recordTierSwitch, snapshot, reset };
}
