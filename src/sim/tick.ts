/**
 * Sim scheduler. SPEC Section 8.5 rule 6 (fixed-step accumulator + spiral cap).
 *
 * - Base rate: 4 sim ticks/sec game-time (250ms per tick).
 * - Speed scales game clock at the accumulator (NOT inside subsystems).
 * - Spiral-of-death guard: max 8 sim ticks per render frame in gameplay mode.
 *   Bench mode disables the cap (Section 8.5 rule 6).
 */
import type { CountryMeta, GameSpeed, GameState } from '../data/types';
import { useGameStore } from '../state/store';
import { beginTick } from './tickContext';
import { reinforceTick } from './reinforce';
import { deriveSides } from './sidesDerive';
import { emit } from '../telemetry/emit';

const SIM_HZ = 4;
const SIM_DT_MS = 1000 / SIM_HZ; // 250ms game-time per tick
const SIM_DT_SECONDS = SIM_DT_MS / 1000;
const SPIRAL_CAP_GAMEPLAY = 8;

export type SimRunner = {
  /** Advance accumulator by `dtRealMs` (clamped). Returns ticks executed. */
  step: (dtRealMs: number) => number;
  /** Reset accumulator (e.g. after pause/resume or boot). */
  reset: () => void;
};

export type SimRunnerOptions = {
  meta: Record<string, CountryMeta>;
  /** Disable spiral cap (bench mode only). Section 8.5 rule 6. */
  uncapped?: boolean;
};

export function createSimRunner(opts: SimRunnerOptions): SimRunner {
  let accumulator = 0;

  const reset = (): void => {
    accumulator = 0;
  };

  const step = (dtRealMs: number): number => {
    const state = useGameStore.getState();
    if (state.paused) {
      // Drain accumulator gradually so unpausing doesn't burst N ticks.
      accumulator = 0;
      return 0;
    }

    // Speed scales game-time only at the accumulator (Section 6.1 speed rule).
    const speed: GameSpeed = state.speed;
    accumulator += dtRealMs * speed;

    const cap = opts.uncapped ? Number.POSITIVE_INFINITY : SPIRAL_CAP_GAMEPLAY;
    let executed = 0;
    let dropped = 0;

    while (accumulator >= SIM_DT_MS) {
      if (executed >= cap) {
        // Drop excess (telemetry event, Section 14.4).
        dropped = Math.floor(accumulator / SIM_DT_MS);
        accumulator = 0;
        break;
      }
      runOneTick(opts.meta);
      accumulator -= SIM_DT_MS;
      executed += 1;
    }

    if (dropped > 0) {
      useGameStore.getState().endTick({ droppedSpiralTicks: dropped });
      emit({ type: 'sim-spiral-of-death', dropped });
    }

    return executed;
  };

  return { step, reset };
}

function runOneTick(meta: Record<string, CountryMeta>): void {
  const store = useGameStore.getState();
  const { sides, tick, battles } = store;

  // 1) TickContext snapshot (Section 4.2)
  const ctx = beginTick({ sides, battles, tick });
  void ctx; // Phase 3 combat will read ctx; not used in Phase 2

  // 2) Reinforce (Section 6.1)
  store.mutateCountries((draft) => {
    reinforceTick({
      countries: draft,
      meta,
      sides,
      tick,
      dtGameSeconds: SIM_DT_SECONDS,
    });
  });

  // 3) Re-derive sides + bump version
  const next = deriveSides(useGameStore.getState().countries, meta);
  store.setSides(next);

  // 4) Advance tick + reset stats accumulators per spec
  store.endTick({});
}

/** Test helper — exposed for unit tests. */
export const _internals = { SIM_DT_MS, SIM_DT_SECONDS, SPIRAL_CAP_GAMEPLAY };

/** Read-only state access for use in tests. */
export function getSimState(): GameState {
  return useGameStore.getState();
}
