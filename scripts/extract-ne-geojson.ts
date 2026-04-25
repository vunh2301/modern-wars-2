/**
 * One-shot helper: convert Natural Earth shapefile zip (in `vendor/`) to a
 * single GeoJSON committed at `vendor/ne_50m_admin_0_countries.geojson`.
 *
 * Run manually when refreshing the source dataset:
 *   tsx scripts/extract-ne-geojson.ts
 *
 * Build pipeline (`scripts/build-world.ts`) reads ONLY the committed GeoJSON,
 * not the shapefile/zip — so production builds are offline-safe.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import shp from 'shpjs';

const ZIP = 'vendor/ne_50m_admin_0_countries.zip';
const OUT = 'vendor/ne_50m_admin_0_countries.geojson';
const CHECKSUMS = 'vendor/CHECKSUMS.txt';

async function main(): Promise<void> {
  console.info('[extract] reading', ZIP);
  const buf = readFileSync(ZIP);
  // shpjs default export accepts a buffer (zip or raw .shp+.dbf bundle) and
  // returns a Promise<FeatureCollection | FeatureCollection[]>.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (shp as any)(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const fc = Array.isArray(result) ? result[0] : result;
  if (!fc || !fc.features) throw new Error('shpjs returned unexpected payload');

  const json = JSON.stringify(fc);
  writeFileSync(OUT, json);
  const sha = createHash('sha256').update(json).digest('hex');
  writeFileSync(
    CHECKSUMS,
    `# Natural Earth 50m admin0 countries — SHA256 (SPEC Section 4.3 step 1)\n${sha}  ne_50m_admin_0_countries.geojson\n`,
  );
  console.info(`[extract] wrote ${OUT} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
  console.info(`[extract] sha256: ${sha}`);
  console.info(`[extract] features: ${fc.features.length}`);
}

main().catch((e) => {
  console.error('[extract] FAILED', e);
  process.exit(1);
});
