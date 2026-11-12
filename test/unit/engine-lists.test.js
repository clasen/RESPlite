import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.ts';
import { openDb } from '../../src/storage/sqlite/db.ts';
import { createCache } from '../../src/cache/cache.ts';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Engine lists', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const engine = createEngine({ db });

  it('LPUSH and LLEN', () => {
    engine.lpush('mylist', 'a', 'b', 'c');
    assert.equal(engine.llen('mylist'), 3);
  });

  it('LRANGE returns elements in order', () => {
    const items = engine.lrange('mylist', 0, -1).map((v) => v.toString());
    assert.deepEqual(items, ['c', 'b', 'a']);
  });

  it('LREM count=0 removes all occurrences', () => {
    engine.rpush('lrem1', 'a', 'b', 'a', 'c', 'a');
    const n = engine.lrem('lrem1', 0, 'a');
    assert.equal(n, 3);
    const items = engine.lrange('lrem1', 0, -1).map((v) => v.toString());
    assert.deepEqual(items, ['b', 'c']);
  });

  it('LREM count>0 removes from head', () => {
    engine.rpush('lrem2', 'a', 'b', 'a', 'c', 'a');
    const n = engine.lrem('lrem2', 2, 'a');
    assert.equal(n, 2);
    const items = engine.lrange('lrem2', 0, -1).map((v) => v.toString());
    assert.deepEqual(items, ['b', 'c', 'a']);
  });

  it('LREM count<0 removes from tail', () => {
    engine.rpush('lrem3', 'a', 'b', 'a', 'c', 'a');
    const n = engine.lrem('lrem3', -2, 'a');
    assert.equal(n, 2);
    const items = engine.lrange('lrem3', 0, -1).map((v) => v.toString());
    assert.deepEqual(items, ['a', 'b', 'c']);
  });

  it('LREM on non-existent key returns 0', () => {
    assert.equal(engine.lrem('lrem:missing', 1, 'x'), 0);
  });

  it('LREM with no matches returns 0 and list is unchanged', () => {
    engine.rpush('lrem4', 'x', 'y', 'z');
    assert.equal(engine.lrem('lrem4', 1, 'nope'), 0);
    assert.equal(engine.llen('lrem4'), 3);
  });

  it('LREM removes all elements, key disappears', () => {
    engine.rpush('lrem5', 'x', 'x', 'x');
    engine.lrem('lrem5', 0, 'x');
    assert.equal(engine.type('lrem5'), 'none');
  });

  it('LREM subsequent LRANGE still works correctly', () => {
    engine.rpush('lrem6', 'a', 'b', 'c', 'b', 'd');
    engine.lrem('lrem6', 1, 'b');
    const items = engine.lrange('lrem6', 0, -1).map((v) => v.toString());
    assert.deepEqual(items, ['a', 'c', 'b', 'd']);
  });

  it('LREM throws WRONGTYPE on non-list key', () => {
    engine.set('lrem:str', 'value');
    assert.throws(() => engine.lrem('lrem:str', 1, 'x'), /WRONGTYPE/);
  });

  it('LRANGE clamps bounds the way Redis does', () => {
    engine.rpush('lrange-bounds', 'a', 'b', 'c');
    const range = (start, stop) => engine.lrange('lrange-bounds', start, stop).map(String);
    assert.deepEqual(range(0, -1), ['a', 'b', 'c']);
    assert.deepEqual(range(0, 100), ['a', 'b', 'c']);
    assert.deepEqual(range(1, -2), ['b']);
    assert.deepEqual(range(-100, -100), []);
    assert.deepEqual(range(0, -4), []);
    assert.deepEqual(range(0, -13), []);
    assert.deepEqual(range(3, 5), []);
    assert.deepEqual(range(5, -1), []);
  });

  it('LTRIM clamps bounds the way Redis does', () => {
    const build = (key) => engine.rpush(key, 'a', 'b', 'c');

    build('ltrim-neg-stop');
    engine.ltrim('ltrim-neg-stop', 0, -4);
    assert.equal(engine.type('ltrim-neg-stop'), 'none');

    build('ltrim-start-past-end');
    engine.ltrim('ltrim-start-past-end', 3, 5);
    assert.equal(engine.type('ltrim-start-past-end'), 'none');

    build('ltrim-keep-all');
    engine.ltrim('ltrim-keep-all', -100, 100);
    assert.deepEqual(engine.lrange('ltrim-keep-all', 0, -1).map(String), ['a', 'b', 'c']);

    build('ltrim-tail');
    engine.ltrim('ltrim-tail', 1, -1);
    assert.deepEqual(engine.lrange('ltrim-tail', 0, -1).map(String), ['b', 'c']);
  });
});

describe('Engine list cache', () => {
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

  it('caches complete LRANGE results and serves private copies to list reads', () => {
    const { db, cache, engine } = cachedEngine();
    engine.rpush('list', 'a', 'b', 'c');
    const first = engine.lrange('list', 0, -1);
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.entries, 1);

    first[0][0] = 'X'.charCodeAt(0);
    assert.deepEqual(engine.lrange('list', 0, 1).map((v) => v.toString()), ['a', 'b']);
    assert.equal(engine.lindex('list', -1).toString(), 'c');
    assert.equal(engine.llen('list'), 3);
    assert.equal(cache.stats.hits, 3);
    db.close();
  });

  it('does not populate the list cache from a partial LRANGE', () => {
    const { db, cache, engine } = cachedEngine();
    engine.rpush('list', 'a', 'b', 'c');
    assert.deepEqual(engine.lrange('list', 0, 1).map((v) => v.toString()), ['a', 'b']);
    assert.equal(cache.stats.entries, 0);
    db.close();
  });

  it('keeps cached LRANGE edge cases identical to SQLite reads', () => {
    const { db, engine } = cachedEngine();
    engine.rpush('list', 'a', 'b', 'c');
    const ranges = [[0, 0], [0, 20], [-2, -1], [100, -1], [-100, -100], [2, 0]];
    const uncached = ranges.map(([start, stop]) =>
      engine.lrange('list', start, stop).map((v) => v.toString())
    );
    engine.lrange('list', 0, -1);
    const cached = ranges.map(([start, stop]) =>
      engine.lrange('list', start, stop).map((v) => v.toString())
    );
    assert.deepEqual(cached, uncached);
    db.close();
  });

  it('keeps cached LRANGE stop clamping identical to SQLite reads', () => {
    const { db, engine } = cachedEngine();
    engine.rpush('list', 'a', 'b', 'c');
    const ranges = [[-100, -3], [0, -4], [0, -13], [1, -2], [3, 5], [0, -1]];
    const uncached = ranges.map(([start, stop]) =>
      engine.lrange('list', start, stop).map(String)
    );
    assert.deepEqual(uncached, [['a'], [], [], ['b'], [], ['a', 'b', 'c']]);
    engine.lrange('list', 0, -1);
    const cached = ranges.map(([start, stop]) =>
      engine.lrange('list', start, stop).map(String)
    );
    assert.deepEqual(cached, uncached);
    db.close();
  });

  it('invalidates lists after every supported mutation', () => {
    const { db, cache, engine } = cachedEngine();
    const recache = () => {
      engine.lrange('list', 0, -1);
      assert.equal(cache.stats.entries, 1);
    };

    engine.rpush('list', 'a', 'b', 'c', 'b');
    recache();
    engine.lpush('list', 'head');
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.rpush('list', 'tail');
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.lpop('list');
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.rpop('list');
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.lrem('list', 1, 'b');
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.lset('list', 0, 'changed');
    assert.equal(cache.stats.entries, 0);
    recache();
    engine.ltrim('list', 0, 0);
    assert.equal(cache.stats.entries, 0);
    assert.deepEqual(engine.lrange('list', 0, -1).map((v) => v.toString()), ['changed']);
    db.close();
  });

  it('LMPOP selects keys in order and invalidates the popped list cache', () => {
    const { db, cache, engine } = cachedEngine();
    engine.rpush('second', 'a', 'b', 'c');
    engine.lrange('second', 0, -1);
    assert.equal(cache.stats.entries, 1);

    const result = engine.lmpop(['first', 'second'], 'RIGHT', 2);
    assert.equal(result[0].toString(), 'second');
    assert.deepEqual(result[1].map(String), ['c', 'b']);
    assert.equal(cache.stats.entries, 0);
    assert.deepEqual(engine.lrange('second', 0, -1).map(String), ['a']);
    db.close();
  });

  it('does not cache lists above their item or byte limit', () => {
    const byItems = cachedEngine({ cacheOptions: { maxListItems: 1 } });
    byItems.engine.rpush('list', 'a', 'b');
    assert.equal(byItems.engine.lrange('list', 0, -1).length, 2);
    assert.equal(byItems.cache.stats.entries, 0);
    byItems.db.close();

    const byBytes = cachedEngine({ cacheOptions: { maxListBytes: 2 } });
    byBytes.engine.rpush('list', 'abc');
    assert.equal(byBytes.engine.lrange('list', 0, -1)[0].toString(), 'abc');
    assert.equal(byBytes.cache.stats.entries, 0);
    byBytes.db.close();
  });

  it('respects key expiration for cached lists', () => {
    const { db, cache, engine, advance } = cachedEngine();
    engine.rpush('list', 'a');
    assert.equal(engine.pexpire('list', 100), true);
    engine.lrange('list', 0, -1);
    assert.equal(cache.stats.entries, 1);
    advance(101);
    assert.deepEqual(engine.lrange('list', 0, -1), []);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.type('list'), 'none');
    db.close();
  });
});
