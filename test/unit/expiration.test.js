import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { tmpDbPath } from '../helpers/tmp.js';
import { fixedClock } from '../helpers/clock.js';

describe('Expiration', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = 1000000;
  const clock = fixedClock(now);
  const engine = createEngine({ db, clock });

  it('TTL missing key returns -2', () => {
    assert.equal(engine.ttl('nokey'), -2);
  });

  it('TTL key without expiry returns -1', () => {
    engine.set('foo', 'bar');
    assert.equal(engine.ttl('foo'), -1);
  });

  it('EXPIRE sets TTL and TTL returns remaining seconds', () => {
    engine.set('k', 'v');
    engine.expire('k', 10);
    assert.equal(engine.ttl('k'), 10);
  });

  it('lazy expiration: expired key is treated as missing', () => {
    engine.set('x', 'y');
    engine.expire('x', 5); // 5 seconds from now
    const clock2 = fixedClock(now + 6000);
    const engine2 = createEngine({ db, clock: clock2 });
    assert.equal(engine2.get('x'), null);
    assert.equal(engine2.ttl('x'), -2);
  });

  it('PERSIST removes TTL', () => {
    engine.set('p', 'q');
    engine.expire('p', 10);
    assert.equal(engine.persist('p'), true);
    assert.equal(engine.ttl('p'), -1);
  });
});
