/**
 * Win condition + tie-break. SPEC Section 6.3.
 *
 * Last side với >= 1 country alive thắng.
 * Tie-break (tick cap): TIE_BREAK_TICKS = 53,760 (= 7min real-time at 32× speed).
 * → side với most territories (tie-break by total troops).
 */
import type { SideDerived } from '../data/types';

export const TIE_BREAK_TICKS = 53_760;

export function checkWinner(sides: Record<string, SideDerived>, tick: number): string | null {
  const active = Object.values(sides).filter((s) => s.territoryCodes.length > 0);
  if (active.length === 1) {
    const winner = active[0];
    return winner ? winner.ownerId : null;
  }
  if (active.length === 0) return null;
  if (tick >= TIE_BREAK_TICKS) {
    // Tie-break: most territories desc, then most troops desc.
    const sorted = [...active].sort((a, b) => {
      const dt = b.territoryCodes.length - a.territoryCodes.length;
      if (dt !== 0) return dt;
      return b.totalTroops - a.totalTroops;
    });
    return sorted[0]?.ownerId ?? null;
  }
  return null;
}
