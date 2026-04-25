/**
 * Schema migration v1 → v2 placeholder. SPEC Section 14.3.
 *
 * Pure function. Returns migrated data + new schemaVersion. No-op MVP since
 * we currently ship schemaVersion: 1 only — first real migration lands here
 * when WorldFile / GameState / etc. introduce a breaking change.
 *
 * Loader behavior contract:
 *   - if loaded.schemaVersion < CODE_KNOWS_VERSION: invoke registered migration
 *   - if loaded.schemaVersion > CODE_KNOWS_VERSION: fail-fast (caller can't
 *     understand newer payload)
 *   - migrations registered in src/data/migrations/index.ts (added at v2)
 */

export function migrateV1toV2<T extends { schemaVersion: 1 }>(input: T): T & { schemaVersion: 2 } {
  // Placeholder: when v2 ships, transform input here.
  return { ...input, schemaVersion: 2 } as T & { schemaVersion: 2 };
}
