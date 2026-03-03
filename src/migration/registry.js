/**
 * Migration registry access (SPEC_F §F.5).
 * Run metadata, dirty key tracking, and error logging.
 */

const RUN_STATUS = {
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
};

/**
 * @param {Buffer|string} key
 * @returns {Buffer}
 */
function asBlob(key) {
  if (Buffer.isBuffer(key)) return key;
  return Buffer.from(String(key), 'utf8');
}

/**
 * Create a new migration run. Idempotent: if run_id exists, return it.
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {string} sourceUri
 * @param {object} [options] - scan_count_hint
 * @returns {{ run_id: string, created: boolean }}
 */
export function createRun(db, runId, sourceUri, options = {}) {
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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @returns {Record<string, unknown> | undefined}
 */
export function getRun(db, runId) {
  const row = db.prepare('SELECT * FROM migration_runs WHERE run_id = ?').get(runId);
  return row ? (row instanceof Object ? row : undefined) : undefined;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {'running'|'paused'|'completed'|'failed'|'aborted'} status
 */
export function setRunStatus(db, runId, status) {
  const now = Date.now();
  db.prepare('UPDATE migration_runs SET status = ?, updated_at = ? WHERE run_id = ?').run(status, now, runId);
}

/**
 * Update bulk import progress (cursor and counters).
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {{
 *   scan_cursor?: string;
 *   scanned_keys?: number;
 *   migrated_keys?: number;
 *   skipped_keys?: number;
 *   error_keys?: number;
 *   migrated_bytes?: number;
 *   last_error?: string | null;
 * }} updates
 */
export function updateBulkProgress(db, runId, updates) {
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {Buffer|string} key
 * @param {string} event - e.g. "set", "hset", "del", "expired"
 */
export function upsertDirtyKey(db, runId, key, event) {
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {string} state - 'dirty'
 * @param {number} limit
 * @returns {{ key: Buffer }[]}
 */
export function getDirtyBatch(db, runId, state, limit) {
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {Buffer|string} key
 * @param {'applied'|'deleted'|'skipped'|'error'} state
 */
export function markDirtyState(db, runId, key, state) {
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {string} stage - 'bulk' | 'dirty_apply' | 'verify'
 * @param {string} message
 * @param {Buffer|string|null} [key]
 */
export function logError(db, runId, stage, message, key = null) {
  const now = Date.now();
  const keyBlob = key != null ? asBlob(key) : null;
  db.prepare('INSERT INTO migration_errors (run_id, at, key, stage, message) VALUES (?, ?, ?, ?, ?)')
    .run(runId, now, keyBlob, stage, message);
}

/**
 * Get count of dirty keys by state for a run.
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @returns {Record<string, number>}
 */
export function getDirtyCounts(db, runId) {
  const rows = db.prepare(`
    SELECT state, COUNT(*) as n FROM migration_dirty_keys WHERE run_id = ? GROUP BY state
  `).all(runId);
  const out = { dirty: 0, applied: 0, deleted: 0, skipped: 0, error: 0 };
  for (const r of rows) {
    out[r.state] = r.n;
  }
  return out;
}

export { RUN_STATUS };
