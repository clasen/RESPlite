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
        if (meta) {
          if (meta.type !== KEY_TYPES.HASH) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
        } else {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now });
        }
        insertStmt.run(key, field, value);
      });
    },

    setMultiple(key, pairs, options = {}) {
      runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        if (meta) {
          if (meta.type !== KEY_TYPES.HASH) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
        } else {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now });
        }
        for (let i = 0; i < pairs.length; i += 2) {
          insertStmt.run(key, pairs[i], pairs[i + 1]);
        }
      });
    },

    delete(key, fields) {
      return runInTransaction(db, () => {
        let n = 0;
        for (const field of fields) {
          const r = deleteStmt.run(key, field);
          n += r.changes;
        }
        const remaining = (countStmt.get(key) || {}).n ?? 0;
        if (remaining === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        }
        return n;
      });
    },

    count(key) {
      const row = countStmt.get(key);
      return row ? row.n : 0;
    },

    incr(key, field, delta, options = {}) {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        if (meta && meta.type !== KEY_TYPES.HASH) {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        if (!meta) {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now });
        } else {
          keys.bumpVersion(key);
        }
        const cur = getStmt.get(key, field);
        const num = cur == null ? 0 : parseInt(cur.value.toString('utf8'), 10);
        if (Number.isNaN(num)) throw new Error('ERR hash value is not an integer');
        const next = num + delta;
        insertStmt.run(key, field, Buffer.from(String(next), 'utf8'));
        return next;
      });
    },
  };
}
