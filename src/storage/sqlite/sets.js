/**
 * Set storage: redis_sets. Empty set removes the key (Section 8.6).
 */

import { KEY_TYPES } from './schema.js';
import { runInTransaction } from './tx.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('./keys.js').createKeysStorage>} keys
 */
export function createSetsStorage(db, keys) {
  const insertStmt = db.prepare('INSERT OR IGNORE INTO redis_sets (key, member) VALUES (?, ?)');
  const deleteStmt = db.prepare('DELETE FROM redis_sets WHERE key = ? AND member = ?');
  const deleteAllStmt = db.prepare('DELETE FROM redis_sets WHERE key = ?');
  const membersStmt = db.prepare('SELECT member FROM redis_sets WHERE key = ? ORDER BY member');
  const hasStmt = db.prepare('SELECT 1 FROM redis_sets WHERE key = ? AND member = ? LIMIT 1');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM redis_sets WHERE key = ?');

  return {
    add(key, members, options = {}) {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        if (meta) {
          if (meta.type !== KEY_TYPES.SET) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
        } else {
          keys.set(key, KEY_TYPES.SET, { updatedAt: now });
        }
        let added = 0;
        for (const m of members) {
          const r = insertStmt.run(key, m);
          if (r.changes > 0) added++;
        }
        return added;
      });
    },

    remove(key, members) {
      return runInTransaction(db, () => {
        let n = 0;
        for (const m of members) {
          n += deleteStmt.run(key, m).changes;
        }
        const row = countStmt.get(key);
        const remaining = (row && row.n) || 0;
        if (remaining === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        }
        return n;
      });
    },

    members(key) {
      const rows = membersStmt.all(key);
      return rows.map((r) => r.member);
    },

    has(key, member) {
      return hasStmt.get(key, member) != null;
    },

    count(key) {
      const row = countStmt.get(key);
      return row ? row.n : 0;
    },
  };
}
