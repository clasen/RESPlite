import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { createCache } from '../../src/cache/cache.js';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Engine sets', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const engine = createEngine({ db });

  it('SADD and SMEMBERS', () => {
    engine.sadd('tags', 'a', 'b', 'c');
    const members = engine.smembers('tags');
    assert.equal(members.length, 3);
    const strs = members.map((m) => m.toString()).sort();
    assert.deepEqual(strs, ['a', 'b', 'c']);
  });

  it('SREM and empty set removes key', () => {
    engine.sadd('t', 'x');
    assert.equal(engine.srem('t', ['x']), 1);
    assert.equal(engine.type('t'), 'none');
  });

  it('SISMEMBER and SCARD', () => {
    engine.sadd('s', 'a', 'b');
    assert.equal(engine.sismember('s', 'a'), 1);
    assert.equal(engine.sismember('s', 'z'), 0);
    assert.equal(engine.scard('s'), 2);
  });
});

describe('Engine set cache', () => {
  function cachedEngine({ now = 1_000, cacheOptions = {} } = {}) {
    const db = openDb(tmpDbPath());
    const cache = createCache({ enabled: true, ...cacheOptions });
    let currentTime = now;
    const engine = createEngine({ db, cache, clock: () => currentTime });
    return {
      db,
      cache,
      engine,
      advance(ms) { currentTime += ms; },
    };
  }

  it('caches complete sets and serves private copies to all read commands', () => {
    const { db, cache, engine } = cachedEngine();
    engine.sadd('set', 'a', 'b', 'c');
    const first = engine.smembers('set');
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.entries, 1);

    first[0][0] = 'X'.charCodeAt(0);
    assert.deepEqual(engine.smembers('set').map((v) => v.toString()), ['a', 'b', 'c']);
    assert.equal(engine.sismember('set', 'b'), 1);
    assert.equal(engine.sismember('set', 'missing'), 0);
    assert.deepEqual(engine.smismember('set', ['a', 'missing', 'c']), [1, 0, 1]);
    assert.equal(engine.scard('set'), 3);
    const random = engine.srandmember('set');
    assert.ok(['a', 'b', 'c'].includes(random.toString()));
    assert.equal(cache.stats.hits, 6);
    db.close();
  });

  it('invalidates sets after SADD, SREM and SPOP', () => {
    const { db, cache, engine } = cachedEngine();
    engine.sadd('set', 'a', 'b');
    engine.smembers('set');
    engine.sadd('set', 'c');
    assert.equal(cache.stats.entries, 0);

    engine.smembers('set');
    engine.srem('set', ['a']);
    assert.equal(cache.stats.entries, 0);

    engine.smembers('set');
    const popped = engine.spop('set');
    assert.ok(Buffer.isBuffer(popped));
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.scard('set'), 1);
    db.close();
  });

  it('does not cache sets above their member or byte limit', () => {
    const byMembers = cachedEngine({ cacheOptions: { maxSetMembers: 1 } });
    byMembers.engine.sadd('set', 'a', 'b');
    assert.equal(byMembers.engine.smembers('set').length, 2);
    assert.equal(byMembers.cache.stats.entries, 0);
    byMembers.db.close();

    const byBytes = cachedEngine({ cacheOptions: { maxSetBytes: 2 } });
    byBytes.engine.sadd('set', 'abc');
    assert.equal(byBytes.engine.smembers('set')[0].toString(), 'abc');
    assert.equal(byBytes.cache.stats.entries, 0);
    byBytes.db.close();
  });

  it('respects key expiration for cached sets', () => {
    const { db, cache, engine, advance } = cachedEngine();
    engine.sadd('set', 'a');
    assert.equal(engine.pexpire('set', 100), true);
    engine.smembers('set');
    assert.equal(cache.stats.entries, 1);
    advance(101);
    assert.deepEqual(engine.smembers('set'), []);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.type('set'), 'none');
    db.close();
  });
});
