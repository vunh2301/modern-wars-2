/**
 * Frame sample collector. SPEC Section 14.1 FrameSample schema.
 *
 * Polls performance.measure markers each animation frame; aggregates into
 * FrameSample[] consumed by runBench.
 */
import type { FrameSample } from '../data/types';
import { useGameStore } from '../state/store';

export type SampleCollector = {
  start: () => void;
  stop: () => FrameSample[];
  size: () => number;
};

export function createSampleCollector(): SampleCollector {
  let samples: FrameSample[] = [];
  let lastT = 0;
  let raf = 0;
  let running = false;

  const tick = (now: number): void => {
    if (!running) return;
    if (lastT === 0) {
      lastT = now;
      raf = requestAnimationFrame(tick);
      return;
    }
    const frameMs = now - lastT;
    lastT = now;

    const state = useGameStore.getState();
    samples.push({
      t: now,
      frameMs,
      simMs: 0,    // Phase 7 will wire performance.measure hooks
      renderMs: 0,
      reactMs: 0,
      drawCalls: 0,
      battleCount: state.battles.length,
    });
    raf = requestAnimationFrame(tick);
  };

  return {
    start: () => {
      samples = [];
      lastT = 0;
      running = true;
      raf = requestAnimationFrame(tick);
    },
    stop: () => {
      running = false;
      cancelAnimationFrame(raf);
      return samples;
    },
    size: () => samples.length,
  };
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}
