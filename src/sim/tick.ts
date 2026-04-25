/**
 * Sim scheduler. SPEC Section 8.5 rule 6 (fixed-step accumulator + spiral cap).
 *
 * - Base rate: 4 sim ticks/sec game-time (250ms per tick).
 * - Speed scales game clock at the accumulator (NOT inside subsystems).
 * - Spiral-of-death guard: max 8 sim ticks per render frame in gameplay mode.
 *   Bench mode disables the cap (Section 8.5 rule 6).
 *
 * Per-tick pipeline (Phase 3):
 *   1. TickContext snapshot (Section 4.2 race-free helper for combat).
 *   2. AI planner emits new battles (Section 6.2 sub-batched stagger).
 *   3. Resolve every active battle (Section 6.1 damage formulas + capture).
 *   4. Reinforcement for all owned countries.
 *   5. Re-derive sides + bump version.
 *   6. Win-check (Section 6.3 + tie-break TIE_BREAK_TICKS).
 *   7. Advance tick + flush stats.
 */
import type {
  CountryMeta,
  CountryRuntime,
  GameSpeed,
  GameState,
  WorldData,
} from '../data/types';
import { useGameStore } from '../state/store';
import { beginTick } from './tickContext';
import { reinforceTick } from './reinforce';
import { deriveSides } from './sidesDerive';
import { computeBattleIntensity, resolveBattleTick } from './combat';
import { planAiBattles } from './ai';
import { checkWinner } from './winCheck';
import { createRng } from '../utils/rng';
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
  world: WorldData;
  /** Disable spiral cap (bench mode only). Section 8.5 rule 6. */
  uncapped?: boolean;
};

export function createSimRunner(opts: SimRunnerOptions): SimRunner {
  let accumulator = 0;
  // Per-runner RNG seeded from store; re-seeded if store rngSeed changes.
  let lastSeed = useGameStore.getState().rngSeed;
  let rng = createRng(lastSeed);

  const reset = (): void => {
    accumulator = 0;
  };

  const step = (dtRealMs: number): number => {
    const state = useGameStore.getState();
    if (state.paused) {
      accumulator = 0;
      return 0;
    }
    if (state.winner !== null) {
      return 0; // game over
    }

    // Re-seed RNG if seed changed (Settings panel allows seed override).
    if (state.rngSeed !== lastSeed) {
      lastSeed = state.rngSeed;
      rng = createRng(lastSeed);
    }

    const speed: GameSpeed = state.speed;
    accumulator += dtRealMs * speed;

    const cap = opts.uncapped ? Number.POSITIVE_INFINITY : SPIRAL_CAP_GAMEPLAY;
    let executed = 0;
    let dropped = 0;

    while (accumulator >= SIM_DT_MS) {
      if (executed >= cap) {
        dropped = Math.floor(accumulator / SIM_DT_MS);
        accumulator = 0;
        break;
      }
      runOneTick(opts.world, rng);
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

function runOneTick(world: WorldData, rng: () => number): void {
  const store = useGameStore.getState();
  const { sides, tick, battles } = store;
  const meta = world.countries;

  // 1) TickContext snapshot (Section 4.2)
  const ctx = beginTick({ sides, battles, tick });

  // 2) AI plan
  const ai = planAiBattles({
    countries: store.countries,
    meta,
    adjacency: world.adjacency,
    edgeType: world.edgeType,
    sides,
    battles,
    tick,
  });
  for (const b of ai.newBattles) store.addBattle(b);

  // 3) Combat — resolve all battles
  let damageThisTick = 0;
  let capturesThisTick = 0;
  const battlesAfterAi = useGameStore.getState().battles;
  const toRemove: string[] = [];

  store.mutateCountries((draft) => {
    for (const battle of battlesAfterAi) {
      const attacker = draft[battle.attacker];
      const defender = draft[battle.defender];
      if (!attacker || !defender) {
        toRemove.push(battle.id);
        continue;
      }
      // If owners changed (defender captured by other battle in same tick),
      // the snapshot still has previous owner — but resolution uses live state.
      if (attacker.ownerId === defender.ownerId) {
        toRemove.push(battle.id);
        continue;
      }
      const res = resolveBattleTick({ battle, attacker, defender, ctx, rng });
      damageThisTick += res.damageToAttacker + res.damageToDefender;
      battle.intensity = computeBattleIntensity(attacker.troops, defender.troops);
      if (res.captured) {
        capturesThisTick += 1;
        toRemove.push(battle.id);
      } else if (res.mutualKill) {
        toRemove.push(battle.id);
      }
    }
  });

  for (const id of toRemove) store.removeBattle(id);

  // 4) Reinforcement (Section 6.1)
  store.mutateCountries((draft: Record<string, CountryRuntime>) => {
    reinforceTick({
      countries: draft,
      meta,
      sides,
      tick,
      dtGameSeconds: SIM_DT_SECONDS,
    });
  });

  // 5) Re-derive sides
  const next = deriveSides(useGameStore.getState().countries, meta);
  store.setSides(next);

  // 6) Win check
  const winner = checkWinner(next, tick + 1);
  if (winner) store.setWinner(winner);

  // 7) End tick + stats
  store.endTick({ damageAdded: damageThisTick, captureCount: capturesThisTick });
}

/** Test helper — exposed for unit tests. */
export const _internals = { SIM_DT_MS, SIM_DT_SECONDS, SPIRAL_CAP_GAMEPLAY };

/** Read-only state access for use in tests. */
export function getSimState(): GameState {
  return useGameStore.getState();
}

/** Re-export meta for downstream phases. */
export type { CountryMeta };
