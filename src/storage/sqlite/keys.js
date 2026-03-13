/**
 * CRUD for redis_keys table.
 */

import { KEY_TYPES } from './schema.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createKeysStorage(db) {
  const getByKey = db.prepare(
    'SELECT key, type, expires_at AS expiresAt, set_count AS setCount, hash_count AS hashCount, zset_count AS zsetCount, version, updated_at AS updatedAt FROM redis_keys WHERE key = ?'
  );
  const insert = db.prepare(
    `INSERT INTO redis_keys (key, type, expires_at, set_count, hash_count, zset_count, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  );
  const updateMeta = db.prepare(
    'UPDATE redis_keys SET type = ?, expires_at = ?, set_count = ?, hash_count = ?, zset_count = ?, version = version + 1, updated_at = ? WHERE key = ?'
  );
  const updateExpires = db.prepare('UPDATE redis_keys SET expires_at = ?, updated_at = ? WHERE key = ?');
  const updateVersion = db.prepare('UPDATE redis_keys SET version = version + 1, updated_at = ? WHERE key = ?');
  const updateSetCount = db.prepare('UPDATE redis_keys SET set_count = ?, updated_at = ? WHERE key = ?');
  const updateSetCountOnly = db.prepare('UPDATE redis_keys SET set_count = ? WHERE key = ?');
  const incrSetCount = db.prepare(
    'UPDATE redis_keys SET set_count = COALESCE(set_count, 0) + ?, updated_at = ? WHERE key = ?'
  );
  const incrSetCountOnly = db.prepare('UPDATE redis_keys SET set_count = COALESCE(set_count, 0) + ? WHERE key = ?');
  const updateHashCount = db.prepare('UPDATE redis_keys SET hash_count = ?, updated_at = ? WHERE key = ?');
  const updateHashCountOnly = db.prepare('UPDATE redis_keys SET hash_count = ? WHERE key = ?');
  const incrHashCount = db.prepare(
    'UPDATE redis_keys SET hash_count = COALESCE(hash_count, 0) + ?, updated_at = ? WHERE key = ?'
  );
  const incrHashCountOnly = db.prepare('UPDATE redis_keys SET hash_count = COALESCE(hash_count, 0) + ? WHERE key = ?');
  const updateZsetCount = db.prepare('UPDATE redis_keys SET zset_count = ?, updated_at = ? WHERE key = ?');
  const updateZsetCountOnly = db.prepare('UPDATE redis_keys SET zset_count = ? WHERE key = ?');
  const incrZsetCount = db.prepare(
    'UPDATE redis_keys SET zset_count = COALESCE(zset_count, 0) + ?, updated_at = ? WHERE key = ?'
  );
  const incrZsetCountOnly = db.prepare('UPDATE redis_keys SET zset_count = COALESCE(zset_count, 0) + ? WHERE key = ?');
  const deleteByKey = db.prepare('DELETE FROM redis_keys WHERE key = ?');
  const deleteExpiredStmt = db.prepare('DELETE FROM redis_keys WHERE expires_at IS NOT NULL AND expires_at <= ?');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM redis_keys').pluck();
  const scanKeys = db.prepare(
    'SELECT key FROM redis_keys ORDER BY key LIMIT ? OFFSET ?'
  );

  return {
    KEY_TYPES,

    get(key) {
      const row = getByKey.get(key);
      return row ? { ...row, key: row.key } : null;
    },

    set(key, type, options = {}) {
      const now = options.updatedAt ?? Date.now();
      const expiresAt = options.expiresAt ?? null;
      const existing = getByKey.get(key);
      const setCount = type === KEY_TYPES.SET
        ? (options.setCount ?? existing?.setCount ?? 0)
        : null;
      const hashCount = type === KEY_TYPES.HASH
        ? (options.hashCount ?? existing?.hashCount ?? 0)
        : null;
      const zsetCount = type === KEY_TYPES.ZSET
        ? (options.zsetCount ?? existing?.zsetCount ?? 0)
        : null;
      if (existing) {
        updateMeta.run(type, expiresAt, setCount, hashCount, zsetCount, now, key);
      } else {
        insert.run(key, type, expiresAt, setCount, hashCount, zsetCount, now);
      }
    },

    setExpires(key, expiresAt, updatedAt) {
      updateExpires.run(expiresAt, updatedAt ?? Date.now(), key);
    },

    bumpVersion(key) {
      updateVersion.run(Date.now(), key);
    },

    setSetCount(key, setCount, options = {}) {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        updateSetCount.run(setCount, options.updatedAt ?? Date.now(), key);
      } else {
        updateSetCountOnly.run(setCount, key);
      }
    },

    incrSetCount(key, delta, options = {}) {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        incrSetCount.run(delta, options.updatedAt ?? Date.now(), key);
      } else {
        incrSetCountOnly.run(delta, key);
      }
    },

    setHashCount(key, hashCount, options = {}) {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        updateHashCount.run(hashCount, options.updatedAt ?? Date.now(), key);
      } else {
        updateHashCountOnly.run(hashCount, key);
      }
    },

    incrHashCount(key, delta, options = {}) {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        incrHashCount.run(delta, options.updatedAt ?? Date.now(), key);
      } else {
        incrHashCountOnly.run(delta, key);
      }
    },

    setZsetCount(key, zsetCount, options = {}) {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        updateZsetCount.run(zsetCount, options.updatedAt ?? Date.now(), key);
      } else {
        updateZsetCountOnly.run(zsetCount, key);
      }
    },

    incrZsetCount(key, delta, options = {}) {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        incrZsetCount.run(delta, options.updatedAt ?? Date.now(), key);
      } else {
        incrZsetCountOnly.run(delta, key);
      }
    },

    delete(key) {
      return deleteByKey.run(key);
    },

    deleteExpired(now) {
      return deleteExpiredStmt.run(now);
    },

    count() {
      return countAll.get() ?? 0;
    },

    scan(limit, offset) {
      return scanKeys.all(limit, offset).map((r) => r.key);
    },
  };
}
