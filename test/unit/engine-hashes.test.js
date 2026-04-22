import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { tmpDbPath } from '../helpers/tmp.js';

describe('Engine hashes', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const engine = createEngine({ db });

  it('HSET and HGET', () => {
    engine.hset('user:1', Buffer.from('name'), Buffer.from('Martin'));
    assert.equal(engine.hget('user:1', 'name').toString(), 'Martin');
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

  it('HINCRBY clears a field TTL', () => {
    const { engine } = makeEngine(1_000_000);
    engine.hset('h', 'n', '1');
    engine.hexpire('h', engine._clock() + 5000, [Buffer.from('n')]);
    engine.hincrby('h', 'n', 2);
    assert.deepEqual(engine.httl('h', [Buffer.from('n')]), [-1]);
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
