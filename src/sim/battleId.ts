/**
 * Deterministic Battle ID generator. SPEC Section 4.2.
 *
 * Format: `b-${attacker}-${defender}-${startTick}`
 * NEVER use nanoid (would break Section 8.5 simHash determinism check).
 */
export function battleId(attacker: string, defender: string, startTick: number): string {
  return `b-${attacker}-${defender}-${startTick}`;
}
