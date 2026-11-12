import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/storage/sqlite/db.ts';
import { createEngine } from '../../src/engine/engine.ts';
import { createExpirationSweeper } from '../../src/engine/expiration.ts';
import { createKeysStorage } from '../../src/storage/sqlite/keys.ts';
import { createStringsStorage } from '../../src/storage/sqlite/strings.ts';
import { createHashesStorage } from '../../src/storage/sqlite/hashes.ts';
import { createSetsStorage } from '../../src/storage/sqlite/sets.ts';
import { createListsStorage } from '../../src/storage/sqlite/lists.ts';
import { createZsetsStorage } from '../../src/storage/sqlite/zsets.ts';
import { importKeyFromRedis } from '../../src/migration/import-one.ts';
import {
  createIndex,
  addDocument,
  deleteDocument,
  suggestionAdd,
  suggestionDel,
  getIndexCounts,
  clearSearchData,
} from '../../src/storage/sqlite/search.ts';
import { tmpDbPath } from '../helpers/tmp.js';

/** Full-scan definition of a live key that DBSIZE kept before the counter existed. */
const LIVE_KEYS_SQL = `
SELECT COUNT(*) AS n
  FROM redis_keys k
 WHERE (k.expires_at IS NULL OR k.expires_at > ?)
   AND (
     k.type != 2
     OR EXISTS (
       SELECT 1 FROM redis_hashes h
        WHERE h.key = k.key
          AND NOT EXISTS (
            SELECT 1 FROM redis_hash_field_ttl t
             WHERE t.key = h.key AND t.field = h.field AND t.expires_at <= ?
          )
     )
   )`;

function makeEngine(start = 1_000_000) {
  const db = openDb(tmpDbPath());
  let now = start;
  const engine = createEngine({ db, clock: () => now });
  return {
    db,
    engine,
    advance(ms) {
      now += ms;
    },
    now: () => now,
  };
}

function assertKeyCounter(db, engine, now) {
  const rows = db.prepare('SELECT COUNT(*) AS n FROM redis_keys').get().n;
  assert.equal(engine._keys.count(), rows, 'key counter matches redis_keys rows');
  assert.equal(engine.dbsize(), db.prepare(LIVE_KEYS_SQL).get(now, now).n, 'DBSIZE matches live-key scan');
}

function assertIndexCounters(db, idx) {
  const count = (suffix) => db.prepare(`SELECT COUNT(*) AS c FROM search_${suffix}__${idx}`).get().c;
  assert.deepEqual(getIndexCounts(db, idx), {
    num_docs: count('docs'),
    fts_rows: count('fts'),
    num_suggestions: count('sugs'),
  });
}

describe('Maintained key counter', () => {
  it('stays exact across writes, deletes, renames and flush', () => {
    const { db, engine, now } = makeEngine();
    const check = () => assertKeyCounter(db, engine, now());

    engine.set('s1', 'v');
    engine.set('s1', 'v2');
    engine.set('s2', 'v');
    engine.hset('h', 'f1', 'v', 'f2', 'v');
    engine.sadd('set', 'a', 'b');
    engine.rpush('list', 'a', 'b');
    engine.zadd('z', ['1', 'a', '2', 'b']);
    check();
    assert.equal(engine.dbsize(), 6);

    engine.hdel('h', ['f1']);
    engine.srem('set', ['a', 'b']);
    engine.lpop('list');
    engine.lpop('list');
    engine.zrem('z', ['a', 'b']);
    check();
    assert.equal(engine.dbsize(), 3);

    engine.del(['s2', 'missing']);
    engine.rename('s1', 'renamed');
    engine.set('target', 'old');
    engine.rename('renamed', 'target');
    engine.set('s1', 'string');
    engine.hset('h', 'f1', 'v');
    check();
    assert.equal(engine.dbsize(), 3);

    engine.flushDatabase();
    check();
    assert.equal(engine.dbsize(), 0);
    db.close();
  });

  it('rolls back with failed batches and keeps committed MULTI writes', () => {
    const { db, engine, now } = makeEngine();
    engine.set('kept', 'v');
    assert.throws(() =>
      engine.runBatch(() => {
        engine.set('a', '1');
        engine.hset('b', 'f', 'v');
        engine.del(['kept']);
        throw new Error('abort');
      })
    );
    assertKeyCounter(db, engine, now());
    assert.equal(engine.dbsize(), 1);

    engine.runBatch(() => {
      engine.set('a', '1');
      engine.sadd('b', 'm');
    });
    assertKeyCounter(db, engine, now());
    assert.equal(engine.dbsize(), 3);
    db.close();
  });

  it('excludes expired keys and fully expired hashes until expiry removes them', () => {
    const { db, engine, advance, now } = makeEngine();
    engine.set('ttl', 'v', { px: 1000 });
    engine.set('plain', 'v');
    engine.hset('all-expire', 'f1', 'v', 'f2', 'v');
    engine.hexpire('all-expire', now() + 500, ['f1', 'f2']);
    engine.hset('partial', 'f1', 'v', 'f2', 'v');
    engine.hexpire('partial', now() + 500, ['f1']);
    assert.equal(engine.dbsize(), 4);

    advance(1000);
    assertKeyCounter(db, engine, now());
    assert.equal(engine._keys.count(), 4, 'expired rows are still stored');
    assert.equal(engine.dbsize(), 2);

    assert.equal(engine.get('ttl'), null);
    assertKeyCounter(db, engine, now());
    assert.equal(engine._keys.count(), 3, 'lazy expiry removes the row');
    assert.equal(engine.dbsize(), 2);
    db.close();
  });

  it('decrements when the active sweeper removes expired keys and hashes', async () => {
    const { db, engine, advance, now } = makeEngine();
    engine.set('ttl', 'v', { px: 100 });
    engine.hset('h', 'f', 'v');
    engine.hexpire('h', now() + 100, ['f']);
    engine.set('plain', 'v');
    advance(200);

    const sweeper = createExpirationSweeper({ db, clock: now, sweepIntervalMs: 5 });
    sweeper.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    sweeper.stop();

    assertKeyCounter(db, engine, now());
    assert.equal(engine._keys.count(), 1);
    assert.equal(engine.dbsize(), 1);
    db.close();
  });

  it('counts keys written by the Redis importer', async () => {
    const db = openDb(tmpDbPath());
    const keys = createKeysStorage(db);
    const storages = {
      keys,
      strings: createStringsStorage(db, keys),
      hashes: createHashesStorage(db, keys),
      sets: createSetsStorage(db, keys),
      lists: createListsStorage(db, keys),
      zsets: createZsetsStorage(db, keys),
    };
    const redis = {
      async type(key) {
        return key.startsWith('h') ? 'hash' : 'string';
      },
      async pTTL() {
        return -1;
      },
      async get() {
        return 'value';
      },
      async hGetAll() {
        return { f: 'v' };
      },
    };
    for (const key of ['s1', 'h1', 's1', 'h2']) {
      const outcome = await importKeyFromRedis(redis, key, storages, { now: 1000 });
      assert.equal(outcome.ok, true);
    }
    assert.equal(keys.count(), 3);
    assert.equal(keys.countLive(1000), 3);
    db.close();
  });

  it('counts existing keys and indices when a database is opened', () => {
    const dbPath = tmpDbPath();
    let db = openDb(dbPath);
    let engine = createEngine({ db });
    engine.set('a', '1');
    engine.hset('b', 'f', 'v');
    createIndex(db, 'idx', [{ name: 'payload', type: 'TEXT' }]);
    addDocument(db, 'idx', 'd1', 1, false, { payload: 'hello' });
    addDocument(db, 'idx', 'd2', 1, false, { payload: 'world' });
    suggestionAdd(db, 'idx', 'hello', 1, false);
    db.close();

    db = openDb(dbPath);
    engine = createEngine({ db });
    assert.equal(engine.dbsize(), 2);
    assert.deepEqual(getIndexCounts(db, 'idx'), { num_docs: 2, fts_rows: 2, num_suggestions: 1 });
    db.close();
  });

  it('undoes deltas of rolled-back savepoints and keeps released ones', () => {
    const { db, engine, now } = makeEngine();
    engine.set('base', 'v');
    engine.runBatch(() => {
      engine.set('outer', 'v');
      assert.throws(() =>
        engine.runBatch(() => {
          engine.set('inner-lost', 'v');
          engine.del(['base']);
          throw new Error('abort inner');
        })
      );
      engine.runBatch(() => {
        engine.set('inner-kept', 'v');
      });
    });
    assertKeyCounter(db, engine, now());
    assert.equal(engine.dbsize(), 3);

    assert.throws(() =>
      engine.runBatch(() => {
        engine.runBatch(() => engine.set('released-then-lost', 'v'));
        throw new Error('abort outer');
      })
    );
    assertKeyCounter(db, engine, now());
    assert.equal(engine.dbsize(), 3);
    db.close();
  });

  it('recounts keys and index counts after another connection writes', () => {
    const dbPath = tmpDbPath();
    const db = openDb(dbPath);
    const engine = createEngine({ db });
    engine.set('mine', 'v');
    assert.equal(engine.dbsize(), 1);

    const other = openDb(dbPath);
    const otherEngine = createEngine({ db: other });
    createIndex(other, 'shared', [{ name: 'payload', type: 'TEXT' }]);
    addDocument(other, 'shared', 'd1', 1, false, { payload: 'hello' });
    otherEngine.set('theirs-1', 'v');
    otherEngine.set('theirs-2', 'v');
    otherEngine.del(['mine']);
    other.close();

    assert.deepEqual(getIndexCounts(db, 'shared'), { num_docs: 1, fts_rows: 1, num_suggestions: 0 });
    addDocument(db, 'shared', 'd2', 1, false, { payload: 'world' });
    assertIndexCounters(db, 'shared');
    assert.equal(engine.dbsize(), 2);
    engine.set('mine-again', 'v');
    assertKeyCounter(db, engine, Date.now());
    assert.equal(engine.dbsize(), 3);
    db.close();
  });
});

describe('Maintained search index counters', () => {
  it('stay exact across FT.ADD, REPLACE, FT.DEL, SUGADD and SUGDEL', () => {
    const db = openDb(tmpDbPath());
    createIndex(db, 'idx', [{ name: 'payload', type: 'TEXT' }]);
    assert.deepEqual(getIndexCounts(db, 'idx'), { num_docs: 0, fts_rows: 0, num_suggestions: 0 });

    addDocument(db, 'idx', 'd1', 1, false, { payload: 'alpha' });
    addDocument(db, 'idx', 'd2', 1, false, { payload: 'beta' });
    addDocument(db, 'idx', 'd1', 2, true, { payload: 'alpha two' });
    assert.throws(() => addDocument(db, 'idx', 'd2', 1, false, { payload: 'dup' }), /document exists/);
    assertIndexCounters(db, 'idx');
    assert.equal(getIndexCounts(db, 'idx').num_docs, 2);

    assert.equal(deleteDocument(db, 'idx', 'd2'), 1);
    assert.equal(deleteDocument(db, 'idx', 'd2'), 0);
    assertIndexCounters(db, 'idx');
    assert.equal(getIndexCounts(db, 'idx').num_docs, 1);

    assert.equal(suggestionAdd(db, 'idx', 'alpha', 1, false), 1);
    assert.equal(suggestionAdd(db, 'idx', 'alpha', 1, true), 0);
    assert.equal(suggestionAdd(db, 'idx', 'beta', 1, false), 1);
    assert.equal(suggestionDel(db, 'idx', 'beta'), 1);
    assert.equal(suggestionDel(db, 'idx', 'beta'), 0);
    assertIndexCounters(db, 'idx');
    assert.equal(getIndexCounts(db, 'idx').num_suggestions, 1);

    clearSearchData(db);
    createIndex(db, 'idx', [{ name: 'payload', type: 'TEXT' }]);
    assert.deepEqual(getIndexCounts(db, 'idx'), { num_docs: 0, fts_rows: 0, num_suggestions: 0 });
    db.close();
  });

  it('do not double count when an index is first counted inside a write', () => {
    const dbPath = tmpDbPath();
    let db = openDb(dbPath);
    createIndex(db, 'idx', [{ name: 'payload', type: 'TEXT' }]);
    addDocument(db, 'idx', 'd1', 1, false, { payload: 'alpha' });
    suggestionAdd(db, 'idx', 'alpha', 1, false);
    db.close();

    db = openDb(dbPath);
    addDocument(db, 'idx', 'd2', 1, false, { payload: 'beta' });
    assertIndexCounters(db, 'idx');
    db.close();
    db = openDb(dbPath);
    suggestionAdd(db, 'idx', 'beta', 1, false);
    assertIndexCounters(db, 'idx');
    db.close();
    db = openDb(dbPath);
    deleteDocument(db, 'idx', 'd1');
    assertIndexCounters(db, 'idx');
    db.close();
  });

  it('recount after a rolled-back flush', () => {
    const db = openDb(tmpDbPath());
    const engine = createEngine({ db });
    createIndex(db, 'idx', [{ name: 'payload', type: 'TEXT' }]);
    addDocument(db, 'idx', 'd1', 1, false, { payload: 'alpha' });
    assert.throws(() =>
      engine.runBatch(() => {
        engine.flushDatabase();
        throw new Error('abort');
      })
    );
    assertIndexCounters(db, 'idx');
    assert.equal(getIndexCounts(db, 'idx').num_docs, 1);
    db.close();
  });

  it('are not changed by a rolled-back batch', () => {
    const db = openDb(tmpDbPath());
    createIndex(db, 'idx', [{ name: 'payload', type: 'TEXT' }]);
    addDocument(db, 'idx', 'd1', 1, false, { payload: 'alpha' });
    assert.throws(() =>
      db.transaction(() => {
        addDocument(db, 'idx', 'd2', 1, false, { payload: 'beta' });
        suggestionAdd(db, 'idx', 'beta', 1, false);
        deleteDocument(db, 'idx', 'd1');
        throw new Error('abort');
      })()
    );
    assertIndexCounters(db, 'idx');
    assert.deepEqual(getIndexCounts(db, 'idx'), { num_docs: 1, fts_rows: 1, num_suggestions: 0 });
    db.close();
  });
});
