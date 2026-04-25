/**
 * AI behavior. SPEC Section 6.2.
 *
 * Per AI cycle (every ~0.5s game time = every 2 ticks @ 4Hz), iterate sides
 * sorted by ownerId code (deterministic, Section 8.5 rule 7). Each side:
 *   1. For each owned territory, list adjacent enemies (land + sea).
 *   2. Score each target:
 *        score = (myTroops/theirTroops) * sizeBonus * proximityBonus * (sea ? 0.6 : 1.0)
 *        sizeBonus = 1 / sqrt(target.area)
 *        proximityBonus = 1.2 if target shares ≥ 2 borders with my territories else 1.0
 *   3. If myTroops/theirTroops > 1.3 AND territory not currently attacking elsewhere
 *      AND no Battle exists for this (attacker, defender) pair → create Battle.
 *
 * AI ticks sub-batched in 4 phases by sideIndex % 4 to spread CPU.
 */
import type {
  AdjacencyEdge,
  Battle,
  CountryMeta,
  CountryRuntime,
  SideDerived,
  WorldData,
} from '../data/types';
import { battleId } from './battleId';

const ATTACK_RATIO_THRESHOLD = 1.3;
const SEA_PENALTY = 0.6;
const PROXIMITY_BONUS = 1.2;

export interface AiPlanResult {
  newBattles: Battle[];
}

export function planAiBattles(params: {
  countries: Record<string, CountryRuntime>;
  meta: Record<string, CountryMeta>;
  adjacency: Record<string, Set<string>>;
  edgeType: Record<string, Record<string, 'land' | 'sea'>>;
  sides: Record<string, SideDerived>;
  battles: Battle[];
  tick: number;
}): AiPlanResult {
  const { countries, meta, adjacency, edgeType, sides, battles, tick } = params;

  // Set of attacker territories already in a battle (limit 1 attack/territory).
  const attackingTerritories = new Set<string>();
  for (const b of battles) attackingTerritories.add(b.attacker);

  // Existing (attacker,defender) pairs to dedup.
  const existingPairs = new Set<string>();
  for (const b of battles) existingPairs.add(`${b.attacker}|${b.defender}`);

  const newBattles: Battle[] = [];

  // Sub-batch by tick: each AI cycle every 2 ticks; phase 0..3 handles 25% sides each.
  const phase = (tick >> 1) % 4;
  const sideKeys = Object.keys(sides).sort();

  for (let i = 0; i < sideKeys.length; i++) {
    if (i % 4 !== phase) continue;
    const ownerId = sideKeys[i];
    if (!ownerId) continue;
    const side = sides[ownerId];
    if (!side || side.territoryCodes.length === 0) continue;

    for (const tCode of side.territoryCodes) {
      if (attackingTerritories.has(tCode)) continue;
      const attacker = countries[tCode];
      if (!attacker || attacker.troops <= 1) continue;

      const neighbors = adjacency[tCode];
      if (!neighbors || neighbors.size === 0) continue;

      // Score enemy neighbors
      let bestScore = 0;
      let bestTarget: string | null = null;
      let bestIsSea = false;

      for (const nCode of neighbors) {
        const target = countries[nCode];
        if (!target) continue;
        if (target.ownerId === ownerId) continue; // friendly
        const targetMeta = meta[nCode];
        if (!targetMeta) continue;

        const ratio = attacker.troops / Math.max(1, target.troops);
        if (ratio <= ATTACK_RATIO_THRESHOLD) continue;

        const sizeBonus = 1 / Math.sqrt(Math.max(1, targetMeta.area));
        // Proximity: count how many of attacker side's territories border this target.
        let frontierCount = 0;
        const targetNeighbors = adjacency[nCode];
        if (targetNeighbors) {
          for (const tn of targetNeighbors) {
            if (countries[tn]?.ownerId === ownerId) frontierCount++;
          }
        }
        const proximityBonus = frontierCount >= 2 ? PROXIMITY_BONUS : 1.0;
        const isSea = edgeType[tCode]?.[nCode] === 'sea';
        const seaMul = isSea ? SEA_PENALTY : 1.0;

        const score = ratio * sizeBonus * proximityBonus * seaMul;
        if (score > bestScore) {
          bestScore = score;
          bestTarget = nCode;
          bestIsSea = isSea;
        }
      }

      if (bestTarget) {
        const pair = `${tCode}|${bestTarget}`;
        if (existingPairs.has(pair)) continue;
        const id = battleId(tCode, bestTarget, tick);
        newBattles.push({
          id,
          attacker: tCode,
          defender: bestTarget,
          startTick: tick,
          intensity: 0.3,
          isSeaInvasion: bestIsSea,
        });
        attackingTerritories.add(tCode);
        existingPairs.add(pair);
      }
    }
  }

  return { newBattles };
}

/**
 * Build edgeType lookup from `WorldData.adjacency` + raw edges.
 * Called once at boot inside loadWorld composition (or computed on demand here).
 */
export function buildEdgeType(edges: AdjacencyEdge[]): Record<string, Record<string, 'land' | 'sea'>> {
  const out: Record<string, Record<string, 'land' | 'sea'>> = {};
  for (const [from, to, type] of edges) {
    if (!out[from]) out[from] = {};
    if (!out[to]) out[to] = {};
    out[from][to] = type;
    out[to][from] = type;
  }
  return out;
}

/** Convenience: get edgeType from WorldData if not pre-built. Phase 1b composes adjacency Set; type lookup separate. */
export function deriveEdgeType(world: Pick<WorldData, 'adjacency'>, edges: AdjacencyEdge[]): Record<string, Record<string, 'land' | 'sea'>> {
  void world; // adjacency Set doesn't carry type; use edges directly
  return buildEdgeType(edges);
}
