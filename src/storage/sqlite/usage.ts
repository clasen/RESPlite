/**
 * Size and keyspace aggregates for INFO and MEMORY introspection.
 */

import { KEY_TYPES } from './schema.ts';
import type Database from './driver.ts';
import type { Statement } from './driver.ts';

/** Stored size of a score (SQLite REAL). */
const SCORE_BYTES = 8;

export function createUsageStorage(db: Database) {
  const payloadByType = new Map<number, Statement>([
    [KEY_TYPES.STRING, db.prepare('SELECT length(value) FROM redis_strings WHERE key = ?').pluck()],
    [KEY_TYPES.HASH, db.prepare('SELECT SUM(length(field) + length(value)) FROM redis_hashes WHERE key = ?').pluck()],
    [KEY_TYPES.SET, db.prepare('SELECT SUM(length(member)) FROM redis_sets WHERE key = ?').pluck()],
    [KEY_TYPES.LIST, db.prepare('SELECT SUM(length(value)) FROM redis_list_items WHERE key = ?').pluck()],
    [KEY_TYPES.ZSET, db.prepare(`SELECT SUM(length(member) + ${SCORE_BYTES}) FROM redis_zsets WHERE key = ?`).pluck()],
  ]);
  const expiringStmt = db.prepare(
    'SELECT COUNT(*) AS count, AVG(expires_at - ?) AS avgTtl FROM redis_keys WHERE expires_at IS NOT NULL AND expires_at > ?'
  );
  const pageCountStmt = db.prepare('PRAGMA page_count').pluck();
  const pageSizeStmt = db.prepare('PRAGMA page_size').pluck();

  return {
    /** Bytes of key name plus stored payload (fields, members, items, scores). */
    keyBytes(key: Buffer, type: number): number {
      const stmt = payloadByType.get(type);
      if (!stmt) throw new Error(`ERR unknown key type ${type}`);
      return key.length + (stmt.get(key) ?? 0);
    },

    /** Keys with a future expiration and their mean remaining TTL in ms. */
    expiring(now: number): { count: number; avgTtlMs: number } {
      const row = expiringStmt.get(now, now);
      return { count: row.count, avgTtlMs: Math.round(row.avgTtl ?? 0) };
    },

    /** SQLite main database size in bytes (excludes WAL). */
    databaseBytes(): number {
      return pageCountStmt.get() * pageSizeStmt.get();
    },
  };
}
