/**
 * Mid-game fixture generator. SPEC Section 8.5 rule 4.
 *
 * Phase 0 STUB — emits empty placeholder. Real implementation in Phase 3
 * (after sim/AI exists).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const OUT_DIR = 'bench/baseline-fixtures';
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(`${OUT_DIR}/midgame.json`, JSON.stringify({ schemaVersion: 1, stub: true }, null, 2));
console.info('[build-fixture] STUB — full mid-game snapshot in Phase 3.');
