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
        let knownCount = 0;
        if (meta) {
          if (meta.type !== KEY_TYPES.SET) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
          if (meta.setCount == null) {
            const row = countStmt.get(key);
            knownCount = (row && row.n) || 0;
            keys.setSetCount(key, knownCount, { touchUpdatedAt: false });
          } else {
            knownCount = meta.setCount;
          }
        } else {
          keys.set(key, KEY_TYPES.SET, { updatedAt: now, setCount: 0 });
        }
        let added = 0;
        for (const m of members) {
          const r = insertStmt.run(key, m);
          if (r.changes > 0) added++;
        }
        if (added > 0) {
          if (meta) keys.incrSetCount(key, added, { touchUpdatedAt: false });
          else keys.setSetCount(key, added, { touchUpdatedAt: false });
        } else if (meta && meta.setCount == null) {
          // Legacy rows may have null counters; persist hydrated value.
          keys.setSetCount(key, knownCount, { touchUpdatedAt: false });
        }
        return added;
      });
    },

    remove(key, members) {
      return runInTransaction(db, () => {
        const meta = keys.get(key);
        const before = meta && meta.setCount != null ? meta.setCount : null;
        let n = 0;
        for (const m of members) {
          n += deleteStmt.run(key, m).changes;
        }
        const remaining = before != null ? Math.max(0, before - n) : ((countStmt.get(key) || {}).n || 0);
        if (remaining === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        } else if (n > 0) {
          keys.setSetCount(key, remaining, { touchUpdatedAt: false });
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
      const meta = keys.get(key);
      if (meta && meta.type === KEY_TYPES.SET && meta.setCount != null) {
        return meta.setCount;
      }
      const row = countStmt.get(key);
      const n = row ? row.n : 0;
      if (meta && meta.type === KEY_TYPES.SET && meta.setCount == null) {
        // One-time hydration for databases created before set_count existed.
        keys.setSetCount(key, n, { touchUpdatedAt: false });
      }
      return n;
    },

    /** Copy all members from oldKey to newKey. Caller ensures newKey exists in redis_keys. */
    copyKey(oldKey, newKey) {
      const rows = membersStmt.all(oldKey);
      for (const r of rows) {
        insertStmt.run(newKey, r.member);
      }
      const sourceMeta = keys.get(oldKey);
      const nextCount = sourceMeta && sourceMeta.setCount != null ? sourceMeta.setCount : rows.length;
      keys.setSetCount(newKey, nextCount, { touchUpdatedAt: false });
    },

    /** Get random members without removing. count null/1 = single; count > 0 = up to count distinct; count < 0 = |count| with replacement. */
    getRandomMembers(key, count) {
      const arr = membersStmt.all(key).map((r) => r.member);
      if (arr.length === 0) return count != null && count !== 1 ? [] : null;
      const c = count == null ? 1 : count;
      if (c === 1) return arr[Math.floor(Math.random() * arr.length)];
      if (c > 0) {
        const shuffled = arr.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, Math.min(c, shuffled.length));
      }
      const out = [];
      for (let i = 0; i < -c; i++) out.push(arr[Math.floor(Math.random() * arr.length)]);
      return out;
    },

    /** Remove and return random members. Returns single member or array. */
    popRandom(key, count, options = {}) {
      return runInTransaction(db, () => {
        const arr = membersStmt.all(key).map((r) => r.member);
        if (arr.length === 0) return count != null && count !== 1 ? [] : null;
        const c = count == null ? 1 : count;
        let chosen;
        if (c === 1) {
          chosen = [arr[Math.floor(Math.random() * arr.length)]];
        } else if (c > 0) {
          const shuffled = arr.slice();
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          chosen = shuffled.slice(0, Math.min(c, shuffled.length));
        } else {
          chosen = [];
          for (let i = 0; i < -c; i++) chosen.push(arr[Math.floor(Math.random() * arr.length)]);
        }
        for (const m of chosen) deleteStmt.run(key, m);
        const remaining = arr.length - chosen.length;
        if (remaining === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        } else {
          keys.bumpVersion(key);
          keys.setSetCount(key, remaining, { touchUpdatedAt: false });
        }
        return c === 1 ? chosen[0] : chosen;
      });
    },
  };
}
