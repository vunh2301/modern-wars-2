/**
 * Countries lookup. SPEC v1.0 Section 4.3.
 *
 * Loads /data/countries.json — the master ID → ISO_A2 + name + nameVi map.
 */

export interface CountryEntry {
  id: number;
  code: string;
  name: string;
  nameVi: string;
  centroid: [number, number];
  bbox: [number, number, number, number];
}

export interface CountriesFile {
  schemaVersion: 1;
  countries: CountryEntry[];
}

let cached: CountriesFile | null = null;
let byId: Map<number, CountryEntry> | null = null;

export async function loadCountries(): Promise<CountriesFile> {
  if (cached) return cached;
  const res = await fetch('/data/countries.json', { credentials: 'omit' });
  if (!res.ok) throw new Error(`countries fetch ${res.status}`);
  const c = (await res.json()) as CountriesFile;
  cached = c;
  byId = new Map(c.countries.map((entry) => [entry.id, entry]));
  return c;
}

export function getCountryById(id: number): CountryEntry | undefined {
  return byId?.get(id);
}
