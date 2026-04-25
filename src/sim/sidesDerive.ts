/**
 * Derive `sides` from `countries`. SPEC Section 4.2.
 *
 * capitalCode = first sorted-code owned country with `.capital !== null`
 * (deterministic, Section 8.5 rule 7 sorted codepoint order).
 */
import type { CountryMeta, CountryRuntime, SideDerived } from '../data/types';

export function deriveSides(
  countries: Record<string, CountryRuntime>,
  meta: Record<string, CountryMeta>,
): Record<string, SideDerived> {
  const buckets = new Map<string, string[]>();
  const totals = new Map<string, number>();

  // Sorted ISO iteration (Array.prototype.sort, codepoint — Section 8.5 rule 7).
  const codes = Object.keys(countries).sort();
  for (const code of codes) {
    const c = countries[code];
    if (!c) continue;
    const list = buckets.get(c.ownerId) ?? [];
    list.push(code);
    buckets.set(c.ownerId, list);
    totals.set(c.ownerId, (totals.get(c.ownerId) ?? 0) + c.troops);
  }

  const sides: Record<string, SideDerived> = {};
  for (const [ownerId, territoryCodes] of buckets) {
    territoryCodes.sort();
    let capitalCode: string | null = null;
    for (const tc of territoryCodes) {
      if (meta[tc]?.capital) {
        capitalCode = tc;
        break;
      }
    }
    sides[ownerId] = {
      ownerId,
      territoryCodes,
      capitalCode,
      totalTroops: totals.get(ownerId) ?? 0,
    };
  }
  return sides;
}
