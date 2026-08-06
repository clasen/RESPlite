import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { createCache } from '../../src/cache/cache.js';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Engine strings', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const engine = createEngine({ db });

  it('get missing key returns null', () => {
    assert.equal(engine.get('nonexistent'), null);
  });

  it('set and get', () => {
    engine.set('foo', 'bar');
    const v = engine.get('foo');
    assert.ok(Buffer.isBuffer(v));
    assert.equal(v.toString(), 'bar');
  });

  it('type missing returns none', () => {
    assert.equal(engine.type('missingkey'), 'none');
  });

  it('type string returns string', () => {
    engine.set('k', 'v');
    assert.equal(engine.type('k'), 'string');
  });

  it('del removes key and returns count', () => {
    engine.set('d1', 'x');
    assert.equal(engine.del(['d1']), 1);
    assert.equal(engine.get('d1'), null);
    assert.equal(engine.del(['d1']), 0);
  });

  it('exists returns count', () => {
    engine.set('e1', 'x');
    assert.equal(engine.exists(['e1']), 1);
    assert.equal(engine.exists(['e1', 'e2']), 1);
    engine.set('e2', 'y');
    assert.equal(engine.exists(['e1', 'e2']), 2);
  });

  it('INCR missing key starts at 0 then 1', () => {
    assert.equal(engine.incr('cnt'), 1);
    assert.equal(engine.incr('cnt'), 2);
  });

  it('DECR and INCRBY, DECRBY', () => {
    engine.set('n', '10');
    assert.equal(engine.decr('n'), 9);
    assert.equal(engine.incrby('n', 5), 14);
    assert.equal(engine.decrby('n', 4), 10);
  });
});

describe('Engine string cache', () => {
  function cachedEngine(options = {}) {
    const db = openDb(tmpDbPath());
    const cache = createCache({ enabled: true });
    const engine = createEngine({ db, cache, ...options });
    return { db, cache, engine };
  }

  it('reads through on a miss, then serves a private cached Buffer', () => {
    const db = openDb(tmpDbPath());
    const writer = createEngine({ db });
    writer.set('hot', 'value');

    const cache = createCache({ enabled: true });
    const engine = createEngine({ db, cache });
    const first = engine.get('hot');
    assert.equal(first.toString(), 'value');
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.entries, 1);

    first[0] = 'X'.charCodeAt(0);
    const second = engine.get('hot');
    assert.equal(second.toString(), 'value');
    assert.equal(cache.stats.hits, 1);
    db.close();
  });

  it('keeps SET, INCR and MSET/MGET cache entries coherent', () => {
    const { db, cache, engine } = cachedEngine();
    engine.set('one', '1');
    assert.equal(engine.get('one').toString(), '1');

    engine.set('one', '10');
    assert.equal(engine.get('one').toString(), '10');
    assert.equal(engine.incr('one'), 11);
    assert.equal(engine.get('one').toString(), '11');

    engine.mset(['a', 'A', 'b', 'B']);
    const values = engine.mget(['a', 'b', 'missing']);
    assert.deepEqual(values.map((v) => v?.toString() ?? null), ['A', 'B', null]);
    assert.ok(cache.stats.hits >= 5);
    db.close();
  });

  it('invalidates cached strings on DEL, TTL changes, expiry and PERSIST', () => {
    let now = 1_000;
    const { db, cache, engine } = cachedEngine({ clock: () => now });

    engine.set('deleted', 'value');
    assert.equal(cache.stats.entries, 1);
    assert.equal(engine.del(['deleted']), 1);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.get('deleted'), null);

    engine.set('ttl', 'value');
    assert.equal(engine.expire('ttl', 10), true);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.get('ttl').toString(), 'value');
    assert.equal(engine.persist('ttl'), true);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.get('ttl').toString(), 'value');

    engine.set('short', 'value', { px: 100 });
    assert.equal(engine.get('short').toString(), 'value');
    now += 101;
    assert.equal(engine.get('short'), null);
    assert.equal(engine._keys.get(Buffer.from('short')), null);
    db.close();
  });

  it('invalidates source and destination on RENAME', () => {
    const { db, cache, engine } = cachedEngine();
    engine.set('source', 'new-value');
    engine.set('destination', 'old-value');
    assert.equal(cache.stats.entries, 2);

    engine.rename('source', 'destination');
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.get('source'), null);
    assert.equal(engine.get('destination').toString(), 'new-value');
    db.close();
  });

  it('keeps MSET atomic and MGET returns null for wrong types', () => {
    const { db, engine } = cachedEngine();
    engine.set('string', 'old');
    engine.hset('hash', 'field', 'value');

    assert.throws(
      () => engine.mset(['string', 'new', 'hash', 'invalid']),
      /WRONGTYPE/
    );
    assert.equal(engine.get('string').toString(), 'old');

    const values = engine.mget(['string', 'hash', 'missing']);
    assert.deepEqual(values.map((v) => v?.toString() ?? null), ['old', null, null]);
    db.close();
  });
});
