/**
 * Unit tests for migration registry (SPEC_F §F.5).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/storage/sqlite/db.js';
import {
  createRun,
  getRun,
  setRunStatus,
  updateBulkProgress,
  upsertDirtyKey,
  getDirtyBatch,
  markDirtyState,
  getDirtyCounts,
  logError,
  RUN_STATUS,
} from '../../src/migration/registry.js';
import { tmpDbPath } from '../helpers/tmp.js';

describe('migration registry', () => {
  it('createRun inserts a new run and is idempotent', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    const { run_id, created } = createRun(db, 'run_1', 'redis://localhost:6379', { scan_count_hint: 500 });
    assert.equal(run_id, 'run_1');
    assert.equal(created, true);

    const { created: created2 } = createRun(db, 'run_1', 'redis://localhost:6379');
    assert.equal(created2, false);
  });

  it('getRun returns run row', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    createRun(db, 'run_2', 'redis://x:6379');
    const run = getRun(db, 'run_2');
    assert.ok(run);
    assert.equal(run.run_id, 'run_2');
    assert.equal(run.source_uri, 'redis://x:6379');
    assert.equal(run.status, RUN_STATUS.RUNNING);
    assert.equal(run.scan_cursor, '0');
  });

  it('setRunStatus and updateBulkProgress update run', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    createRun(db, 'run_3', 'redis://x:6379');
    setRunStatus(db, 'run_3', RUN_STATUS.PAUSED);
    assert.equal(getRun(db, 'run_3').status, RUN_STATUS.PAUSED);

    updateBulkProgress(db, 'run_3', {
      scan_cursor: '42',
      scanned_keys: 100,
      migrated_keys: 98,
      skipped_keys: 1,
      error_keys: 1,
      migrated_bytes: 5000,
    });
    const run = getRun(db, 'run_3');
    assert.equal(run.scan_cursor, '42');
    assert.equal(run.scanned_keys, 100);
    assert.equal(run.migrated_keys, 98);
    assert.equal(run.migrated_bytes, 5000);
  });

  it('upsertDirtyKey inserts and updates', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    createRun(db, 'run_4', 'redis://x:6379');
    const key = Buffer.from('mykey', 'utf8');

    upsertDirtyKey(db, 'run_4', key, 'set');
    let batch = getDirtyBatch(db, 'run_4', 'dirty', 10);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].key.toString('utf8'), 'mykey');

    upsertDirtyKey(db, 'run_4', 'mykey', 'hset');
    batch = getDirtyBatch(db, 'run_4', 'dirty', 10);
    assert.equal(batch.length, 1);
    const counts = getDirtyCounts(db, 'run_4');
    assert.ok(counts.dirty >= 1);
  });

  it('upsertDirtyKey marks deleted then dirty again', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    createRun(db, 'run_5', 'redis://x:6379');
    upsertDirtyKey(db, 'run_5', 'key1', 'del');
    let batch = getDirtyBatch(db, 'run_5', 'deleted', 10);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].key.toString('utf8'), 'key1');
    const row = db.prepare('SELECT state FROM migration_dirty_keys WHERE run_id = ? AND key = ?').get('run_5', Buffer.from('key1', 'utf8'));
    assert.equal(row.state, 'deleted');

    upsertDirtyKey(db, 'run_5', 'key1', 'set');
    const row2 = db.prepare('SELECT state FROM migration_dirty_keys WHERE run_id = ? AND key = ?').get('run_5', Buffer.from('key1', 'utf8'));
    assert.equal(row2.state, 'dirty');
  });

  it('getDirtyBatch returns keys in state order', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    createRun(db, 'run_6', 'redis://x:6379');
    upsertDirtyKey(db, 'run_6', 'a', 'set');
    upsertDirtyKey(db, 'run_6', 'b', 'set');
    const batch = getDirtyBatch(db, 'run_6', 'dirty', 1);
    assert.equal(batch.length, 1);
    assert.ok(['a', 'b'].includes(batch[0].key.toString('utf8')));
  });

  it('markDirtyState updates state and run counters', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    createRun(db, 'run_7', 'redis://x:6379');
    upsertDirtyKey(db, 'run_7', 'k1', 'set');
    markDirtyState(db, 'run_7', 'k1', 'applied');
    assert.equal(getRun(db, 'run_7').dirty_keys_applied, 1);
    upsertDirtyKey(db, 'run_7', 'k2', 'set');
    markDirtyState(db, 'run_7', 'k2', 'deleted');
    assert.equal(getRun(db, 'run_7').dirty_keys_deleted, 1);
  });

  it('logError inserts into migration_errors', () => {
    const db = openDb(tmpDbPath(), { pragmaTemplate: 'minimal' });
    createRun(db, 'run_8', 'redis://x:6379');
    logError(db, 'run_8', 'bulk', 'test error', Buffer.from('key', 'utf8'));
    const row = db.prepare('SELECT * FROM migration_errors WHERE run_id = ?').get('run_8');
    assert.ok(row);
    assert.equal(row.stage, 'bulk');
    assert.equal(row.message, 'test error');
  });
});
