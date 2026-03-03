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
});
