import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { createCache } from '../../src/cache/cache.js';
import { tmpDbPath } from '../helpers/tmp.js';
import { handleSet } from '../../src/commands/set.js';
import { handleSetex } from '../../src/commands/setex.js';
import { encode } from '../../src/resp/encoder.js';

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

  it('keeps MSETNX atomic, cache-coherent and aware of expired keys', () => {
    let now = 1_000;
    const { db, cache, engine } = cachedEngine({ clock: () => now });
    engine.set('expires', 'old', { px: 100 });
    engine.set('occupied', 'original');

    assert.equal(engine.msetnx(['blocked', 'value', 'occupied', 'changed']), 0);
    assert.equal(engine.get('blocked'), null);
    assert.equal(engine.get('occupied').toString(), 'original');

    now += 101;
    assert.equal(engine.msetnx(['expires', 'new', 'available', 'value']), 1);
    assert.deepEqual(
      engine.mget(['expires', 'available']).map((value) => value?.toString() ?? null),
      ['new', 'value']
    );
    assert.ok(cache.stats.hits >= 2);
    db.close();
  });

  it('keeps SETNX atomic, cache-coherent and aware of expired keys', () => {
    let now = 1_000;
    const { db, cache, engine } = cachedEngine({ clock: () => now });
    engine.set('expires', 'old', { px: 100 });

    assert.equal(engine.setnx('fresh', 'first'), 1);
    assert.equal(engine.get('fresh').toString(), 'first');
    assert.equal(engine.setnx('fresh', 'second'), 0);
    assert.equal(engine.get('fresh').toString(), 'first');
    assert.equal(engine.setnx('expires', 'new'), 0);

    now += 101;
    assert.equal(engine.setnx('expires', 'new'), 1);
    assert.equal(engine.get('expires').toString(), 'new');
    assert.ok(cache.stats.hits >= 2);
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

  it('flushDatabase deletes persistent values and clears cached entries', () => {
    const { db, cache, engine } = cachedEngine();
    engine.set('one', 'value');
    engine.hset('two', 'field', 'value');
    engine.hgetall('two');
    assert.equal(engine.dbsize(), 2);
    assert.equal(cache.stats.entries, 2);

    engine.flushDatabase();

    assert.equal(engine.dbsize(), 0);
    assert.equal(cache.stats.entries, 0);
    assert.equal(engine.get('one'), null);
    assert.equal(engine.hget('two', 'field'), null);
    db.close();
  });

  it('replaces keys of any type on MSET and MGET returns null for wrong types', () => {
    const { db, engine } = cachedEngine();
    engine.set('string', 'old');
    engine.hset('hash', 'field', 'value');

    engine.mset(['string', 'new', 'hash', 'invalid']);
    assert.equal(engine.get('string').toString(), 'new');
    assert.equal(engine.get('hash').toString(), 'invalid');
    assert.equal(engine.type('hash'), 'string');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redis_hashes WHERE key = ?').get(Buffer.from('hash')).n, 0);
    assert.throws(() => engine.hget('hash', 'field'), /WRONGTYPE/);

    engine.hset('other', 'field', 'value');
    const values = engine.mget(['string', 'other', 'missing']);
    assert.deepEqual(values.map((v) => v?.toString() ?? null), ['new', null, null]);
    db.close();
  });

  it('replaces a key of any type on SET and SETEX and keeps numeric mutations strict', () => {
    const { db, engine } = cachedEngine({ clock: () => 1_000_000 });
    engine.hset('hash', 'field', 'value');

    engine.set('hash', 'string');
    assert.equal(engine.get('hash').toString(), 'string');
    assert.equal(engine.type('hash'), 'string');

    engine.rpush('list', 'a');
    engine.set('list', 'string', { ex: 100 });
    assert.equal(engine.type('list'), 'string');
    assert.equal(engine.ttl('list'), 100);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redis_list_items WHERE key = ?').get(Buffer.from('list')).n, 0);

    engine.set('counter', 'abc');
    assert.throws(() => engine.incr('counter'), /not an integer/);
    db.close();
  });

  it('keeps the previous key TTL when SET KEEPTTL replaces another type', () => {
    const { db, engine } = cachedEngine({ clock: () => 1_000_000 });
    engine.hset('hash', 'field', 'value');
    engine.expire('hash', 100);

    assert.equal(engine.set('hash', 'string', { keepttl: true }).written, true);
    assert.equal(engine.type('hash'), 'string');
    assert.equal(engine.ttl('hash'), 100);
    db.close();
  });

  it('uses the last value when MSET or MSETNX repeats an absent key', () => {
    const { db, engine } = cachedEngine();

    engine.mset(['mset:duplicate', 'first', 'mset:duplicate', 'last']);
    assert.equal(engine.get('mset:duplicate').toString(), 'last');

    assert.equal(engine.msetnx(['msetnx:duplicate', 'first', 'msetnx:duplicate', 'last']), 1);
    assert.equal(engine.get('msetnx:duplicate').toString(), 'last');
    db.close();
  });

  it('SET with NX and XX reports the write and keeps the winning value', () => {
    const { db, cache, engine } = cachedEngine();

    assert.deepEqual(engine.set('nx', 'first', { nx: true }), { written: true, previous: null });
    assert.deepEqual(engine.set('nx', 'second', { nx: true }), { written: false, previous: null });
    assert.equal(engine.get('nx').toString(), 'first');

    assert.deepEqual(engine.set('nx', 'second', { xx: true }), { written: true, previous: null });
    assert.equal(engine.get('nx').toString(), 'second');

    assert.deepEqual(engine.set('absent', 'value', { xx: true }), { written: false, previous: null });
    assert.equal(engine.get('absent'), null);
    assert.ok(cache.stats.hits >= 2);
    db.close();
  });

  it('SET with GET returns the previous value including when the write is skipped', () => {
    const { db, cache, engine } = cachedEngine();

    assert.equal(engine.set('get', 'value', { get: true }).previous, null);
    assert.equal(engine.get('get').toString(), 'value');

    const replaced = engine.set('get', 'next', { get: true });
    assert.equal(replaced.written, true);
    assert.equal(replaced.previous.toString(), 'value');

    const skipped = engine.set('get', 'ignored', { get: true, nx: true });
    assert.equal(skipped.written, false);
    assert.equal(skipped.previous.toString(), 'next');
    assert.equal(engine.get('get').toString(), 'next');
    assert.equal(engine.set('get', 'val', { get: true, xx: true }).previous.toString(), 'next');
    assert.equal(engine.get('get').toString(), 'val');
    assert.ok(cache.stats.hits >= 3);
    db.close();
  });

  it('SET with GET fails on a wrong-type key even when NX would skip the write', () => {
    const { db, engine } = cachedEngine();
    engine.hset('hash', 'field', 'value');

    assert.throws(() => engine.set('hash', 'string', { get: true }), /WRONGTYPE/);
    assert.throws(() => engine.set('hash', 'string', { get: true, nx: true }), /WRONGTYPE/);
    assert.throws(() => engine.set('hash', 'string', { get: true, xx: true }), /WRONGTYPE/);
    assert.equal(engine.set('hash', 'string', { nx: true }).written, false);
    assert.equal(engine.hget('hash', 'field').toString(), 'value');
    db.close();
  });

  it('SET applies EXAT, PXAT and KEEPTTL to the stored expiration', () => {
    let now = 1_000_000;
    const { db, engine } = cachedEngine({ clock: () => now });

    engine.set('exat', 'value', { exat: Math.floor(now / 1000) + 10 });
    assert.equal(engine.ttl('exat'), 10);

    engine.set('pxat', 'value', { pxat: now + 10_000 });
    assert.equal(engine.ttl('pxat'), 10);

    engine.set('kept', 'value', { ex: 100 });
    engine.set('kept', 'next', { keepttl: true });
    assert.equal(engine.ttl('kept'), 100);
    assert.equal(engine.get('kept').toString(), 'next');

    engine.set('next', 'value', { ex: 100 });
    engine.set('next', 'plain');
    assert.equal(engine.ttl('next'), -1);

    engine.set('next', 'value', { ex: 100 });
    engine.set('next', 'xx', { xx: true });
    assert.equal(engine.ttl('next'), -1);

    engine.set('expired', 'value', { exat: 1 });
    assert.equal(engine.exists(['expired']), 0);
    db.close();
  });

  it('SETNX delegates to SET NX without overwriting an existing key', () => {
    const { db, engine } = cachedEngine();

    assert.equal(engine.setnx('legacy', 'first'), 1);
    assert.equal(engine.setnx('legacy', 'second'), 0);
    assert.equal(engine.get('legacy').toString(), 'first');
    db.close();
  });

  it('rejects expiry overflow before NX/XX checks without changing value or TTL', () => {
    const { db, engine } = cachedEngine({ clock: () => 1000 });
    try {
      engine.set('key', 'old', { px: 10000 });
      const args = (...items) => items.map((item) => Buffer.from(item));
      for (const option of ['EX', 'PX', 'EXAT']) {
        for (const condition of ['NX', 'XX']) {
          const reply = handleSet(engine, args('key', 'new', option, '9223372036854775807', condition));
          assert.equal(reply.error, "ERR invalid expire time in 'set' command");
          assert.equal(engine.get('key').toString(), 'old');
          assert.equal(engine.pttl('key'), 10000);
        }
      }
      assert.equal(handleSet(engine, args('key', 'new', 'PXAT', '9223372036854775808')).error,
        'ERR value is not an integer or out of range');
      assert.equal(engine.get('key').toString(), 'old');
    } finally { db.close(); }
  });

  it('preserves full-width expirations through KEEPTTL, rename, reopen and RESP encoding', () => {
    const path = tmpDbPath();
    const db = openDb(path);
    const engine = createEngine({ db, clock: () => 1000 });
    const max = 9223372036854775807n;
    try {
      for (const [option, amount, expiration] of [
        ['pxat', max, max], ['px', max - 1000n, max],
        ['exat', max / 1000n, max / 1000n * 1000n],
        ['ex', max / 1000n - 1n, max / 1000n * 1000n],
      ]) {
        engine.set('key', 'first', { [option]: amount });
        assert.equal(engine.set('key', 'second', { keepttl: true, get: true }).previous.toString(), 'first');
        assert.equal(engine.pttl('key'), expiration - 1000n);
        assert.equal(encode(engine.pttl('key')).toString(), `:${expiration - 1000n}\r\n`);
        const row = db.prepare('SELECT expires_at, typeof(expires_at) AS kind FROM redis_keys WHERE key = ?').safeIntegers().get(Buffer.from('key'));
        assert.equal(row.expires_at, expiration);
        assert.equal(row.kind, 'integer');
      }
      engine.set('key', 'last', { pxat: max });
      engine.rename('key', 'renamed');
    } finally { db.close(); }
    const reopened = openDb(path);
    try {
      const reader = createEngine({ db: reopened, clock: () => 1000 });
      assert.equal(reader.pttl('renamed'), max - 1000n);
      assert.equal(reader.get('renamed').toString(), 'last');
      assert.equal(reader.persist('renamed'), true);
      assert.equal(reader.pttl('renamed'), -1);
    } finally { reopened.close(); }
  });

  it('validates only the final repeated expiry and keeps SETEX integer parsing strict', () => {
    const db = openDb(':memory:');
    const engine = createEngine({ db, clock: () => 1000 });
    const args = (...items) => items.map((item) => Buffer.from(item));
    try {
      for (const first of ['0', 'abc', '9223372036854775808']) {
        assert.deepEqual(handleSet(engine, args('key', 'value', 'EX', first, 'EX', '10')), { simple: 'OK' });
        assert.equal(engine.pttl('key'), 10000);
      }
      assert.equal(handleSet(engine, args('key', 'new', 'EX', '0', 'NX', 'XX')).error, 'ERR syntax error');
      for (const invalid of ['10abc', '1.5', '01', '+1', '9223372036854775808']) {
        assert.equal(handleSetex(engine, args('key', invalid, 'new')).error, 'ERR value is not an integer or out of range');
      }
      for (const invalid of ['0', '-1', '9223372036854775807']) {
        assert.equal(handleSetex(engine, args('key', invalid, 'new')).error, "ERR invalid expire time in 'setex' command");
      }
      assert.equal(engine.get('key').toString(), 'value');
    } finally { db.close(); }
  });

  it('rolls back failed writes without publishing an uncommitted cache value', () => {
    const { db, engine } = cachedEngine({ clock: () => 1000 });
    try {
      engine.set('key', 'old', { px: 10000 });
      db.exec("CREATE TRIGGER reject_string_update BEFORE UPDATE ON redis_strings BEGIN SELECT RAISE(ABORT, 'write rejected'); END");
      assert.throws(() => engine.set('key', 'new', { xx: true, get: true }), /write rejected/);
      assert.equal(engine.get('key').toString(), 'old');
      assert.equal(engine.pttl('key'), 10000);
      engine.hset('hash', 'field', 'old');
      db.exec("CREATE TRIGGER reject_string_insert BEFORE INSERT ON redis_strings BEGIN SELECT RAISE(ABORT, 'write rejected'); END");
      assert.throws(() => engine.set('hash', 'new'), /write rejected/);
      assert.equal(engine.hget('hash', 'field').toString(), 'old');
    } finally { db.close(); }
  });

  it('uses a single time snapshot while replacing a key at its expiry boundary', () => {
    let now = 1000;
    const db = openDb(':memory:');
    const engine = createEngine({ db, clock: () => now++ });
    try {
      engine.set('key', 'old', { pxat: 1002 });
      const reply = engine.set('key', 'new', { xx: true, get: true });
      assert.equal(reply.written, true);
      assert.equal(reply.previous.toString(), 'old');
      assert.equal(engine.get('key').toString(), 'new');
    } finally { db.close(); }
  });
});
