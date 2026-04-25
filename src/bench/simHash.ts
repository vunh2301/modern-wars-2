/**
 * FNV-1a 64-bit hash của canonical full sim state. SPEC Section 8.5.
 *
 * Canonical encoding (rounded for float-bit stability):
 *   - totalTicks
 *   - winnerCode
 *   - countries sorted by code: [code, ownerId, round(troops), round(morale*1000), lastBattleTick]
 *   - battles sorted by (startTick, attacker, defender) via codepoint compare:
 *     [id, attacker, defender, startTick, round(intensity*1000), isSeaInvasion]
 *   - version counters
 *   - aggregate stats
 *
 * NEVER use localeCompare (Section 8.5 rule 7).
 */
import type { GameState } from '../data/types';

const FNV_OFFSET_LO = 0x84222325;
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_PRIME_LO = 0x000001b3;
const FNV_PRIME_HI = 0x00000100;

/** FNV-1a 64-bit using two-32 lo/hi pair (no BigInt for JIT-friendliness). */
export function fnv1a64(str: string): string {
  let lo = FNV_OFFSET_LO >>> 0;
  let hi = FNV_OFFSET_HI >>> 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    lo = (lo ^ code) >>> 0;
    // 64-bit multiply by FNV_PRIME (lo + hi * 2^32)
    const aLo = lo >>> 16;
    const bLo = lo & 0xffff;
    const aHi = hi >>> 16;
    const bHi = hi & 0xffff;
    const pLo = FNV_PRIME_LO;
    const pHi = FNV_PRIME_HI;
    const r0 = bLo * (pLo & 0xffff);
    const r1 = aLo * (pLo & 0xffff) + bLo * (pLo >>> 16);
    const r2 = aLo * (pLo >>> 16) + bLo * (pHi & 0xffff) + bHi * (pLo & 0xffff);
    const r3 = aHi * (pLo & 0xffff) + bHi * (pLo >>> 16) + aLo * (pHi & 0xffff) + bLo * (pHi >>> 16);
    const newLo = (r0 + ((r1 & 0xffff) << 16)) >>> 0;
    const newHi = ((r1 >>> 16) + r2 + ((r3 & 0xffff) << 16)) >>> 0;
    lo = newLo;
    hi = newHi;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

export function canonicalSimState(state: GameState): string {
  const codes = Object.keys(state.countries).sort();
  const countries = codes.map((c) => {
    const r = state.countries[c]!;
    return [c, r.ownerId, Math.round(r.troops), Math.round(r.morale * 1000), r.lastBattleTick];
  });
  const battles = state.battles
    .slice()
    .sort((a, b) => {
      if (a.startTick !== b.startTick) return a.startTick - b.startTick;
      if (a.attacker !== b.attacker) return a.attacker < b.attacker ? -1 : 1;
      return a.defender < b.defender ? -1 : a.defender > b.defender ? 1 : 0;
    })
    .map((b) => [b.id, b.attacker, b.defender, b.startTick, Math.round(b.intensity * 1000), b.isSeaInvasion]);

  return JSON.stringify({
    totalTicks: state.tick,
    winnerCode: state.winner,
    countries,
    battles,
    counters: {
      ownership: state.ownershipVersion,
      troops: state.troopsVersion,
      battles: state.battlesVersion,
      sides: state.sidesVersion,
    },
    statsAggregate: {
      damageTotal: Math.round(state.statsDamageTotal),
      captureCount: state.statsCaptureCount,
    },
  });
}

export function computeSimHash(state: GameState): string {
  return fnv1a64(canonicalSimState(state));
}
