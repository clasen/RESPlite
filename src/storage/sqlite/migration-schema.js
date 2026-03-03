/**
 * Migration registry schema (SPEC_F §F.5.1).
 * Tables: migration_runs, migration_dirty_keys, migration_errors.
 */

export const MIGRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS migration_runs (
  run_id TEXT PRIMARY KEY,
  source_uri TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,

  scan_cursor TEXT NOT NULL DEFAULT "0",
  scan_count_hint INTEGER NOT NULL DEFAULT 1000,

  scanned_keys INTEGER NOT NULL DEFAULT 0,
  migrated_keys INTEGER NOT NULL DEFAULT 0,
  skipped_keys INTEGER NOT NULL DEFAULT 0,
  error_keys INTEGER NOT NULL DEFAULT 0,
  migrated_bytes INTEGER NOT NULL DEFAULT 0,

  dirty_keys_seen INTEGER NOT NULL DEFAULT 0,
  dirty_keys_applied INTEGER NOT NULL DEFAULT 0,
  dirty_keys_deleted INTEGER NOT NULL DEFAULT 0,

  last_error TEXT
);

CREATE TABLE IF NOT EXISTS migration_dirty_keys (
  run_id TEXT NOT NULL,
  key BLOB NOT NULL,

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  events_count INTEGER NOT NULL DEFAULT 1,

  last_event TEXT,
  state TEXT NOT NULL DEFAULT "dirty",

  PRIMARY KEY (run_id, key)
);

CREATE INDEX IF NOT EXISTS migration_dirty_keys_state_idx
  ON migration_dirty_keys(run_id, state);

CREATE INDEX IF NOT EXISTS migration_dirty_keys_last_seen_idx
  ON migration_dirty_keys(run_id, last_seen_at);

CREATE TABLE IF NOT EXISTS migration_errors (
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  key BLOB,
  stage TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS migration_errors_at_idx ON migration_errors(run_id, at);
`;

/**
 * Apply migration registry schema to database.
 * @param {import('better-sqlite3').Database} db
 */
export function applyMigrationSchema(db) {
  db.exec(MIGRATION_SCHEMA);
}
