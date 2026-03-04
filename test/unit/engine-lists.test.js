import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
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
});
