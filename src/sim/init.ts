/**
 * Initial game state from `WorldData`. SPEC Section 6.4.
 *
 * - Each country = own faction (ownerId === code).
 * - Initial troops = sqrt(area) × 1000 (proportional to size).
 * - Sorted ISO iteration (Section 8.5 rule 7).
 */
import type { CountryRuntime, WorldData } from '../data/types';
import { deriveSides } from './sidesDerive';

const TROOP_SCALE = 1000;
const REINFORCE_SCALE = 0.1;

export function initialCountries(world: WorldData): Record<string, CountryRuntime> {
  const result: Record<string, CountryRuntime> = {};
  const codes = Object.keys(world.countries).sort();
  for (const code of codes) {
    const meta = world.countries[code];
    if (!meta) continue;
    const area = Math.max(1, meta.area);
    const troops = Math.round(Math.sqrt(area) * TROOP_SCALE);
    const reinforceRate = Math.sqrt(area) * REINFORCE_SCALE; // base; multiplied by morale + bonuses Section 6.1
    result[code] = {
      code,
      ownerId: code,
      troops,
      morale: 1,
      reinforceRate,
      lastBattleTick: 0,
    };
  }
  return result;
}

export function initialSides(world: WorldData, countries: Record<string, CountryRuntime>): ReturnType<typeof deriveSides> {
  return deriveSides(countries, world.countries);
}
