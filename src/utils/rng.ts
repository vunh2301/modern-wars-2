/**
 * Seeded PRNG wrapper around `seedrandom`. SPEC Section 8.5 rule 1.
 *
 * `Math.random()` is BANNED in `src/sim/**` and `src/data/**` (ESLint
 * `no-restricted-globals`). Use this module instead.
 */
import seedrandom from 'seedrandom';

export type Rng = () => number;

export function createRng(seed: string): Rng {
  return seedrandom(seed);
}
