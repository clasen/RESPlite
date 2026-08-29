import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { createCache } from '../../src/cache/cache.js';
import { handleHmset } from '../../src/commands/hmset.js';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Engine hashes', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const engine = createEngine({ db });

  it('HSET and HGET', () => {
    assert.equal(engine.hset('user:1', Buffer.from('name'), Buffer.from('Martin')), 1);
    assert.equal(engine.hset('user:1', Buffer.from('name'), Buffer.from('Martín')), 0);
    assert.equal(engine.hset('user:1', 'name', 'Martin', 'age', '42'), 1);
    assert.equal(engine.hget('user:1', 'name').toString(), 'Martin');
  });

  it('HSET deduplicates fields and keeps the last value', () => {
    assert.equal(engine.hset('duplicates', 'field', 'first', 'field', 'last'), 1);
    assert.equal(engine.hset('duplicates', 'field', 'next', 'field', 'final'), 0);
    assert.equal(engine.hget('duplicates', 'field').toString(), 'final');
    assert.equal(engine.hlen('duplicates'), 1);
  });

  it('HSET supports multi-field writes larger than one SQLite parameter chunk', () => {
    const pairs = Array.from({ length: 300 }, (_, index) => [`f${index}`, `v${index}`]).flat();
    assert.equal(engine.hset('large-write', ...pairs), 300);
    assert.equal(engine.hlen('large-write'), 300);
    assert.equal(engine.hget('large-write', 'f299').toString(), 'v299');
  });

  it('HSETNX sets only absent fields', () => {
    assert.equal(engine.hsetnx('nx', 'field', 'first'), 1);
    assert.equal(engine.hsetnx('nx', 'field', 'second'), 0);
    assert.equal(engine.hget('nx', 'field').toString(), 'first');
  });

  it('HGETALL returns flat array', () => {
    engine.hset('h', 'a', '1', 'b', '2');
    const all = engine.hgetall('h');
    assert.equal(all.length, 4);
    assert.equal(all[0].toString(), 'a');
    assert.equal(all[1].toString(), '1');
    assert.equal(all[2].toString(), 'b');
    assert.equal(all[3].toString(), '2');
  });

  it('HDEL and empty hash removes key', () => {
    engine.hset('tmp', 'x', 'y');
    assert.equal(engine.hdel('tmp', ['x']), 1);
    assert.equal(engine.type('tmp'), 'none');
  });

  it('HINCRBY', () => {
    engine.hset('cnt', 'n', '10');
    assert.equal(engine.hincrby('cnt', 'n', 5), 15);
  });

  it('HINCRBYFLOAT and HSTRLEN', () => {
    engine.hset('float', 'amount', '10.5');
    assert.equal(engine.hincrbyfloat('float', 'amount', '0.25').toString(), '10.75');
    engine.hset('float', 'large', '1e20');
    assert.equal(engine.hincrbyfloat('float', 'large', '9e20').toString(), '1000000000000000000000');
    engine.hset('float', 'small', '0');
    assert.equal(engine.hincrbyfloat('float', 'small', '1e-7').toString(), '0.0000001');
    engine.hset('float', 'binary-rounding', '0.1');
    assert.equal(engine.hincrbyfloat('float', 'binary-rounding', '0.2').toString(), '0.30000000000000004');
    assert.equal(engine.hstrlen('float', 'amount'), 5);
    engine.hset('float', 'binary', Buffer.from([0, 1, 2, 3]));
    assert.equal(engine.hstrlen('float', 'binary'), 4);
    assert.equal(engine.hstrlen('float', 'missing'), 0);
  });

  it('HSCAN filters and paginates fields', () => {
    engine.hset('scan', 'user:3', 'c', 'other', 'x', 'user:1', 'a', 'user:2', 'b');
    const first = engine.hscan('scan', 0, { match: Buffer.from('user:*'), count: 2 });
    assert.equal(first.cursor, 2);
    assert.deepEqual(first.values.map((value) => value.toString()), ['user:1', 'a']);
    const second = engine.hscan('scan', first.cursor, { match: Buffer.from('user:*'), count: 2, noValues: true });
    assert.equal(second.cursor, 4);
    assert.deepEqual(second.values.map((value) => value.toString()), ['user:2', 'user:3']);
    assert.equal(engine.hscan('scan', second.cursor, { count: 2 }).cursor, 0);
  });

  it('HRANDFIELD respects count and WITHVALUES shapes', () => {
    engine.hset('random', 'a', '1', 'b', '2');
    assert.ok(['a', 'b'].includes(engine.hrandfield('random').toString()));
    const distinct = engine.hrandfield('random', 5);
    assert.equal(distinct.length, 2);
    assert.equal(new Set(distinct.map((field) => field.toString())).size, 2);
    assert.equal(engine.hrandfield('random', -4).length, 4);
    assert.equal(engine.hrandfield('random', 2, { withValues: true }).length, 4);
  });

  it('HLEN returns number of fields', () => {
    engine.hset('hlen:u', 'f1', 'v1', 'f2', 'v2', 'f3', 'v3');
    assert.equal(engine.hlen('hlen:u'), 3);
  });

  it('HLEN on non-existent key returns 0', () => {
    assert.equal(engine.hlen('hlen:missing'), 0);
  });

  it('HLEN decreases when fields are deleted', () => {
    engine.hset('hlen:dec', 'a', '1', 'b', '2');
    assert.equal(engine.hlen('hlen:dec'), 2);
    engine.hdel('hlen:dec', ['a']);
    assert.equal(engine.hlen('hlen:dec'), 1);
  });

  it('HLEN throws WRONGTYPE on non-hash key', () => {
    engine.set('hlen:str', 'value');
    assert.throws(() => engine.hlen('hlen:str'), /WRONGTYPE/);
  });
});

describe('Engine hash cache', () => {
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
      clock: () => currentTime,
    };
  }

  it('reads HGETALL through once and returns private Buffer copies', () => {
    const db = openDb(tmpDbPath());
    const writer = createEngine({ db });
    writer.hset('hash', 'field', 'value', 'other', 'second');

    const cache = createCache({ enabled: true });
    const engine = createEngine({ db, cache });
    const first = engine.hgetall('hash');
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.entries, 1);

    first[1][0] = 'X'.charCodeAt(0);
    const second = engine.hgetall('hash');
    assert.equal(second[1].toString(), 'value');
    assert.equal(cache.stats.hits, 1);
    db.close();
  });

  it('serves HGET, HMGET, HLEN, HKEYS, HVALS and HEXISTS from a complete hash entry', () => {
    const { db, cache, engine } = cachedEngine();
    engine.hset('hash', 'a', '1', 'b', '2', 'c', '3');
    engine.hgetall('hash');

    assert.equal(engine.hget('hash', 'b').toString(), '2');
    assert.deepEqual(
      engine.hmget('hash', ['a', 'missing']).map((v) => v?.toString() ?? null),
      ['1', null]
    );
    assert.equal(engine.hlen('hash'), 3);
    assert.deepEqual(engine.hkeys('hash').map((v) => v.toString()), ['a', 'b', 'c']);
    assert.deepEqual(engine.hvals('hash').map((v) => v.toString()), ['1', '2', '3']);
    assert.equal(engine.hexists('hash', 'c'), 1);
    assert.equal(engine.hexists('hash', 'missing'), 0);
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.hits, 7);
    db.close();
  });

  it('invalidates complete hashes after HSET, HDEL and HINCRBY', () => {
    const { db, cache, engine } = cachedEngine();
    engine.hset('hash', 'a', '1', 'b', '2');
    engine.hgetall('hash');
    assert.equal(cache.stats.entries, 1);

    engine.hset('hash', 'a', '10');
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.hgetall('hash')[1].toString(), '10');

    engine.hdel('hash', ['b']);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.hlen('hash'), 1);

    assert.equal(engine.hincrby('hash', 'a', 5), 15);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.hget('hash', 'a').toString(), '15');
    db.close();
  });

  it('integrates HSETNX, HMSET and HINCRBYFLOAT with cache invalidation', () => {
    const { db, cache, engine } = cachedEngine();
    engine.hset('hash', 'amount', '1', 'stable', '2');
    engine.hgetall('hash');

    assert.equal(engine.hsetnx('hash', 'stable', 'ignored'), 0);
    assert.equal(cache.stats.entries, 1);

    assert.equal(engine.hsetnx('hash', 'added', '3'), 1);
    assert.equal(cache.stats.entries, 0);
    engine.hgetall('hash');

    assert.deepEqual(handleHmset(engine, ['hash', 'stable', '4']), { simple: 'OK' });
    assert.equal(cache.stats.entries, 0);
    engine.hgetall('hash');

    assert.equal(engine.hincrbyfloat('hash', 'amount', '0.5').toString(), '1.5');
    assert.equal(cache.stats.entries, 0);
    db.close();
  });

  it('uses cache for HSTRLEN and HRANDFIELD while HSCAN remains storage-paginated', () => {
    const { db, cache, engine } = cachedEngine();
    engine.hset('hash', 'a', 'value-a', 'b', 'value-b');
    engine.hgetall('hash');
    const warmed = cache.stats;

    assert.equal(engine.hstrlen('hash', 'a'), 7);
    assert.equal(cache.stats.hits, warmed.hits + 1);

    const beforeScan = cache.stats;
    assert.equal(engine.hscan('hash', 0, { count: 1 }).values.length, 2);
    assert.equal(cache.stats.hits, beforeScan.hits);
    assert.equal(cache.stats.misses, beforeScan.misses);
    assert.equal(cache.stats.entries, 1);

    const beforeRandom = cache.stats.hits;
    assert.ok(['a', 'b'].includes(engine.hrandfield('hash').toString()));
    assert.equal(cache.stats.hits, beforeRandom + 1);

    engine.hset('cold-random', 'a', '1', 'b', '2');
    const beforePopulate = cache.stats.entries;
    engine.hrandfield('cold-random');
    assert.equal(cache.stats.entries, beforePopulate + 1);
    db.close();
  });

  it('invalidates cache for hash-field expiration writes', () => {
    const { db, cache, engine } = cachedEngine();
    engine.hset('hash', 'field', 'value');
    engine.hgetall('hash');
    assert.equal(cache.stats.entries, 1);

    assert.deepEqual(engine.hexpire('hash', 5_000, ['field']), [1]);
    assert.equal(cache.stats.entries, 0);
    db.close();
  });

  it('keeps cache on TTL reads unless lazy expiration deletes a field', () => {
    const { db, cache, engine, advance, clock } = cachedEngine();
    engine.hset('persistent', 'field', 'value');
    engine.hgetall('persistent');

    assert.deepEqual(engine.httl('persistent', ['field']), [-1]);
    assert.deepEqual(engine.hpttl('persistent', ['field']), [-1]);
    assert.deepEqual(engine.hexpiretime('persistent', ['field']), [-1]);
    assert.deepEqual(engine.hexpiretime('persistent', ['field'], { milliseconds: true }), [-1]);
    assert.equal(cache.stats.entries, 1);

    const writer = createEngine({ db, clock });
    writer.hexpire('persistent', 1_500, ['field']);
    advance(501);

    assert.equal(cache.stats.entries, 1);
    assert.deepEqual(engine.hpttl('persistent', ['field']), [-2]);
    assert.equal(cache.stats.entries, 0);
    db.close();
  });

  it('does not cache hashes with field TTLs and can cache after HPERSIST', () => {
    const { db, cache, engine, advance } = cachedEngine();
    engine.hset('hash', 'expiring', '1', 'stable', '2');
    engine.hgetall('hash');
    assert.equal(cache.stats.entries, 1);

    assert.deepEqual(engine.hexpire('hash', 2_000, ['expiring']), [1]);
    assert.equal(cache.stats.entries, 0);
    engine.hgetall('hash');
    assert.equal(cache.stats.entries, 0);

    advance(1_001);
    assert.deepEqual(
      engine.hgetall('hash').map((v) => v.toString()),
      ['stable', '2']
    );
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.hget('hash', 'expiring'), null); // lazily removes its expired TTL row

    assert.deepEqual(engine.hexpire('hash', 4_000, ['stable']), [1]);
    assert.deepEqual(engine.hpersist('hash', ['stable']), [1]);
    engine.hgetall('hash');
    assert.equal(cache.stats.entries, 1);
    db.close();
  });

  it('DBSIZE excludes a hash whose last field has expired', () => {
    const { db, engine, advance } = cachedEngine();
    engine.hset('expiring-hash', 'field', 'value');
    engine.hexpire('expiring-hash', 1_500, ['field']);
    assert.equal(engine.dbsize(), 1);

    advance(501);

    assert.equal(engine.dbsize(), 0);
    db.close();
  });

  it('does not cache hashes above the configured field limit', () => {
    const { db, cache, engine } = cachedEngine({ cacheOptions: { maxHashFields: 1 } });
    engine.hset('hash', 'a', '1', 'b', '2');
    assert.equal(engine.hgetall('hash').length, 4);
    assert.equal(cache.stats.entries, 0);
    db.close();
  });

  it('does not cache hashes above the configured byte limit', () => {
    const { db, cache, engine } = cachedEngine({ cacheOptions: { maxHashBytes: 4 } });
    engine.hset('hash', 'field', 'value');

    assert.deepEqual(
      engine.hgetall('hash').map((v) => v.toString()),
      ['field', 'value']
    );
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.entries, 0);

    // It remains uncached on subsequent reads instead of silently exceeding
    // the configured memory budget.
    engine.hgetall('hash');
    assert.equal(cache.stats.misses, 2);
    assert.equal(cache.stats.entries, 0);
    db.close();
  });

  it('respects key-level expiration on cached hashes', () => {
    const { db, cache, engine, advance } = cachedEngine();
    engine.hset('hash', 'field', 'value');
    engine.hgetall('hash');
    assert.equal(cache.stats.entries, 1);

    assert.equal(engine.pexpire('hash', 100), true);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.hgetall('hash').length, 2);
    advance(101);
    assert.deepEqual(engine.hgetall('hash'), []);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.type('hash'), 'none');
    db.close();
  });
});

describe('Engine hash field TTL', () => {
  function makeEngine(nowMs) {
    const dbPath = tmpDbPath();
    const db = openDb(dbPath);
    let t = nowMs;
    const clock = () => t;
    const engine = createEngine({ db, clock });
    return {
      engine,
      advance(ms) { t += ms; },
      clock: () => t,
    };
  }

  it('HEXPIRE sets TTL; HTTL reports seconds', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    const res = engine.hexpire('h', engine._clock() + 60_000, [Buffer.from('f1')]);
    assert.deepEqual(res, [1]);
    assert.deepEqual(engine.httl('h', [Buffer.from('f1')]), [60]);
  });

  it('HTTL returns -1 for field without TTL, -2 for missing field/key', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    assert.deepEqual(engine.httl('h', [Buffer.from('f1')]), [-1]);
    assert.deepEqual(engine.httl('h', [Buffer.from('missing')]), [-2]);
    assert.deepEqual(engine.httl('nokey', [Buffer.from('f1')]), [-2]);
  });

  it('HEXPIRE with non-existent field returns -2', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    const res = engine.hexpire('h', engine._clock() + 1000, [Buffer.from('nope')]);
    assert.deepEqual(res, [-2]);
  });

  it('HEXPIRE with expiresAt in the past deletes the field (returns 2)', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1', 'f2', 'v2');
    const res = engine.hexpire('h', engine._clock() - 1, [Buffer.from('f1')]);
    assert.deepEqual(res, [2]);
    assert.equal(engine.hget('h', 'f1'), null);
    assert.equal(engine.hlen('h'), 1);
  });

  it('HEXPIRE NX/XX condition semantics', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 1000, [Buffer.from('f1')], { condition: 'XX' }),
      [0]
    );
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 1000, [Buffer.from('f1')], { condition: 'NX' }),
      [1]
    );
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 2000, [Buffer.from('f1')], { condition: 'NX' }),
      [0]
    );
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 2000, [Buffer.from('f1')], { condition: 'XX' }),
      [1]
    );
  });

  it('HEXPIRE GT/LT condition semantics', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 1000, [Buffer.from('f1')], { condition: 'GT' }),
      [0]
    );
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 1000, [Buffer.from('f1')], { condition: 'LT' }),
      [1]
    );
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 500, [Buffer.from('f1')], { condition: 'GT' }),
      [0]
    );
    assert.deepEqual(
      engine.hexpire('h', engine._clock() + 2000, [Buffer.from('f1')], { condition: 'GT' }),
      [1]
    );
  });

  it('lazy expiration: HGET returns null after TTL; HLEN reflects live count', () => {
    const { engine, advance } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1', 'f2', 'v2');
    engine.hexpire('h', engine._clock() + 1000, [Buffer.from('f1')]);
    assert.equal(engine.hget('h', 'f1').toString(), 'v1');
    assert.equal(engine.hlen('h'), 2);
    advance(2000);
    assert.equal(engine.hget('h', 'f1'), null);
    assert.equal(engine.hlen('h'), 1);
    const all = engine.hgetall('h');
    assert.equal(all.length, 2);
    assert.equal(all[0].toString(), 'f2');
  });

  it('empty hash after lazy expiration removes the key', () => {
    const { engine, advance } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    engine.hexpire('h', engine._clock() + 1000, [Buffer.from('f1')]);
    advance(2000);
    engine.hget('h', 'f1');
    assert.equal(engine.type('h'), 'none');
  });

  it('HSET clears a field TTL', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    engine.hexpire('h', engine._clock() + 5000, [Buffer.from('f1')]);
    assert.deepEqual(engine.httl('h', [Buffer.from('f1')]), [5]);
    engine.hset('h', 'f1', 'v2');
    assert.deepEqual(engine.httl('h', [Buffer.from('f1')]), [-1]);
  });

  it('HINCRBY and HINCRBYFLOAT preserve a field TTL', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'n', '1');
    engine.hexpire('h', engine._clock() + 5000, [Buffer.from('n')]);
    engine.hincrby('h', 'n', 2);
    assert.deepEqual(engine.httl('h', [Buffer.from('n')]), [5]);
    engine.hincrbyfloat('h', 'n', '0.5');
    assert.deepEqual(engine.httl('h', [Buffer.from('n')]), [5]);
  });

  it('HSETNX treats an expired field as absent', () => {
    const { engine, advance } = makeEngine(1_000_000);
    engine.hset('h', 'field', 'old');
    engine.hexpire('h', engine._clock() + 1000, [Buffer.from('field')]);
    advance(2000);
    assert.equal(engine.hsetnx('h', 'field', 'new'), 1);
    assert.equal(engine.hget('h', 'field').toString(), 'new');
    assert.deepEqual(engine.httl('h', [Buffer.from('field')]), [-1]);
  });

  it('reports hash field TTL and expiry in seconds and milliseconds', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'field', 'value', 'persistent', 'value');
    engine.hexpire('h', 1_012_345, [Buffer.from('field')]);
    assert.deepEqual(engine.hpttl('h', [Buffer.from('field')]), [12_345]);
    assert.deepEqual(engine.hexpiretime('h', [Buffer.from('field')]), [1_012]);
    assert.deepEqual(
      engine.hexpiretime('h', [Buffer.from('field')], { milliseconds: true }),
      [1_012_345]
    );
    assert.deepEqual(engine.hexpiretime('h', [Buffer.from('persistent')]), [-1]);
    assert.deepEqual(engine.hexpiretime('h', [Buffer.from('missing')]), [-2]);
  });

  it('HDEL removes field TTL row too (no leak)', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1', 'f2', 'v2');
    engine.hexpire('h', engine._clock() + 5000, [Buffer.from('f1')]);
    engine.hdel('h', ['f1']);
    assert.deepEqual(engine.httl('h', [Buffer.from('f1')]), [-2]);
  });

  it('HPERSIST clears field TTL', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'f1', 'v1');
    engine.hexpire('h', engine._clock() + 5000, [Buffer.from('f1')]);
    assert.deepEqual(engine.hpersist('h', [Buffer.from('f1')]), [1]);
    assert.deepEqual(engine.httl('h', [Buffer.from('f1')]), [-1]);
    assert.deepEqual(engine.hpersist('h', [Buffer.from('f1')]), [-1]);
    assert.deepEqual(engine.hpersist('h', [Buffer.from('nope')]), [-2]);
  });

  it('HEXPIRE on missing hash key returns -2 for each field', () => {
    const { engine } = makeEngine(1_000_000);
    const res = engine.hexpire('nokey', engine._clock() + 1000, [Buffer.from('a'), Buffer.from('b')]);
    assert.deepEqual(res, [-2, -2]);
  });

  it('HEXPIRE against a wrong-type key raises WRONGTYPE', () => {
    const { engine } = makeEngine(1_000_000);
    engine.set('str', 'v');
    assert.throws(
      () => engine.hexpire('str', engine._clock() + 1000, [Buffer.from('x')]),
      /WRONGTYPE/
    );
  });
});
