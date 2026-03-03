import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
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
