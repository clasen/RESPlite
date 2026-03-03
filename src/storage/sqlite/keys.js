/**
 * CRUD for redis_keys table.
 */

import { KEY_TYPES } from './schema.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createKeysStorage(db) {
  const getByKey = db.prepare(
    'SELECT key, type, expires_at AS expiresAt, version, updated_at AS updatedAt FROM redis_keys WHERE key = ?'
  );
  const insert = db.prepare(
    `INSERT INTO redis_keys (key, type, expires_at, version, updated_at) VALUES (?, ?, ?, 1, ?)`
  );
  const updateMeta = db.prepare(
    'UPDATE redis_keys SET type = ?, expires_at = ?, version = version + 1, updated_at = ? WHERE key = ?'
  );
  const updateExpires = db.prepare('UPDATE redis_keys SET expires_at = ?, updated_at = ? WHERE key = ?');
  const updateVersion = db.prepare('UPDATE redis_keys SET version = version + 1, updated_at = ? WHERE key = ?');
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
      if (existing) {
        updateMeta.run(type, expiresAt, now, key);
      } else {
        insert.run(key, type, expiresAt, now);
      }
    },

    setExpires(key, expiresAt, updatedAt) {
      updateExpires.run(expiresAt, updatedAt ?? Date.now(), key);
    },

    bumpVersion(key) {
      updateVersion.run(Date.now(), key);
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
