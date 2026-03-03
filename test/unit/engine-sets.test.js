import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
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
