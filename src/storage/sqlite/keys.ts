/**
 * CRUD for redis_keys table.
 */

import { KEY_TYPES } from './schema.ts';
import type Database from './driver.ts';

/** A redis_keys row. expiresAt is a BigInt when it exceeds the safe integer range. */
export interface KeyMeta {
  key: Buffer;
  type: number;
  expiresAt: number | bigint | null;
  setCount: number | null;
  hashCount: number | null;
  zsetCount: number | null;
  version: number;
  updatedAt: number;
}

export interface KeySetOptions {
  updatedAt?: number;
  expiresAt?: number | bigint | null;
  existingMeta?: KeyMeta | null;
  setCount?: number | null;
  hashCount?: number | null;
  zsetCount?: number | null;
}

export interface CountUpdateOptions {
  touchUpdatedAt?: boolean;
  updatedAt?: number;
}

export function createKeysStorage(db: Database) {
  const getByKey = db.prepare(
    'SELECT key, type, CASE WHEN expires_at > 9007199254740991 THEN CAST(expires_at AS TEXT) ELSE expires_at END AS expiresAt, set_count AS setCount, hash_count AS hashCount, zset_count AS zsetCount, version, updated_at AS updatedAt FROM redis_keys WHERE key = ?'
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
  const deleteAll = db.prepare('DELETE FROM redis_keys');
  const deleteExpiredStmt = db.prepare('DELETE FROM redis_keys WHERE expires_at IS NOT NULL AND expires_at <= ?');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM redis_keys').pluck();
  const countLive = db.prepare(
    `SELECT COUNT(*) AS n
       FROM redis_keys k
      WHERE (k.expires_at IS NULL OR k.expires_at > ?)
        AND (
          k.type != ?
          OR EXISTS (
            SELECT 1
              FROM redis_hashes h
             WHERE h.key = k.key
               AND NOT EXISTS (
                 SELECT 1 FROM redis_hash_field_ttl t
                  WHERE t.key = h.key AND t.field = h.field AND t.expires_at <= ?
               )
          )
        )`
  ).pluck();
  const scanKeys = db.prepare(
    'SELECT key FROM redis_keys ORDER BY key LIMIT ? OFFSET ?'
  );

  return {
    KEY_TYPES,

    get(key: Buffer): KeyMeta | null {
      const row = getByKey.get(key);
      if (row && typeof row.expiresAt === 'string') row.expiresAt = BigInt(row.expiresAt);
      return row ? { ...row, key: row.key } : null;
    },

    set(key: Buffer, type: number, options: KeySetOptions = {}): void {
      const now = options.updatedAt ?? Date.now();
      const expiresAt = options.expiresAt ?? null;
      const existing: KeyMeta | null | undefined = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
        ? options.existingMeta
        : getByKey.get(key);
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

    setExpires(key: Buffer, expiresAt: number | bigint | null, updatedAt?: number): void {
      updateExpires.run(expiresAt, updatedAt ?? Date.now(), key);
    },

    bumpVersion(key: Buffer): void {
      updateVersion.run(Date.now(), key);
    },

    setSetCount(key: Buffer, setCount: number, options: CountUpdateOptions = {}): void {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        updateSetCount.run(setCount, options.updatedAt ?? Date.now(), key);
      } else {
        updateSetCountOnly.run(setCount, key);
      }
    },

    incrSetCount(key: Buffer, delta: number, options: CountUpdateOptions = {}): void {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        incrSetCount.run(delta, options.updatedAt ?? Date.now(), key);
      } else {
        incrSetCountOnly.run(delta, key);
      }
    },

    setHashCount(key: Buffer, hashCount: number, options: CountUpdateOptions = {}): void {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        updateHashCount.run(hashCount, options.updatedAt ?? Date.now(), key);
      } else {
        updateHashCountOnly.run(hashCount, key);
      }
    },

    incrHashCount(key: Buffer, delta: number, options: CountUpdateOptions = {}): void {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        incrHashCount.run(delta, options.updatedAt ?? Date.now(), key);
      } else {
        incrHashCountOnly.run(delta, key);
      }
    },

    setZsetCount(key: Buffer, zsetCount: number, options: CountUpdateOptions = {}): void {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        updateZsetCount.run(zsetCount, options.updatedAt ?? Date.now(), key);
      } else {
        updateZsetCountOnly.run(zsetCount, key);
      }
    },

    incrZsetCount(key: Buffer, delta: number, options: CountUpdateOptions = {}): void {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      if (touchUpdatedAt) {
        incrZsetCount.run(delta, options.updatedAt ?? Date.now(), key);
      } else {
        incrZsetCountOnly.run(delta, key);
      }
    },

    delete(key: Buffer) {
      return deleteByKey.run(key);
    },

    deleteAll() {
      return deleteAll.run().changes;
    },

    deleteExpired(now: number) {
      return deleteExpiredStmt.run(now);
    },

    count(): number {
      return countAll.get() ?? 0;
    },

    countLive(now: number): number {
      return countLive.get(now, KEY_TYPES.HASH, now) ?? 0;
    },

    scan(limit: number, offset: number): Buffer[] {
      return scanKeys.all(limit, offset).map((r) => r.key);
    },
  };
}

export type KeysStorage = ReturnType<typeof createKeysStorage>;
