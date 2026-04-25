/**
 * Memoized selectors over `useGameStore`. SPEC Section 4.2.
 *
 * Selectors must subscribe to version counters (ownershipVersion, troopsVersion,
 * sidesVersion, battlesVersion) — NOT to the underlying Record (would
 * deep-compare every change).
 */
import type { CountryRuntime, SideDerived } from '../data/types';
import { useGameStore } from './store';

export const selectOwnershipVersion = (s: ReturnType<typeof useGameStore.getState>): number => s.ownershipVersion;
export const selectTroopsVersion = (s: ReturnType<typeof useGameStore.getState>): number => s.troopsVersion;
export const selectSidesVersion = (s: ReturnType<typeof useGameStore.getState>): number => s.sidesVersion;
export const selectBattlesVersion = (s: ReturnType<typeof useGameStore.getState>): number => s.battlesVersion;
export const selectTick = (s: ReturnType<typeof useGameStore.getState>): number => s.tick;
export const selectPaused = (s: ReturnType<typeof useGameStore.getState>): boolean => s.paused;
export const selectSpeed = (s: ReturnType<typeof useGameStore.getState>): number => s.speed;
export const selectWinner = (s: ReturnType<typeof useGameStore.getState>): string | null => s.winner;

/**
 * Top-N sides by total troops, sorted desc. Used by Leaderboard (Phase 4).
 * Caller subscribes `sidesVersion`; result memoized externally if needed.
 */
export function topSides(
  sides: Record<string, SideDerived>,
  n = 12,
): SideDerived[] {
  return Object.values(sides)
    .sort((a, b) => b.totalTroops - a.totalTroops)
    .slice(0, n);
}

/** Country owner lookup — for Phase 1b backward-compat. */
export function ownerOfCountry(
  countries: Record<string, CountryRuntime>,
  code: string,
): string | null {
  return countries[code]?.ownerId ?? null;
}

/** Active sides (own >= 1 territory). Used by win-check + AI iteration. */
export function activeSides(sides: Record<string, SideDerived>): string[] {
  return Object.keys(sides)
    .filter((id) => (sides[id]?.territoryCodes.length ?? 0) > 0)
    .sort();
}
