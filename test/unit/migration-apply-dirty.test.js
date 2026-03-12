/**
 * Unit tests for dirty apply concurrency/progress behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/storage/sqlite/db.js';
import { runApplyDirty } from '../../src/migration/apply-dirty.js';
import { createRun, upsertDirtyKey, getDirtyCounts } from '../../src/migration/registry.js';
import { tmpDbPath } from '../helpers/tmp.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeRedisStringClient {
  constructor(initialValues, delayMs = 8) {
    this.values = new Map(Object.entries(initialValues));
    this.delayMs = delayMs;
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  async type(key) {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.delayMs);
      return this.values.has(key) ? 'string' : 'none';
    } finally {
      this.inFlight--;
    }
  }

  async pTTL() {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.delayMs);
      return -1;
    } finally {
      this.inFlight--;
    }
  }

  async get(key) {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.delayMs);
      return this.values.get(key) ?? null;
    } finally {
      this.inFlight--;
    }
  }
}

describe('migration apply-dirty', () => {
  it('processes dirty keys with configured concurrency and emits progress payloads', async () => {
    const dbPath = tmpDbPath();
    const runId = `apply-dirty-concurrency-${Date.now()}`;
    const totalKeys = 30;

    const db = openDb(dbPath, { pragmaTemplate: 'minimal' });
    createRun(db, runId, 'redis://x:6379');
    const initialValues = {};
    for (let i = 0; i < totalKeys; i++) {
      const key = `k:${i}`;
      initialValues[key] = `v:${i}`;
      upsertDirtyKey(db, runId, key, 'set');
    }
    db.close();

    const fakeRedis = new FakeRedisStringClient(initialValues);
    const progress = [];

    const run = await runApplyDirty(fakeRedis, dbPath, runId, {
      pragmaTemplate: 'minimal',
      batch_keys: totalKeys,
      concurrency: 8,
      progress_interval_ms: 0,
      onProgress: (r) => progress.push(r),
    });

    assert.equal(run.dirty_keys_applied, totalKeys);
    assert.equal(run.dirty_keys_deleted, 0);
    assert.ok(fakeRedis.maxInFlight > 1, `Expected concurrent calls, maxInFlight=${fakeRedis.maxInFlight}`);
    assert.ok(progress.length >= 1, 'Expected at least one onProgress callback');
    const last = progress[progress.length - 1];
    assert.equal(last.dirty_pending, 0);
    assert.equal(last.dirty_reconciled_total, totalKeys);
    assert.ok(Number.isFinite(last.dirty_keys_per_second));

    const verifyDb = openDb(dbPath, { pragmaTemplate: 'minimal' });
    const counts = getDirtyCounts(verifyDb, runId);
    verifyDb.close();
    assert.equal(counts.dirty, 0);
    assert.equal(counts.deleted, 0);
    assert.equal(counts.applied, totalKeys);
  });
});
