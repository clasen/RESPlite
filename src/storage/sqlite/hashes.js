/**
 * Hash storage: redis_hashes + coordination with redis_keys.
 * Empty hash removes the key (Section 8.6).
 */

import { KEY_TYPES } from './schema.js';
import { runInTransaction } from './tx.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('./keys.js').createKeysStorage>} keys
 */
export function createHashesStorage(db, keys) {
  const getStmt = db.prepare('SELECT value FROM redis_hashes WHERE key = ? AND field = ?');
  const getAllStmt = db.prepare('SELECT field, value FROM redis_hashes WHERE key = ?').raw(true);
  const insertStmt = db.prepare('INSERT OR REPLACE INTO redis_hashes (key, field, value) VALUES (?, ?, ?)');
  const deleteStmt = db.prepare('DELETE FROM redis_hashes WHERE key = ? AND field = ?');
  const deleteAllStmt = db.prepare('DELETE FROM redis_hashes WHERE key = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM redis_hashes WHERE key = ?');

  return {
    get(key, field) {
      const row = getStmt.get(key, field);
      return row ? row.value : null;
    },

    getAll(key) {
      return getAllStmt.all(key).flat();
    },

    set(key, field, value, options = {}) {
      runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        let knownCount = 0;
        if (meta) {
          if (meta.type !== KEY_TYPES.HASH) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
          if (meta.hashCount == null) {
            const row = countStmt.get(key);
            knownCount = (row && row.n) || 0;
            keys.setHashCount(key, knownCount, { touchUpdatedAt: false });
          } else {
            knownCount = meta.hashCount;
          }
        } else {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now, hashCount: 0 });
        }
        const existed = getStmt.get(key, field) != null;
        insertStmt.run(key, field, value);
        if (!existed) {
          if (meta) keys.incrHashCount(key, 1, { touchUpdatedAt: false });
          else keys.setHashCount(key, 1, { touchUpdatedAt: false });
        } else if (meta && meta.hashCount == null) {
          // Legacy rows may have null counters; persist hydrated value.
          keys.setHashCount(key, knownCount, { touchUpdatedAt: false });
        }
      });
    },

    setMultiple(key, pairs, options = {}) {
      runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        let knownCount = 0;
        if (meta) {
          if (meta.type !== KEY_TYPES.HASH) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
          if (meta.hashCount == null) {
            const row = countStmt.get(key);
            knownCount = (row && row.n) || 0;
            keys.setHashCount(key, knownCount, { touchUpdatedAt: false });
          } else {
            knownCount = meta.hashCount;
          }
        } else {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now, hashCount: 0 });
        }
        let added = 0;
        for (let i = 0; i < pairs.length; i += 2) {
          const existed = getStmt.get(key, pairs[i]) != null;
          insertStmt.run(key, pairs[i], pairs[i + 1]);
          if (!existed) added++;
        }
        if (added > 0) {
          if (meta) keys.incrHashCount(key, added, { touchUpdatedAt: false });
          else keys.setHashCount(key, added, { touchUpdatedAt: false });
        } else if (meta && meta.hashCount == null) {
          // Legacy rows may have null counters; persist hydrated value.
          keys.setHashCount(key, knownCount, { touchUpdatedAt: false });
        }
      });
    },

    delete(key, fields) {
      return runInTransaction(db, () => {
        const meta = keys.get(key);
        const before = meta && meta.hashCount != null ? meta.hashCount : null;
        let n = 0;
        for (const field of fields) {
          const r = deleteStmt.run(key, field);
          n += r.changes;
        }
        const remaining = before != null ? Math.max(0, before - n) : ((countStmt.get(key) || {}).n ?? 0);
        if (remaining === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        } else if (n > 0) {
          keys.setHashCount(key, remaining, { touchUpdatedAt: false });
        }
        return n;
      });
    },

    count(key) {
      const meta = keys.get(key);
      if (meta && meta.type === KEY_TYPES.HASH && meta.hashCount != null) {
        return meta.hashCount;
      }
      const row = countStmt.get(key);
      const n = row ? row.n : 0;
      if (meta && meta.type === KEY_TYPES.HASH && meta.hashCount == null) {
        // One-time hydration for databases created before hash_count existed.
        keys.setHashCount(key, n, { touchUpdatedAt: false });
      }
      return n;
    },

    incr(key, field, delta, options = {}) {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        if (meta && meta.type !== KEY_TYPES.HASH) {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        if (!meta) {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now, hashCount: 0 });
        } else {
          keys.bumpVersion(key);
          if (meta.hashCount == null) {
            const row = countStmt.get(key);
            const hydrated = (row && row.n) || 0;
            keys.setHashCount(key, hydrated, { touchUpdatedAt: false });
          }
        }
        const cur = getStmt.get(key, field);
        const num = cur == null ? 0 : parseInt(cur.value.toString('utf8'), 10);
        if (Number.isNaN(num)) throw new Error('ERR hash value is not an integer');
        const next = num + delta;
        insertStmt.run(key, field, Buffer.from(String(next), 'utf8'));
        if (cur == null) {
          if (meta) keys.incrHashCount(key, 1, { touchUpdatedAt: false });
          else keys.setHashCount(key, 1, { touchUpdatedAt: false });
        }
        return next;
      });
    },

    /** Copy all field/value rows from oldKey to newKey. Caller ensures newKey exists in redis_keys. */
    copyKey(oldKey, newKey) {
      const rows = getAllStmt.all(oldKey);
      for (const row of rows) {
        insertStmt.run(newKey, row[0], row[1]);
      }
      const sourceMeta = keys.get(oldKey);
      const nextCount = sourceMeta && sourceMeta.hashCount != null ? sourceMeta.hashCount : rows.length;
      keys.setHashCount(newKey, nextCount, { touchUpdatedAt: false });
    },
  };
}
