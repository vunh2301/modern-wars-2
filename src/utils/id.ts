/**
 * Deterministic ID helpers (SPEC Section 4.2 — battle.id MUST NOT use nanoid).
 */

export function battleId(attacker: string, defender: string, startTick: number): string {
  return `b-${attacker}-${defender}-${startTick}`;
}
