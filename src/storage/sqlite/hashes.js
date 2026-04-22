/**
 * Hash storage: redis_hashes + coordination with redis_keys.
 * Empty hash removes the key (Section 8.6).
 * Per-field TTL is tracked in redis_hash_field_ttl (epoch milliseconds);
 * HSET/HINCRBY clear a field's TTL, lazy-expiration prunes stale fields.
 */

import { KEY_TYPES } from './schema.js';
import { runInTransaction } from './tx.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('./keys.js').createKeysStorage>} keys
 * @param {{ clock?: () => number }} [options]
 */
export function createHashesStorage(db, keys, options = {}) {
  const clock = options.clock ?? (() => Date.now());

  const getStmt = db.prepare('SELECT value FROM redis_hashes WHERE key = ? AND field = ?');
  const getAllStmt = db.prepare('SELECT field, value FROM redis_hashes WHERE key = ?').raw(true);
  const getAllLiveStmt = db
    .prepare(
      `SELECT h.field, h.value
         FROM redis_hashes h
         LEFT JOIN redis_hash_field_ttl t ON t.key = h.key AND t.field = h.field
        WHERE h.key = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`
    )
    .raw(true);
  const insertStmt = db.prepare('INSERT OR REPLACE INTO redis_hashes (key, field, value) VALUES (?, ?, ?)');
  const deleteStmt = db.prepare('DELETE FROM redis_hashes WHERE key = ? AND field = ?');
  const deleteAllStmt = db.prepare('DELETE FROM redis_hashes WHERE key = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM redis_hashes WHERE key = ?');
  const countLiveStmt = db.prepare(
    `SELECT COUNT(*) AS n
       FROM redis_hashes h
       LEFT JOIN redis_hash_field_ttl t ON t.key = h.key AND t.field = h.field
      WHERE h.key = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`
  );
  const hasAnyTtlStmt = db.prepare('SELECT 1 FROM redis_hash_field_ttl WHERE key = ? LIMIT 1').pluck();

  const getFieldTtlStmt = db.prepare(
    'SELECT expires_at AS expiresAt FROM redis_hash_field_ttl WHERE key = ? AND field = ?'
  );
  const upsertFieldTtlStmt = db.prepare(
    'INSERT OR REPLACE INTO redis_hash_field_ttl (key, field, expires_at) VALUES (?, ?, ?)'
  );
  const deleteFieldTtlStmt = db.prepare('DELETE FROM redis_hash_field_ttl WHERE key = ? AND field = ?');

  /**
   * If the field has an expired TTL row, delete the field + TTL row, adjust count
   * (and drop the whole key when empty). Returns true if the field was purged.
   */
  function expireFieldIfDue(key, field, now) {
    const ttl = getFieldTtlStmt.get(key, field);
    if (!ttl || ttl.expiresAt > now) return false;
    const existed = getStmt.get(key, field) != null;
    deleteFieldTtlStmt.run(key, field);
    if (!existed) return true;
    deleteStmt.run(key, field);
    const meta = keys.get(key);
    if (!meta) return true;
    const before = meta.hashCount != null ? meta.hashCount : (countStmt.get(key) || { n: 0 }).n + 1;
    const remaining = Math.max(0, before - 1);
    if (remaining === 0) {
      deleteAllStmt.run(key);
      keys.delete(key);
    } else {
      keys.setHashCount(key, remaining, { touchUpdatedAt: false });
    }
    return true;
  }

  return {
    get(key, field) {
      runInTransaction(db, () => {
        expireFieldIfDue(key, field, clock());
      });
      const row = getStmt.get(key, field);
      return row ? row.value : null;
    },

    getAll(key) {
      const now = clock();
      const hasTtl = hasAnyTtlStmt.get(key);
      if (!hasTtl) return getAllStmt.all(key).flat();
      return getAllLiveStmt.all(key, now).flat();
    },

    set(key, field, value, options = {}) {
      runInTransaction(db, () => {
        const now = options.updatedAt ?? clock();
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
        deleteFieldTtlStmt.run(key, field);
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
        const now = options.updatedAt ?? clock();
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
          deleteFieldTtlStmt.run(key, pairs[i]);
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
          deleteFieldTtlStmt.run(key, field);
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
      if (!meta || meta.type !== KEY_TYPES.HASH) {
        const row = countStmt.get(key);
        return row ? row.n : 0;
      }
      const hasTtl = hasAnyTtlStmt.get(key);
      if (hasTtl) {
        const row = countLiveStmt.get(key, clock());
        return row ? row.n : 0;
      }
      if (meta.hashCount != null) return meta.hashCount;
      const row = countStmt.get(key);
      const n = row ? row.n : 0;
      // One-time hydration for databases created before hash_count existed.
      keys.setHashCount(key, n, { touchUpdatedAt: false });
      return n;
    },

    incr(key, field, delta, options = {}) {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? clock();
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
        expireFieldIfDue(key, field, now);
        const cur = getStmt.get(key, field);
        const num = cur == null ? 0 : parseInt(cur.value.toString('utf8'), 10);
        if (Number.isNaN(num)) throw new Error('ERR hash value is not an integer');
        const next = num + delta;
        insertStmt.run(key, field, Buffer.from(String(next), 'utf8'));
        deleteFieldTtlStmt.run(key, field);
        if (cur == null) {
          if (meta) keys.incrHashCount(key, 1, { touchUpdatedAt: false });
          else keys.setHashCount(key, 1, { touchUpdatedAt: false });
        }
        return next;
      });
    },

    /**
     * Per-field expiration set. Returns -2/0/1/2 per HEXPIRE spec.
     * `condition` is null or one of 'NX','XX','GT','LT'.
     */
    setFieldExpire(key, field, expiresAtMs, { condition = null } = {}) {
      return runInTransaction(db, () => {
        const now = clock();
        expireFieldIfDue(key, field, now);
        const exists = getStmt.get(key, field) != null;
        if (!exists) return -2;
        const current = getFieldTtlStmt.get(key, field);
        const currentMs = current ? current.expiresAt : null;
        if (condition === 'NX' && currentMs != null) return 0;
        if (condition === 'XX' && currentMs == null) return 0;
        if (condition === 'GT') {
          if (currentMs == null) return 0;
          if (!(expiresAtMs > currentMs)) return 0;
        }
        if (condition === 'LT') {
          if (currentMs != null && !(expiresAtMs < currentMs)) return 0;
        }
        if (expiresAtMs <= now) {
          deleteStmt.run(key, field);
          deleteFieldTtlStmt.run(key, field);
          const meta = keys.get(key);
          if (meta) {
            const before = meta.hashCount != null ? meta.hashCount : (countStmt.get(key) || { n: 0 }).n + 1;
            const remaining = Math.max(0, before - 1);
            if (remaining === 0) {
              deleteAllStmt.run(key);
              keys.delete(key);
            } else {
              keys.setHashCount(key, remaining, { touchUpdatedAt: false });
            }
          }
          return 2;
        }
        upsertFieldTtlStmt.run(key, field, expiresAtMs);
        return 1;
      });
    },

    /**
     * Returns remaining ms (>= 0), -1 if field has no TTL, -2 if field missing.
     */
    getFieldTtl(key, field) {
      const now = clock();
      let removed = false;
      runInTransaction(db, () => {
        removed = expireFieldIfDue(key, field, now);
      });
      if (removed) return -2;
      const exists = getStmt.get(key, field) != null;
      if (!exists) return -2;
      const row = getFieldTtlStmt.get(key, field);
      if (!row) return -1;
      return Math.max(0, row.expiresAt - now);
    },

    /**
     * Clears a field's TTL. Returns 1 if cleared, -1 if no TTL, -2 if field missing.
     */
    persistField(key, field) {
      return runInTransaction(db, () => {
        const now = clock();
        expireFieldIfDue(key, field, now);
        const exists = getStmt.get(key, field) != null;
        if (!exists) return -2;
        const row = getFieldTtlStmt.get(key, field);
        if (!row) return -1;
        deleteFieldTtlStmt.run(key, field);
        return 1;
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
