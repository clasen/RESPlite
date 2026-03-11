/**
 * Unit tests for bulk migration concurrency behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runBulkImport } from '../../src/migration/bulk.js';
import { tmpDbPath } from '../helpers/tmp.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeRedis(valuesByKey, options = {}) {
  const { getDelayMs = 0 } = options;
  const keys = Object.keys(valuesByKey);

  let inFlightGets = 0;
  let maxInFlightGets = 0;

  return {
    stats: {
      get maxInFlightGets() {
        return maxInFlightGets;
      },
    },

    async scan(cursor) {
      if (Number(cursor) !== 0) return { cursor: 0, keys: [] };
      return { cursor: 0, keys };
    },

    async type(keyName) {
      return Object.prototype.hasOwnProperty.call(valuesByKey, keyName) ? 'string' : 'none';
    },

    async pTTL() {
      return -1;
    },

    async get(keyName) {
      inFlightGets++;
      maxInFlightGets = Math.max(maxInFlightGets, inFlightGets);
      try {
        if (getDelayMs > 0) await sleep(getDelayMs);
        return valuesByKey[keyName];
      } finally {
        inFlightGets--;
      }
    },
  };
}

describe('runBulkImport concurrency', () => {
  it('uses sequential processing by default (concurrency=1)', async () => {
    const redis = makeFakeRedis(
      {
        k1: 'v1',
        k2: 'v2',
        k3: 'v3',
        k4: 'v4',
      },
      { getDelayMs: 10 }
    );

    const run = await runBulkImport(redis, tmpDbPath(), `bulk-seq-${Date.now()}`, {
      sourceUri: 'redis://fake',
      scan_count: 100,
      batch_keys: 1,
    });

    assert.equal(run.status, 'completed');
    assert.equal(run.scanned_keys, 4);
    assert.equal(run.migrated_keys, 4);
    assert.equal(redis.stats.maxInFlightGets, 1);
  });

  it('processes keys concurrently when concurrency is configured', async () => {
    const redis = makeFakeRedis(
      {
        k1: 'v1',
        k2: 'v2',
        k3: 'v3',
        k4: 'v4',
        k5: 'v5',
        k6: 'v6',
        k7: 'v7',
        k8: 'v8',
      },
      { getDelayMs: 20 }
    );

    const run = await runBulkImport(redis, tmpDbPath(), `bulk-concurrent-${Date.now()}`, {
      sourceUri: 'redis://fake',
      scan_count: 100,
      concurrency: 4,
      batch_keys: 2,
    });

    assert.equal(run.status, 'completed');
    assert.equal(run.scanned_keys, 8);
    assert.equal(run.migrated_keys, 8);
    assert.ok(redis.stats.maxInFlightGets > 1, `expected >1 inflight gets, got ${redis.stats.maxInFlightGets}`);
    assert.ok(redis.stats.maxInFlightGets <= 4, `expected <=4 inflight gets, got ${redis.stats.maxInFlightGets}`);
  });

  it('includes ETA/progress fields in onProgress when total estimate is provided', async () => {
    const redis = makeFakeRedis(
      {
        k1: 'v1',
        k2: 'v2',
        k3: 'v3',
        k4: 'v4',
      },
      { getDelayMs: 8 }
    );

    const events = [];
    const run = await runBulkImport(redis, tmpDbPath(), `bulk-eta-${Date.now()}`, {
      sourceUri: 'redis://fake',
      scan_count: 100,
      batch_keys: 1,
      estimated_total_keys: 4,
      onProgress: (r) => events.push(r),
    });

    assert.equal(run.status, 'completed');
    assert.ok(events.length >= 2, `expected at least 2 progress events, got ${events.length}`);

    const withEta = events.filter((e) => e.eta_seconds !== null);
    assert.ok(withEta.length >= 1, 'expected at least one progress event with eta_seconds');

    for (const e of withEta) {
      assert.equal(e.estimated_total_keys, 4);
      assert.ok(e.progress_pct >= 0 && e.progress_pct <= 100, `invalid progress_pct=${e.progress_pct}`);
      assert.ok(e.keys_per_second > 0, `invalid keys_per_second=${e.keys_per_second}`);
      assert.ok(e.elapsed_seconds > 0, `invalid elapsed_seconds=${e.elapsed_seconds}`);
    }

    const last = events.at(-1);
    assert.equal(last.progress_pct, 100);
    assert.equal(last.eta_seconds, 0);
    assert.equal(last.remaining_keys_estimate, 0);
  });
});
