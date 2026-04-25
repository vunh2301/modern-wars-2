/**
 * Zustand + immer game store. SPEC Section 4.2 GameState shape.
 *
 * Mutation rules (cứng — Section 4.2):
 *  - In-place mutate via immer producer; never replace `countries` Record.
 *  - Bump version counters per change kind (split for selector specificity).
 *  - Cấm `Map`/`Set` trong store (sim layer scratch only).
 *
 * Selector subscriptions:
 *  - country fill re-tint: subscribe `ownershipVersion` only.
 *  - leaderboard top-12: subscribe `sidesVersion` + memoized derive.
 *  - battle counter / highlight: subscribe `battlesVersion`.
 *  - troop sprite count: subscribe `troopsVersion`.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  Battle,
  CountryRuntime,
  GameSpeed,
  GameState,
  SideDerived,
} from '../data/types';

export type GameStoreActions = {
  /** Reset entire store to a freshly-initialized state (Phase 2 init). */
  init: (params: {
    countries: Record<string, CountryRuntime>;
    sides: Record<string, SideDerived>;
    rngSeed: string;
  }) => void;

  /** Apply per-country mutation in-place. Bumps `troopsVersion` only. */
  mutateCountries: (mutate: (draft: Record<string, CountryRuntime>) => void) => void;

  /** Apply capture event (Section 6.1). Bumps `ownershipVersion`. */
  capture: (defender: string, attacker: string) => void;

  /** Replace `sides` derived state. Bumps `sidesVersion`. */
  setSides: (next: Record<string, SideDerived>) => void;

  /** Push a new battle. Bumps `battlesVersion`. */
  addBattle: (battle: Battle) => void;

  /** Resolve / remove a battle by id. Bumps `battlesVersion`. */
  removeBattle: (id: string) => void;

  /** Bump `tick` and apply per-tick stats accumulators. */
  endTick: (params: {
    droppedSpiralTicks?: number;
    damageAdded?: number;
    captureCount?: number;
  }) => void;

  /** UI controls. */
  togglePause: () => void;
  setPaused: (paused: boolean) => void;
  setSpeed: (speed: GameSpeed) => void;
  setWinner: (code: string | null) => void;
  setRngSeed: (seed: string) => void;
};

const EMPTY_STATE: GameState = {
  schemaVersion: 1,
  countries: {},
  sides: {},
  battles: [],
  tick: 0,
  paused: true,
  speed: 1,
  winner: null,
  rngSeed: 'mw2-default',
  ownershipVersion: 0,
  troopsVersion: 0,
  battlesVersion: 0,
  sidesVersion: 0,
  statsDamageTotal: 0,
  statsCaptureCount: 0,
  statsSpiralDropped: 0,
};

export type GameStore = GameState & GameStoreActions;

export const useGameStore = create<GameStore>()(
  immer((set) => ({
    ...EMPTY_STATE,

    init: ({ countries, sides, rngSeed }) =>
      set((state) => {
        Object.assign(state, EMPTY_STATE);
        state.countries = countries;
        state.sides = sides;
        state.rngSeed = rngSeed;
        state.paused = true;
        state.ownershipVersion = 1;
        state.sidesVersion = 1;
        state.troopsVersion = 1;
      }),

    mutateCountries: (mutate) =>
      set((state) => {
        mutate(state.countries);
        state.troopsVersion += 1;
      }),

    capture: (defender, attacker) =>
      set((state) => {
        const c = state.countries[defender];
        if (!c) return;
        if (c.ownerId === attacker) return;
        c.ownerId = attacker;
        c.morale = 0.3; // Section 6.1 capture rule
        state.ownershipVersion += 1;
        state.statsCaptureCount += 1;
      }),

    setSides: (next) =>
      set((state) => {
        state.sides = next;
        state.sidesVersion += 1;
      }),

    addBattle: (battle) =>
      set((state) => {
        // Idempotent (deterministic ID Section 4.2)
        if (state.battles.some((b) => b.id === battle.id)) return;
        state.battles.push(battle);
        state.battlesVersion += 1;
      }),

    removeBattle: (id) =>
      set((state) => {
        const i = state.battles.findIndex((b) => b.id === id);
        if (i < 0) return;
        state.battles.splice(i, 1);
        state.battlesVersion += 1;
      }),

    endTick: ({ droppedSpiralTicks = 0, damageAdded = 0, captureCount = 0 }) =>
      set((state) => {
        state.tick += 1;
        if (droppedSpiralTicks > 0) state.statsSpiralDropped += droppedSpiralTicks;
        if (damageAdded > 0) state.statsDamageTotal += damageAdded;
        if (captureCount > 0) state.statsCaptureCount += captureCount;
      }),

    togglePause: () => set((state) => { state.paused = !state.paused; }),
    setPaused: (paused) => set((state) => { state.paused = paused; }),
    setSpeed: (speed) => set((state) => { state.speed = speed; }),
    setWinner: (code) => set((state) => { state.winner = code; }),
    setRngSeed: (seed) => set((state) => { state.rngSeed = seed; }),
  })),
);

// ─── Backward-compat shim for Phase 1b code (PixiRoot uses useOwnership) ───
// `useOwnership` API exposes a thin slice over the full store so existing
// render layers from Phase 1b continue to work. New code should subscribe
// directly to `useGameStore` with selectors below.
export const useOwnership = {
  getState: (): {
    ownerOf: Record<string, string>;
    ownershipVersion: number;
    initOwnership: (codes: string[]) => void;
    capture: (defender: string, attacker: string) => void;
  } => {
    const s = useGameStore.getState();
    return {
      ownerOf: Object.fromEntries(
        Object.values(s.countries).map((c) => [c.code, c.ownerId]),
      ),
      ownershipVersion: s.ownershipVersion,
      initOwnership: (codes) => {
        // Lightweight init for Phase 1b layers. Phase 2 init() will replace
        // this with full CountryRuntime + sides bootstrap.
        if (Object.keys(s.countries).length === 0) {
          useGameStore.setState((draft) => {
            for (const c of codes) {
              draft.countries[c] = {
                code: c,
                ownerId: c,
                troops: 0,
                morale: 1,
                reinforceRate: 0,
                lastBattleTick: 0,
              };
            }
            draft.ownershipVersion = 1;
          });
        }
      },
      capture: (defender, attacker) => useGameStore.getState().capture(defender, attacker),
    };
  },
  subscribe: (cb: (state: { ownershipVersion: number }) => void): (() => void) =>
    useGameStore.subscribe((s) => cb({ ownershipVersion: s.ownershipVersion })),
};
