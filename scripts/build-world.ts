/**
 * Build-time world data pipeline. SPEC Section 4.3.
 *
 * Phase 0 STUB — full implementation lands in Phase 1a (worker-a task #2).
 * Currently just emits empty placeholder JSON files so dev/build can run end-to-end.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'public/geo';

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const empty = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, ...extra }, null, 2);

writeFileSync(join(OUT, 'world.json'), empty({ countries: [] }));
writeFileSync(
  join(OUT, 'world.polygons.tier1.json'),
  empty({ tier: 1, countries: {} }),
);
writeFileSync(
  join(OUT, 'world.polygons.tier2.json'),
  empty({ tier: 2, countries: {} }),
);
writeFileSync(
  join(OUT, 'world.borders.tier1.json'),
  empty({
    tier: 1,
    vertices: [],
    indices: [],
    segmentTable: [],
    countryIndexAttribute: [],
    countryIndexAttributeRight: [],
  }),
);
writeFileSync(
  join(OUT, 'world.borders.tier2.json'),
  empty({
    tier: 2,
    vertices: [],
    indices: [],
    segmentTable: [],
    countryIndexAttribute: [],
    countryIndexAttributeRight: [],
  }),
);
writeFileSync(join(OUT, 'adjacency.json'), empty({ edges: [] }));

console.info('[build-world] STUB emitted empty placeholders. Real pipeline in Phase 1a.');
