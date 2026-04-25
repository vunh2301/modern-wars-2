/**
 * Bench runner. SPEC Section 8.3 + Section 14.1 BenchOutput schema.
 *
 * 3 scenarios:
 *   A — idle world view (zoom 1×, speed 1×, no input)
 *   B — heavy combat (zoom 1×, speed 32×, force-spawn battles via initial state)
 *   C — pan/zoom stress (speed 16×, auto sin oscillate 0.5×↔3×)
 *
 * Each scenario runs 60s real-time, collecting FrameSamples. Emits
 * BenchOutput[] with determinism block (Section 8.5).
 */
import type { BenchOutput, FrameSample } from '../data/types';
import { useGameStore } from '../state/store';
import { computeSimHash } from './simHash';
import { estimateVram } from '../render/textureRegistry';
import { createSampleCollector, percentile } from './samples';

export type BenchScenario = 'idle' | 'combat' | 'panzoom';

export const BENCH_SEED = 'mw2-bench-v1';
const SCENARIO_DURATION_MS = 60_000;

export interface BenchHookContext {
  setSpeed: (s: 1 | 2 | 4 | 8 | 16 | 32 | 64) => void;
  setPaused: (p: boolean) => void;
  setSeed: (seed: string) => void;
  /** Optional viewport hook (Phase 6a) for panzoom scenario. */
  panzoom?: { tick: (now: number) => void };
}

async function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runScenario(
  scenario: BenchScenario,
  ctx: BenchHookContext,
  durationMs: number = SCENARIO_DURATION_MS,
): Promise<BenchOutput> {
  // Reset to deterministic state with bench seed.
  ctx.setSeed(BENCH_SEED);

  // Configure scenario.
  if (scenario === 'idle') {
    ctx.setSpeed(1);
    ctx.setPaused(false);
  } else if (scenario === 'combat') {
    ctx.setSpeed(32);
    ctx.setPaused(false);
  } else {
    ctx.setSpeed(16);
    ctx.setPaused(false);
  }

  const startedAt = new Date().toISOString();
  const collector = createSampleCollector();
  collector.start();

  // panzoom oscillation (sine 0.5↔3 over scenario duration)
  if (scenario === 'panzoom' && ctx.panzoom) {
    let raf = 0;
    const loop = (now: number): void => {
      ctx.panzoom?.tick(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    await waitMs(durationMs);
    cancelAnimationFrame(raf);
  } else {
    await waitMs(durationMs);
  }

  const samples = collector.stop();
  ctx.setPaused(true);

  return computeOutput(scenario, startedAt, samples);
}

function computeOutput(
  scenario: BenchScenario,
  startedAt: string,
  samples: FrameSample[],
): BenchOutput {
  const frameMs = samples.map((s) => s.frameMs);
  const drawCalls = samples.map((s) => s.drawCalls);
  const battleCounts = samples.map((s) => s.battleCount);

  const half = Math.floor(samples.length / 2);
  const first30 = frameMs.slice(0, half);
  const last30 = frameMs.slice(half);

  const p50 = percentile(frameMs, 0.5);
  const p95 = percentile(frameMs, 0.95);
  const p99 = percentile(frameMs, 0.99);

  const heap =
    typeof performance !== 'undefined' && 'memory' in performance
      ? (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize
      : null;

  const state = useGameStore.getState();

  return {
    schemaVersion: 1,
    scenario,
    startedAt,
    device: {
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      dpr: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio ?? 1, 2) : 1,
      screen: {
        w: typeof window !== 'undefined' ? window.innerWidth : 0,
        h: typeof window !== 'undefined' ? window.innerHeight : 0,
      },
    },
    seed: state.rngSeed,
    fps: { p50: 1000 / Math.max(1, p50), p5: 1000 / Math.max(1, p95), p1: 1000 / Math.max(1, p99) },
    frameMs: { p50, p95, p99 },
    frameMsFirst30Win: { p95: percentile(first30, 0.95) },
    frameMsLast30Win: { p95: percentile(last30, 0.95) },
    heapBytes: heap,
    vramEstimateBytes: estimateVram(),
    drawCalls: { p50: percentile(drawCalls, 0.5), p95: percentile(drawCalls, 0.95) },
    battles: { p50: percentile(battleCounts, 0.5), max: battleCounts.length ? Math.max(...battleCounts) : 0 },
    determinism: {
      simHash: computeSimHash(state),
      damageTotal: state.statsDamageTotal,
      captureCount: state.statsCaptureCount,
      winnerCode: state.winner,
      totalTicks: state.tick,
      spiralOfDeathDropped: state.statsSpiralDropped,
    },
  };
}

export async function runAllScenarios(ctx: BenchHookContext): Promise<BenchOutput[]> {
  const out: BenchOutput[] = [];
  for (const sc of ['idle', 'combat', 'panzoom'] as BenchScenario[]) {
    out.push(await runScenario(sc, ctx));
  }
  return out;
}
