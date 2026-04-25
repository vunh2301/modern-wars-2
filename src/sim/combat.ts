/**
 * Battle resolution. SPEC Section 6.1.
 *
 * Per tick @ 4Hz base for each active Battle:
 *   attackerRate = 0.02
 *   defenderRate = 0.015
 *   defenderBonus = 1.0 + 0.3 * defender.morale
 *   if isCapitalUnderSiege(defender): defenderBonus *= 1.4
 *   if battle.isSeaInvasion: attackerRate *= 0.7, defenderRate *= 1.3
 *
 *   r1 = rng(); r2 = rng()  // seeded — Section 8.5
 *   damage_to_defender = attacker.troops * attackerRate * (0.8 + 0.4*r1)
 *   damage_to_attacker = defender.troops * defenderRate * defenderBonus * (0.8 + 0.4*r2)
 *
 * Capture (defender.troops <= 0):
 *   defender.ownerId = attacker.ownerId
 *   transferred = floor(attacker.troops * 0.5)
 *   attacker.troops -= transferred; defender.troops = transferred
 *   defender.morale = 0.3
 *   battle resolved (removed)
 */
import type { Battle, CountryRuntime, TickContext } from '../data/types';
import type { Rng } from '../utils/rng';
import { isCapitalUnderSiege } from './tickContext';

const ATTACKER_RATE_BASE = 0.02;
const DEFENDER_RATE_BASE = 0.015;
const SEA_INVASION_ATTACKER_PENALTY = 0.7;
const SEA_INVASION_DEFENDER_BONUS = 1.3;
const CAPITAL_SIEGE_BONUS = 1.4;
const CAPTURED_MORALE = 0.3;
const TRANSFER_RATIO = 0.5;

export interface BattleResolution {
  damageToAttacker: number;
  damageToDefender: number;
  captured: boolean;
  /** True if attacker also reduced to 0 (mutual destruction) — defender wins by default. */
  mutualKill: boolean;
}

export function resolveBattleTick(params: {
  battle: Battle;
  attacker: CountryRuntime;
  defender: CountryRuntime;
  ctx: TickContext;
  rng: Rng;
}): BattleResolution {
  const { battle, attacker, defender, ctx, rng } = params;

  let attackerRate = ATTACKER_RATE_BASE;
  let defenderRate = DEFENDER_RATE_BASE;
  let defenderBonus = 1.0 + 0.3 * defender.morale;

  if (isCapitalUnderSiege(defender.code, ctx, defender.ownerId)) {
    defenderBonus *= CAPITAL_SIEGE_BONUS;
  }
  if (battle.isSeaInvasion) {
    attackerRate *= SEA_INVASION_ATTACKER_PENALTY;
    defenderRate *= SEA_INVASION_DEFENDER_BONUS;
  }

  const r1 = rng();
  const r2 = rng();
  const damageToDefender = attacker.troops * attackerRate * (0.8 + 0.4 * r1);
  const damageToAttacker = defender.troops * defenderRate * defenderBonus * (0.8 + 0.4 * r2);

  defender.troops = Math.max(0, defender.troops - damageToDefender);
  attacker.troops = Math.max(0, attacker.troops - damageToAttacker);
  defender.lastBattleTick = ctx.tick;
  attacker.lastBattleTick = ctx.tick;

  if (defender.troops <= 0 && attacker.troops > 0) {
    // CAPTURE
    defender.ownerId = attacker.ownerId;
    const transferred = Math.floor(attacker.troops * TRANSFER_RATIO);
    attacker.troops -= transferred;
    defender.troops = transferred;
    defender.morale = CAPTURED_MORALE;
    return {
      damageToAttacker,
      damageToDefender,
      captured: true,
      mutualKill: false,
    };
  }

  if (attacker.troops <= 0 && defender.troops <= 0) {
    return { damageToAttacker, damageToDefender, captured: false, mutualKill: true };
  }

  return { damageToAttacker, damageToDefender, captured: false, mutualKill: false };
}

/** Compute intensity per battle tick (drives visual effect, Section 6.1). */
export function computeBattleIntensity(attackerTroops: number, defenderTroops: number): number {
  const engaged = attackerTroops + defenderTroops;
  return Math.max(0.3, Math.min(1.0, 0.3 + Math.log(Math.max(1, engaged)) / 10));
}
