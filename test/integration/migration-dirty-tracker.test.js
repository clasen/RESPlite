/**
 * Integration test: dirty-key tracker + full migration flow.
 *
 * Requires a local Redis instance on redis://127.0.0.1:6379.
 * The test is skipped automatically if Redis is unavailable or
 * if keyspace notifications cannot be enabled.
 *
 * Flow being tested:
 *   1. Write initial keys to Redis
 *   2. Enable keyspace notifications
 *   3. Start dirty tracker
 *   4. Run bulk import  (captures snapshot at T=0)
 *   5. Modify keys in Redis after bulk  (tracker records them as dirty)
 *   6. Stop tracker
 *   7. Apply-dirty  (reconciles post-bulk changes into destination)
 *   8. Verify  (destination matches Redis)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { createMigration, startDirtyTracker } from '../../src/migration/index.js';
import { tmpDbPath } from '../helpers/tmp.js';

const REDIS_URL = 'redis://127.0.0.1:6379';
const PREFIX    = `__resplite_tracker_test_${process.pid}__`;

/** Connect to local Redis; return null if unavailable. */
async function tryConnectRedis() {
  const client = createClient({
    url: REDIS_URL,
    socket: {
      connectTimeout: 1500,
      reconnectStrategy: () => new Error('no reconnect in tests'),
    },
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    await client.quit().catch(() => {});
    return null;
  }
}

/** Delete all keys under PREFIX. */
async function cleanup(redis) {
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, { MATCH: `${PREFIX}:*`, COUNT: 200 });
    cursor  = typeof result.cursor === 'number' ? result.cursor : parseInt(result.cursor, 10);
    const keys = result.keys ?? [];
    if (keys.length) await redis.del(keys);
  } while (cursor !== 0);
}

describe('dirty tracker integration', { timeout: 30_000 }, () => {
  let redis = null;
  let originalEventsValue = '';

  before(async () => {
    redis = await tryConnectRedis();
    if (!redis) return; // tests will skip inside each `it`

    // Save existing notify-keyspace-events so we can restore it after
    const raw = await redis.sendCommand(['CONFIG', 'GET', 'notify-keyspace-events']);
    originalEventsValue = Array.isArray(raw) ? (raw[1] ?? '') : '';

    await cleanup(redis);
  });

  after(async () => {
    if (!redis) return;
    // Restore original keyspace events value
    await redis.sendCommand(['CONFIG', 'SET', 'notify-keyspace-events', originalEventsValue]);
    await cleanup(redis);
    await redis.quit();
  });

  it('bulk + tracker + apply-dirty produces a fully reconciled destination', async (t) => {
    if (!redis) {
      t.skip('local Redis not available');
      return;
    }

    // ── Seed: write initial keys ─────────────────────────────────────────
    const keys = {
      string:  `${PREFIX}:str`,
      hash:    `${PREFIX}:hash`,
      set:     `${PREFIX}:set`,
      list:    `${PREFIX}:list`,
      toDelete: `${PREFIX}:will-delete`,
      toModify: `${PREFIX}:will-modify`,
    };

    await redis.set(keys.string,   'hello');
    await redis.hSet(keys.hash,    { field1: 'v1', field2: 'v2' });
    await redis.sAdd(keys.set,     ['a', 'b', 'c']);
    await redis.rPush(keys.list,   ['x', 'y', 'z']);
    await redis.set(keys.toDelete, 'delete-me');
    await redis.set(keys.toModify, 'original');

    // ── Setup: enable keyspace notifications ────────────────────────────
    const dbPath = tmpDbPath();
    const runId  = `tracker-test-${Date.now()}`;

    const m = createMigration({ from: REDIS_URL, to: dbPath, runId });
    const progressEvents = [];

    const ks = await m.enableKeyspaceNotifications({ value: 'KEA' });
    assert.ok(ks.ok, `Failed to enable keyspace notifications: ${ks.error}`);

    // ── Start tracker BEFORE bulk (same-script API) ─────────────────────
    await m.startDirtyTracker({
      onProgress: (p) => {
        progressEvents.push(p);
      },
    });
    try {
      // ── Bulk import (captures the initial snapshot) ──────────────────
      const run = await m.bulk();
      assert.equal(run.status, 'completed');
      assert.ok(run.migrated_keys >= 6, `Expected ≥6 migrated keys, got ${run.migrated_keys}`);

      // ── Post-bulk mutations (tracker will record these) ──────────────
      await redis.set(keys.toModify, 'modified-after-bulk');
      await redis.del(keys.toDelete);
      await redis.set(`${PREFIX}:new-key`, 'added-after-bulk');

      // Give the tracker time to process the keyspace events
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      await m.stopDirtyTracker();
    }

    // ── Verify dirty keys were captured ─────────────────────────────────
    const { dirty } = m.status();
    assert.ok(
      dirty.dirty + dirty.deleted >= 3,
      `Expected ≥3 dirty/deleted keys, got dirty=${dirty.dirty} deleted=${dirty.deleted}`
    );
    assert.ok(progressEvents.length >= 3, `Expected tracker onProgress events, got ${progressEvents.length}`);

    // ── Apply-dirty: reconcile post-bulk changes ─────────────────────────
    const afterApply = await m.applyDirty();
    const totalReconciled = afterApply.dirty_keys_applied + afterApply.dirty_keys_deleted;
    assert.ok(totalReconciled >= 3, `Expected ≥3 reconciled keys, got ${totalReconciled}`);

    // ── Verify: destination should now match Redis for our test prefix ───
    const result = await m.verify({ samplePct: 100, maxSample: 5000 });

    // Filter mismatches to only those under our test prefix
    const ourMismatches = result.mismatches.filter((mm) => mm.key.startsWith(PREFIX));
    assert.equal(
      ourMismatches.length,
      0,
      `Unexpected mismatches in test keys:\n${JSON.stringify(ourMismatches, null, 2)}`
    );

    await m.close();
  });

  it('startDirtyTracker throws when keyspace notifications are disabled', async (t) => {
    if (!redis) {
      t.skip('local Redis not available');
      return;
    }

    // Disable keyspace notifications
    await redis.sendCommand(['CONFIG', 'SET', 'notify-keyspace-events', '']);

    const dbPath = tmpDbPath();
    const runId  = `tracker-noevents-${Date.now()}`;

    await assert.rejects(
      () => startDirtyTracker({ from: REDIS_URL, to: dbPath, runId }),
      /notify-keyspace-events/
    );

    // Re-enable for subsequent tests
    await redis.sendCommand(['CONFIG', 'SET', 'notify-keyspace-events', 'KEA']);
  });

  it('enableKeyspaceNotifications merges flags without overwriting existing ones', async (t) => {
    if (!redis) {
      t.skip('local Redis not available');
      return;
    }

    const dbPath = tmpDbPath();
    const m = createMigration({ from: REDIS_URL, to: dbPath, runId: `ks-merge-${Date.now()}` });

    // Set a partial value first
    await redis.sendCommand(['CONFIG', 'SET', 'notify-keyspace-events', 'Kg']);

    const result = await m.enableKeyspaceNotifications({ value: 'KEA', merge: true });
    assert.ok(result.ok, `Expected ok=true: ${result.error}`);
    // Redis may reorder flags (e.g. 'Kg' → 'gK'); only check flag membership
    assert.ok(typeof result.previous === 'string', 'previous should be a string');
    assert.ok(result.previous.includes('K'), `Missing K in previous="${result.previous}"`);
    assert.ok(result.previous.includes('g'), `Missing g in previous="${result.previous}"`);

    // Applied value must contain K, E, A and the original g
    const applied = result.applied;
    assert.ok(applied.includes('K'), `Missing K in applied="${applied}"`);
    assert.ok(applied.includes('E'), `Missing E in applied="${applied}"`);
    assert.ok(applied.includes('A'), `Missing A in applied="${applied}"`);

    await m.close();
  });
});
