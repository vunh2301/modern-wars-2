/**
 * One-shot: convert NE 10m SHP zip → committed GeoJSON. Run once when
 * vendor/ne_10m_admin_0_countries.zip refreshes. SPEC Section 4.1.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import shp from 'shpjs';

const ZIP = 'vendor/ne_10m_admin_0_countries.zip';
const OUT = 'vendor/ne_10m_admin_0_countries.geojson';

const buf = readFileSync(ZIP);
const result = await shp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const fc = Array.isArray(result) ? result[0] : result;
const json = JSON.stringify(fc);
writeFileSync(OUT, json);
const sha = createHash('sha256').update(json).digest('hex');
appendFileSync('vendor/CHECKSUMS.txt', `${sha}  ne_10m_admin_0_countries.geojson\n`);
console.log(`wrote ${OUT} (${(json.length / 1024 / 1024).toFixed(2)} MB, ${fc.features.length} features)`);
console.log(`sha256: ${sha}`);
