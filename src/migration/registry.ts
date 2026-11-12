/**
 * Migration registry access (SPEC_F §F.5).
 * Run metadata, dirty key tracking, and error logging.
 */

import type Database from '../storage/sqlite/driver.ts';

const RUN_STATUS = {
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

/** State of a key in `migration_dirty_keys`. */
export type DirtyKeyState = 'dirty' | 'deleted' | 'applied' | 'skipped' | 'error';

/** Migration step that logged an error. */
export type MigrationErrorStage = 'bulk' | 'dirty_apply' | 'verify';

/** A `migration_runs` row. */
export interface MigrationRun {
  run_id: string;
  source_uri: string;
  started_at: number;
  updated_at: number;
  status: RunStatus;
  scan_cursor: string;
  scan_count_hint: number;
  scanned_keys: number;
  migrated_keys: number;
  skipped_keys: number;
  error_keys: number;
  migrated_bytes: number;
  dirty_keys_seen: number;
  dirty_keys_applied: number;
  dirty_keys_deleted: number;
  last_error: string | null;
}

export interface CreateRunOptions {
  scan_count_hint?: number;
}

export interface CreateRunResult {
  run_id: string;
  created: boolean;
}

/** Bulk import progress fields to persist; omitted fields keep their stored value. */
export interface BulkProgressUpdate {
  scan_cursor?: string;
  scanned_keys?: number;
  migrated_keys?: number;
  skipped_keys?: number;
  error_keys?: number;
  migrated_bytes?: number;
  last_error?: string | null;
}

/** Count of dirty keys per state for a run. */
export type DirtyCounts = Record<DirtyKeyState, number>;

function asBlob(key: Buffer | string): Buffer {
  if (Buffer.isBuffer(key)) return key;
  return Buffer.from(String(key), 'utf8');
}

/**
 * Create a new migration run. Idempotent: if run_id exists, return it.
 */
export function createRun(db: Database, runId: string, sourceUri: string, options: CreateRunOptions = {}): CreateRunResult {
  const { scan_count_hint = 1000 } = options;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO migration_runs (
      run_id, source_uri, started_at, updated_at, status,
      scan_cursor, scan_count_hint,
      scanned_keys, migrated_keys, skipped_keys, error_keys, migrated_bytes,
      dirty_keys_seen, dirty_keys_applied, dirty_keys_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)
    ON CONFLICT(run_id) DO NOTHING
  `);
  stmt.run(runId, sourceUri, now, now, RUN_STATUS.RUNNING, '0', scan_count_hint);
  const created = db.prepare('SELECT changes() as n').get().n > 0;
  if (created) {
    db.prepare('UPDATE migration_runs SET updated_at = ? WHERE run_id = ?').run(now, runId);
  }
  return { run_id: runId, created };
}

export function getRun(db: Database, runId: string): MigrationRun | undefined {
  const row = db.prepare('SELECT * FROM migration_runs WHERE run_id = ?').get(runId);
  return row ? (row instanceof Object ? row : undefined) : undefined;
}

export function setRunStatus(db: Database, runId: string, status: RunStatus): void {
  const now = Date.now();
  db.prepare('UPDATE migration_runs SET status = ?, updated_at = ? WHERE run_id = ?').run(status, now, runId);
}

/**
 * Update bulk import progress (cursor and counters).
 */
export function updateBulkProgress(db: Database, runId: string, updates: BulkProgressUpdate): void {
  const now = Date.now();
  const run = getRun(db, runId);
  if (!run) return;

  const cursor = updates.scan_cursor !== undefined ? String(updates.scan_cursor) : run.scan_cursor;
  const scanned_keys = updates.scanned_keys !== undefined ? updates.scanned_keys : run.scanned_keys;
  const migrated_keys = updates.migrated_keys !== undefined ? updates.migrated_keys : run.migrated_keys;
  const skipped_keys = updates.skipped_keys !== undefined ? updates.skipped_keys : run.skipped_keys;
  const error_keys = updates.error_keys !== undefined ? updates.error_keys : run.error_keys;
  const migrated_bytes = updates.migrated_bytes !== undefined ? updates.migrated_bytes : run.migrated_bytes;
  const last_error = updates.last_error !== undefined ? updates.last_error : run.last_error;

  db.prepare(`
    UPDATE migration_runs SET
      scan_cursor = ?,
      scanned_keys = ?,
      migrated_keys = ?,
      skipped_keys = ?,
      error_keys = ?,
      migrated_bytes = ?,
      last_error = ?,
      updated_at = ?
    WHERE run_id = ?
  `).run(cursor, scanned_keys, migrated_keys, skipped_keys, error_keys, migrated_bytes, last_error ?? null, now, runId);
}

/**
 * Upsert a dirty key (tracker saw an event). State: dirty or deleted per event type (SPEC_F F.6.2, F.6.3).
 * @param event - e.g. "set", "hset", "del", "expired"
 */
export function upsertDirtyKey(db: Database, runId: string, key: Buffer | string, event: string): void {
  const keyBlob = asBlob(key);
  const now = Date.now();
  const isDelete = event === 'del' || event === 'unlink' || event === 'expired';
  const state = isDelete ? 'deleted' : 'dirty';

  const existing = db.prepare('SELECT first_seen_at, state FROM migration_dirty_keys WHERE run_id = ? AND key = ?')
    .get(runId, keyBlob);

  if (existing) {
    // If was deleted but we see a write again, revert to dirty (SPEC_F F.6.3)
    const newState = existing.state === 'deleted' && !isDelete ? 'dirty' : (isDelete ? 'deleted' : 'dirty');
    db.prepare(`
      UPDATE migration_dirty_keys SET
        last_seen_at = ?,
        events_count = events_count + 1,
        last_event = ?,
        state = ?
      WHERE run_id = ? AND key = ?
    `).run(now, event, newState, runId, keyBlob);
  } else {
    db.prepare(`
      INSERT INTO migration_dirty_keys (run_id, key, first_seen_at, last_seen_at, events_count, last_event, state)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(runId, keyBlob, now, now, event, state);
  }

  db.prepare('UPDATE migration_runs SET dirty_keys_seen = dirty_keys_seen + 1, updated_at = ? WHERE run_id = ?')
    .run(now, runId);
}

/**
 * Get a batch of dirty keys for delta apply. ORDER BY last_seen_at ASC, LIMIT.
 * @param state - 'dirty'
 */
export function getDirtyBatch(db: Database, runId: string, state: DirtyKeyState, limit: number): { key: Buffer }[] {
  const rows = db.prepare(`
    SELECT key FROM migration_dirty_keys
    WHERE run_id = ? AND state = ?
    ORDER BY last_seen_at ASC
    LIMIT ?
  `).all(runId, state, limit);
  return rows.map((r) => ({ key: r.key instanceof Buffer ? r.key : Buffer.from(r.key) }));
}

/**
 * Mark a dirty key as applied or deleted and update run counters.
 */
export function markDirtyState(
  db: Database,
  runId: string,
  key: Buffer | string,
  state: 'applied' | 'deleted' | 'skipped' | 'error'
): void {
  const keyBlob = asBlob(key);
  const now = Date.now();
  db.prepare('UPDATE migration_dirty_keys SET state = ? WHERE run_id = ? AND key = ?')
    .run(state, runId, keyBlob);

  if (state === 'applied') {
    db.prepare('UPDATE migration_runs SET dirty_keys_applied = dirty_keys_applied + 1, updated_at = ? WHERE run_id = ?')
      .run(now, runId);
  } else if (state === 'deleted') {
    db.prepare('UPDATE migration_runs SET dirty_keys_deleted = dirty_keys_deleted + 1, updated_at = ? WHERE run_id = ?')
      .run(now, runId);
  }
}

/**
 * Log an error for the run (bounded table; consider retention in production).
 */
export function logError(
  db: Database,
  runId: string,
  stage: MigrationErrorStage,
  message: string,
  key: Buffer | string | null = null
): void {
  const now = Date.now();
  const keyBlob = key != null ? asBlob(key) : null;
  db.prepare('INSERT INTO migration_errors (run_id, at, key, stage, message) VALUES (?, ?, ?, ?, ?)')
    .run(runId, now, keyBlob, stage, message);
}

/**
 * Get count of dirty keys by state for a run.
 */
export function getDirtyCounts(db: Database, runId: string): DirtyCounts {
  const rows = db.prepare(`
    SELECT state, COUNT(*) as n FROM migration_dirty_keys WHERE run_id = ? GROUP BY state
  `).all(runId);
  const out: DirtyCounts = { dirty: 0, applied: 0, deleted: 0, skipped: 0, error: 0 };
  for (const r of rows) {
    out[r.state as DirtyKeyState] = r.n;
  }
  return out;
}

export { RUN_STATUS };
