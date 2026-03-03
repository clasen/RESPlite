/**
 * String storage: redis_strings + coordination with redis_keys.
 */

import { KEY_TYPES } from './schema.js';
import { runInTransaction } from './tx.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('./keys.js').createKeysStorage>} keys
 */
export function createStringsStorage(db, keys) {
  const getStmt = db.prepare('SELECT value FROM redis_strings WHERE key = ?');
  const insertStmt = db.prepare('INSERT INTO redis_strings (key, value) VALUES (?, ?)');
  const updateStmt = db.prepare('UPDATE redis_strings SET value = ? WHERE key = ?');
  const deleteStmt = db.prepare('DELETE FROM redis_strings WHERE key = ?');

  function _setOne(key, value, options) {
    const now = options.updatedAt ?? Date.now();
    const expiresAt = options.expiresAt ?? null;
    const meta = keys.get(key);
    if (meta) {
      if (meta.type !== KEY_TYPES.STRING) {
        throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      }
      keys.set(key, KEY_TYPES.STRING, { expiresAt, updatedAt: now });
      updateStmt.run(value, key);
    } else {
      keys.set(key, KEY_TYPES.STRING, { expiresAt, updatedAt: now });
      insertStmt.run(key, value);
    }
  }

  return {
    get(key) {
      const row = getStmt.get(key);
      return row ? row.value : null;
    },

    set(key, value, options = {}) {
      runInTransaction(db, () => _setOne(key, value, options));
    },

    /**
     * Batch set: all key/value pairs in a single transaction.
     * @param {Array<{key: Buffer, value: Buffer, options?: object}>} entries
     */
    setMultiple(entries) {
      runInTransaction(db, () => {
        for (const entry of entries) {
          _setOne(entry.key, entry.value, entry.options || {});
        }
      });
    },

    delete(key) {
      runInTransaction(db, () => {
        deleteStmt.run(key);
        keys.delete(key);
      });
    },
  };
}
