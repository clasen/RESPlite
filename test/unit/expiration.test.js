import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { createExpirationSweeper } from '../../src/engine/expiration.js';
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

describe('Hash field expiration sweeper', () => {
  it('sweeps expired hash fields and removes now-empty hash keys', () => {
    const dbPath = tmpDbPath();
    const db = openDb(dbPath);
    let t = 1_000_000;
    const clock = () => t;
    const engine = createEngine({ db, clock });
    const sweeper = createExpirationSweeper({ db, clock, sweepIntervalMs: 30 });

    engine.hset('h1', 'f1', 'v1', 'f2', 'v2');
    engine.hset('h2', 'only', 'gone');
    engine.hexpire('h1', t + 500, [Buffer.from('f1')]);
    engine.hexpire('h2', t + 500, [Buffer.from('only')]);

    t += 1000;

    // Drive a single sweep via start()/stop() bookends plus a manual flush.
    // Sweeper's sweep() is internal; expose it by creating one tick's worth of behavior.
    const row = db.prepare('SELECT COUNT(*) AS n FROM redis_hash_field_ttl WHERE expires_at <= ?').get(t);
    assert.equal(row.n, 2);

    // Drain by advancing: reuse setInterval semantics indirectly by stepping logic.
    // Emulate a tick by starting the sweeper with a very short interval and waiting briefly.
    sweeper.start();
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          sweeper.stop();
          const ttlRows = db.prepare('SELECT COUNT(*) AS n FROM redis_hash_field_ttl').get();
          assert.equal(ttlRows.n, 0, 'TTL rows should be swept');
          assert.equal(engine.hget('h1', 'f1'), null);
          assert.equal(engine.hlen('h1'), 1);
          assert.equal(engine.type('h2'), 'none');
          resolve();
        } catch (e) {
          resolve(Promise.reject(e));
        }
      }, 120);
    });
  });
});
