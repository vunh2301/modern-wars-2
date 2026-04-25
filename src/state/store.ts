/**
 * Minimal Zustand store stub for Phase 1b. SPEC Section 4.2.
 *
 * Scope here is intentionally tiny: country ownership map + version counter so
 * the render layer (countryFills, borders) can subscribe on `ownershipVersion`
 * and re-tint without touching geometry. Phase 2 (#4) will replace this with
 * the full GameState shape (battles, sides, sim tick, speed, …).
 */
import { create } from 'zustand';

type OwnershipState = {
  /** Country code → owning side code. Initial = each country owns itself. */
  ownerOf: Record<string, string>;
  /** Bumped on any ownerId change (SPEC Section 4.2 mutation rules). */
  ownershipVersion: number;
  /** Initialise from world.json after boot. */
  initOwnership: (codes: string[]) => void;
  /** Apply a capture event (defender → attacker). */
  capture: (defender: string, attacker: string) => void;
};

export const useOwnership = create<OwnershipState>((set) => ({
  ownerOf: {},
  ownershipVersion: 0,
  initOwnership: (codes) =>
    set(() => {
      const ownerOf: Record<string, string> = {};
      for (const c of codes) ownerOf[c] = c;
      return { ownerOf, ownershipVersion: 1 };
    }),
  capture: (defender, attacker) =>
    set((s) => {
      if (s.ownerOf[defender] === attacker) return s;
      return {
        ownerOf: { ...s.ownerOf, [defender]: attacker },
        ownershipVersion: s.ownershipVersion + 1,
      };
    }),
}));
