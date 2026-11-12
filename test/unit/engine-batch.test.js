import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.ts';
import { openDb } from '../../src/storage/sqlite/db.ts';
import { createCache } from '../../src/cache/cache.ts';

describe('Engine runBatch', () => {
  it('commits every write made inside the batch', () => {
    const db = openDb(':memory:');
    const engine = createEngine({ db, cache: createCache() });
    try {
      engine.runBatch(() => {
        engine.set('a', '1');
        engine.hset('h', 'f', 'v');
      });
      assert.equal(engine.get('a').toString(), '1');
      assert.equal(engine.hget('h', 'f').toString(), 'v');
    } finally {
      db.close();
    }
  });

  it('rolls back the batch and drops cached values written inside it', () => {
    const db = openDb(':memory:');
    const engine = createEngine({ db, cache: createCache() });
    try {
      engine.set('k', 'old');
      assert.equal(engine.get('k').toString(), 'old');
      assert.throws(() => engine.runBatch(() => {
        engine.set('k', 'new');
        engine.set('fresh', 'v');
        throw new Error('boom');
      }), /boom/);
      assert.equal(engine.get('k').toString(), 'old');
      assert.equal(engine.get('fresh'), null);
    } finally {
      db.close();
    }
  });

  it('keeps a failed nested engine transaction from aborting the batch', () => {
    const db = openDb(':memory:');
    const engine = createEngine({ db, cache: createCache() });
    try {
      engine.runBatch(() => {
        engine.set('s', 'text');
        assert.throws(() => engine.lpush('s', 'v'), /WRONGTYPE/);
        engine.set('after', 'ok');
      });
      assert.equal(engine.get('s').toString(), 'text');
      assert.equal(engine.get('after').toString(), 'ok');
    } finally {
      db.close();
    }
  });
});
