/**
 * Local TickContext — frozen snapshot per sim-tick batch.
 * SPEC Section 4.2 mutation rules: NOT stored in Zustand to avoid
 * reactivity churn + structuredClone allocation.
 *
 * Cost analysis: shallow-spread `sides` Record (~232 ref copies) + frozen
 * `battles` slice. At speed 64× = 256 ticks/s, ~60K ref copies/s — negligible.
 */
import type { Battle, GameState, SideDerived, TickContext } from '../data/types';

export function beginTick(state: Pick<GameState, 'sides' | 'battles' | 'tick'>): TickContext {
  return {
    // Shallow spread (~232 ref copies, no deep clone).
    sidesAtStart: { ...state.sides },
    // Frozen slice — readers can't mutate.
    battlesAtStart: Object.freeze([...state.battles]) as readonly Battle[],
    tick: state.tick,
  };
}

/** Capital-under-siege predicate (Section 6.1 helper, reads tick snapshot). */
export function isCapitalUnderSiege(
  countryCode: string,
  ctx: { sidesAtStart: Record<string, SideDerived>; battlesAtStart: readonly Battle[] },
  ownerId: string,
): boolean {
  const side = ctx.sidesAtStart[ownerId];
  if (!side || side.capitalCode !== countryCode) return false;
  return ctx.battlesAtStart.some((b) => b.defender === countryCode);
}
