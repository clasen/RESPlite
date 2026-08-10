import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { createCache } from '../../src/cache/cache.js';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Engine sorted-set cache', () => {
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

  function seed(engine, key = 'zset') {
    engine.zadd(key, [1, 'a', 2, 'b', 2, 'c', 3, 'd']);
  }

  it('caches a complete ZRANGE and serves sorted-set reads with private Buffers', () => {
    const { db, cache, engine } = cachedEngine();
    seed(engine);
    const first = engine.zrange('zset', 0, -1);
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.entries, 1);
    first[0][0] = 'X'.charCodeAt(0);

    assert.deepEqual(engine.zrange('zset', 0, 1).map(String), ['a', 'b']);
    assert.deepEqual(engine.zrevrange('zset', 0, 1, { withScores: true }).map(String), ['d', '3', 'c', '2']);
    assert.equal(engine.zscore('zset', 'b'), '2');
    assert.deepEqual(engine.zmscore('zset', ['a', 'missing', 'd']), ['1', null, '3']);
    assert.equal(engine.zrank('zset', 'c'), 2);
    assert.equal(engine.zrevrank('zset', 'c'), 1);
    assert.equal(engine.zcard('zset'), 4);
    assert.equal(engine.zcount('zset', 2, 3), 3);
    assert.deepEqual(
      engine.zrangebyscore('zset', 2, 3, { withScores: true, offset: 1, limit: 2 }).map(String),
      ['c', '2', 'd', '3']
    );
    assert.deepEqual(
      engine.zrevrangebyscore('zset', 3, 2, { offset: 1, limit: 2 }).map(String),
      ['c', 'b']
    );
    assert.equal(cache.stats.hits, 10);
    db.close();
  });

  it('can populate the same canonical cache from a complete ZREVRANGE', () => {
    const { db, cache, engine } = cachedEngine();
    seed(engine);
    assert.deepEqual(engine.zrevrange('zset', 0, -1).map(String), ['d', 'c', 'b', 'a']);
    assert.equal(cache.stats.entries, 1);
    assert.deepEqual(engine.zrange('zset', 0, -1).map(String), ['a', 'b', 'c', 'd']);
    db.close();
  });

  it('keeps cached rank and score ranges identical to SQLite reads', () => {
    const { db, engine } = cachedEngine();
    seed(engine);
    const rankRanges = [[0, 0], [0, 20], [-2, -1], [100, -1], [-100, -100], [2, 0]];
    const readAll = () => ({
      asc: rankRanges.map(([start, stop]) => engine.zrange('zset', start, stop, { withScores: true }).map(String)),
      desc: rankRanges.map(([start, stop]) => engine.zrevrange('zset', start, stop, { withScores: true }).map(String)),
      score: engine.zrangebyscore('zset', 2, 3, { withScores: true, offset: 1, limit: 2 }).map(String),
      reverseScore: engine.zrevrangebyscore('zset', 3, 2, { withScores: true, offset: 1, limit: 2 }).map(String),
    });
    const uncached = readAll();
    engine.zrange('zset', 0, -1);
    assert.deepEqual(readAll(), uncached);
    db.close();
  });

  it('invalidates sorted sets after every supported mutation', () => {
    const { db, cache, engine } = cachedEngine();
    seed(engine);
    const recache = () => {
      engine.zrange('zset', 0, -1);
      assert.equal(cache.stats.entries, 1);
    };

    recache();
    engine.zadd('zset', [4, 'e']);
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.zrem('zset', ['a']);
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.zincrby('zset', 1, 'b');
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.zremrangebyrank('zset', 0, 0);
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.zremrangebyscore('zset', 4, 4);
    assert.equal(cache.stats.entries, 0);
    assert.deepEqual(engine.zrange('zset', 0, -1, { withScores: true }).map(String), ['b', '3', 'd', '3']);
    db.close();
  });

  it('ZMPOP selects keys in order and invalidates the popped zset cache', () => {
    const { db, cache, engine } = cachedEngine();
    seed(engine, 'second');
    engine.zrange('second', 0, -1);
    assert.equal(cache.stats.entries, 1);

    const result = engine.zmpop(['first', 'second'], 'MAX', 2);
    assert.equal(result[0].toString(), 'second');
    assert.deepEqual(result[1].map((entry) => entry.map(String)), [['d', '3'], ['c', '2']]);
    assert.equal(cache.stats.entries, 0);
    assert.deepEqual(engine.zrange('second', 0, -1).map(String), ['a', 'b']);
    db.close();
  });

  it('does not cache sorted sets above their member or byte limit', () => {
    const byMembers = cachedEngine({ cacheOptions: { maxZsetMembers: 1 } });
    byMembers.engine.zadd('zset', [1, 'a', 2, 'b']);
    assert.equal(byMembers.engine.zrange('zset', 0, -1).length, 2);
    assert.equal(byMembers.cache.stats.entries, 0);
    byMembers.db.close();

    const byBytes = cachedEngine({ cacheOptions: { maxZsetBytes: 2 } });
    byBytes.engine.zadd('zset', [1, 'abc']);
    assert.equal(byBytes.engine.zrange('zset', 0, -1)[0].toString(), 'abc');
    assert.equal(byBytes.cache.stats.entries, 0);
    byBytes.db.close();
  });

  it('respects key expiration for cached sorted sets', () => {
    const { db, cache, engine, advance } = cachedEngine();
    engine.zadd('zset', [1, 'a']);
    assert.equal(engine.pexpire('zset', 100), true);
    engine.zrange('zset', 0, -1);
    assert.equal(cache.stats.entries, 1);
    advance(101);
    assert.deepEqual(engine.zrange('zset', 0, -1), []);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.type('zset'), 'none');
    db.close();
  });
});
