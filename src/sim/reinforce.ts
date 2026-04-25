/**
 * Reinforcement per sim tick. SPEC Section 6.1 reinforcement block.
 *
 * Phase 2 scope: basic reinforcement only (no combat yet — Phase 3).
 *
 * `reinforceRate` = sqrt(area) × 0.1 × homelandBonus × capitalBonus × moraleMult
 *   homelandBonus  = 1.5 if country.code === ownerId else 1.0
 *   capitalBonus   = 1.5 if owner controls a capital country (Section 4.2 sides.capitalCode) else 1.0
 *   moraleMult     = 0.5 + 0.7 * morale  (range 0.5..1.2)
 *
 * Morale recovery toward 1.0 when peaceful (no enemy adjacency, no recent
 * battle within 30 ticks). Phase 2 has no combat, so all countries are
 * "peaceful" and morale trends to 1.0.
 */
import type { CountryMeta, CountryRuntime, GameState, SideDerived } from '../data/types';

const BASE_RATE = 0.1;
const HOMELAND_BONUS = 1.5;
const CAPITAL_BONUS = 1.5;
const MORALE_RECOVERY_PER_SEC = 0.01;
const PEACEFUL_TICKS_THRESHOLD = 30;

export function reinforceTick(params: {
  countries: Record<string, CountryRuntime>;
  meta: Record<string, CountryMeta>;
  sides: Record<string, SideDerived>;
  tick: GameState['tick'];
  dtGameSeconds: number;
}): void {
  const { countries, meta, sides, tick, dtGameSeconds } = params;

  const codes = Object.keys(countries).sort();
  for (const code of codes) {
    const c = countries[code];
    const m = meta[code];
    if (!c || !m) continue;
    const side = sides[c.ownerId];
    const isHomeland = c.code === c.ownerId;
    const homelandBonus = isHomeland ? HOMELAND_BONUS : 1.0;
    const capitalBonus = side?.capitalCode ? CAPITAL_BONUS : 1.0;
    const moraleMult = 0.5 + 0.7 * c.morale;
    const rate = Math.sqrt(Math.max(1, m.area)) * BASE_RATE * homelandBonus * capitalBonus * moraleMult;
    c.reinforceRate = rate;
    c.troops += rate * dtGameSeconds;

    // Morale recovery (peaceful = no recent battle).
    if (tick - c.lastBattleTick > PEACEFUL_TICKS_THRESHOLD) {
      c.morale = Math.min(1, c.morale + MORALE_RECOVERY_PER_SEC * dtGameSeconds);
    }
  }
}
