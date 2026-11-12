/**
 * Sorted set storage: redis_zsets. Empty zset removes the key (SPEC_B Appendix C).
 */

import { KEY_TYPES } from './schema.ts';
import { runInTransaction } from './tx.ts';
import type Database from './driver.ts';
import type { KeysStorage } from './keys.ts';

export interface ZsetRangeOptions {
  withScores?: boolean;
}

export interface ZsetScoreRangeOptions {
  withScores?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Format score for RESP (stable, avoid scientific notation when possible).
 */
function formatScore(score: number): string {
  if (Number.isInteger(score)) return String(score);
  const s = String(score);
  if (s.includes('e') || s.includes('E')) return Number(score).toFixed(6).replace(/\.?0+$/, '');
  return s;
}

export function createZsetsStorage(db: Database, keys: KeysStorage) {
  const upsertStmt = db.prepare(
    `INSERT INTO redis_zsets (key, member, score) VALUES (?, ?, ?)
     ON CONFLICT(key, member) DO UPDATE SET score = excluded.score`
  );
  const insertIgnoreStmt = db.prepare(
    'INSERT OR IGNORE INTO redis_zsets (key, member, score) VALUES (?, ?, ?)'
  );
  const updateScoreStmt = db.prepare(
    'UPDATE redis_zsets SET score = ? WHERE key = ? AND member = ?'
  );
  const deleteStmt = db.prepare('DELETE FROM redis_zsets WHERE key = ? AND member = ?');
  const deleteAllStmt = db.prepare('DELETE FROM redis_zsets WHERE key = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM redis_zsets WHERE key = ?');
  const scoreStmt = db.prepare('SELECT score FROM redis_zsets WHERE key = ? AND member = ? LIMIT 1');
  const rangeByRankStmt = db.prepare(
    `SELECT member, score FROM redis_zsets
     WHERE key = ?
     ORDER BY score ASC, member ASC
     LIMIT ? OFFSET ?`
  );
  const rangeByRankReverseStmt = db.prepare(
    `SELECT member, score FROM redis_zsets
     WHERE key = ?
     ORDER BY score DESC, member DESC
     LIMIT ? OFFSET ?`
  );
  const rangeByScoreStmt = db.prepare(
    `SELECT member, score FROM redis_zsets
     WHERE key = ? AND score >= ? AND score <= ?
     ORDER BY score ASC, member ASC
     LIMIT ? OFFSET ?`
  );
  const rankReverseStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM redis_zsets
     WHERE key = ? AND (score > ? OR (score = ? AND member > ?))`
  );
  const rankStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM redis_zsets
     WHERE key = ? AND (score < ? OR (score = ? AND member < ?))`
  );
  const rangeByScoreReverseStmt = db.prepare(
    `SELECT member, score FROM redis_zsets
     WHERE key = ? AND score <= ? AND score >= ?
     ORDER BY score DESC, member DESC
     LIMIT ? OFFSET ?`
  );
  const selectAllStmt = db.prepare('SELECT member, score FROM redis_zsets WHERE key = ?');
  const countByScoreStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM redis_zsets WHERE key = ? AND score >= ? AND score <= ?'
  );
  const deleteByScoreRangeStmt = db.prepare(
    'DELETE FROM redis_zsets WHERE key = ? AND score >= ? AND score <= ?'
  );

  return {
    /**
     * ZADD minimal v1: add/update score-member pairs. Returns count of NEW members added.
     * @returns number of new members added
     */
    add(key: Buffer, pairs: { score: number; member: Buffer }[], options: { updatedAt?: number } = {}): number {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        let knownCount = 0;
        if (meta) {
          if (meta.type !== KEY_TYPES.ZSET) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
          if (meta.zsetCount == null) {
            const row = countStmt.get(key);
            knownCount = (row && row.n) || 0;
            keys.setZsetCount(key, knownCount, { touchUpdatedAt: false });
          } else {
            knownCount = meta.zsetCount;
          }
        } else {
          keys.set(key, KEY_TYPES.ZSET, { updatedAt: now, zsetCount: 0 });
        }
        let newCount = 0;
        for (const { score, member } of pairs) {
          const inserted = insertIgnoreStmt.run(key, member, score).changes;
          if (inserted > 0) {
            newCount++;
          } else {
            updateScoreStmt.run(score, key, member);
          }
        }
        if (newCount > 0) {
          if (meta) {
            keys.incrZsetCount(key, newCount, { touchUpdatedAt: false });
          } else {
            keys.setZsetCount(key, newCount, { touchUpdatedAt: false });
          }
        } else if (meta && meta.zsetCount == null) {
          // Legacy rows may have null counters; persist the hydrated value.
          keys.setZsetCount(key, knownCount, { touchUpdatedAt: false });
        }
        return newCount;
      });
    },

    /**
     * ZREM: remove members. If zset becomes empty, delete key metadata.
     * @returns number removed
     */
    remove(key: Buffer, members: Buffer[]): number {
      return runInTransaction(db, () => {
        const meta = keys.get(key);
        const before = meta && meta.zsetCount != null ? meta.zsetCount : null;
        let n = 0;
        for (const m of members) {
          n += deleteStmt.run(key, m).changes as number;
        }
        const remaining = before != null ? Math.max(0, before - n) : ((countStmt.get(key) || {}).n || 0);
        if (remaining === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        } else if (n > 0) {
          keys.setZsetCount(key, remaining, { touchUpdatedAt: false });
        }
        return n;
      });
    },

    count(key: Buffer): number {
      const meta = keys.get(key);
      if (meta && meta.type === KEY_TYPES.ZSET && meta.zsetCount != null) {
        return meta.zsetCount;
      }
      const row = countStmt.get(key);
      const n = row ? row.n : 0;
      if (meta && meta.type === KEY_TYPES.ZSET && meta.zsetCount == null) {
        // One-time hydration for databases created before zset_count existed.
        keys.setZsetCount(key, n, { touchUpdatedAt: false });
      }
      return n;
    },

    score(key: Buffer, member: Buffer): string | null {
      const row = scoreStmt.get(key, member);
      return row == null ? null : formatScore(row.score);
    },

    /**
     * Range by rank (0-based). Order: score ASC, member ASC.
     * @param start 0-based inclusive
     * @param stop 0-based inclusive
     * @returns members or [member, score, ...]
     */
    rangeByRank(key: Buffer, start: number, stop: number, options: ZsetRangeOptions = {}): (Buffer | string)[] {
      if (start >= 0 && stop >= 0 && stop < Number.MAX_SAFE_INTEGER) {
        if (start > stop) return [];
        const rows = rangeByRankStmt.all(key, stop - start + 1, start);
        if (rows.length === 0) return [];
        if (!options.withScores) return rows.map((r) => r.member);
        const out: (Buffer | string)[] = [];
        for (const r of rows) {
          out.push(r.member, formatScore(r.score));
        }
        return out;
      }
      const len = this.count(key);
      if (len === 0) return [];
      // Redis: start clamps at 0, a negative stop may fall below 0 so the
      // range collapses, and start >= len is empty.
      const s = start < 0 ? Math.max(0, len + start) : start;
      let e = stop < 0 ? len + stop : stop;
      if (s > e || s >= len) return [];
      e = Math.min(e, len - 1);
      const limit = e - s + 1;
      const offset = s;
      const rows = rangeByRankStmt.all(key, limit, offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out: (Buffer | string)[] = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /**
     * Range by rank in reverse order (ZREVRANGE). Rank 0 = highest score.
     * Same start/stop semantics as rangeByRank; order is score DESC, member DESC.
     * @param start 0-based inclusive (0 = highest score)
     * @param stop 0-based inclusive
     * @returns members or [member, score, ...]
     */
    rangeByRankReverse(key: Buffer, start: number, stop: number, options: ZsetRangeOptions = {}): (Buffer | string)[] {
      const len = this.count(key);
      if (len === 0) return [];
      const s = start >= 0 ? start : Math.max(0, len + start);
      let e = stop >= 0 ? stop : len + stop;
      if (s > e || s >= len) return [];
      e = Math.min(e, len - 1);
      const limit = e - s + 1;
      const offset = s;
      const rows = rangeByRankReverseStmt.all(key, limit, offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out: (Buffer | string)[] = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /**
     * Range by score (min/max inclusive). Order: score ASC, member ASC.
     */
    rangeByScore(key: Buffer, min: number, max: number, options: ZsetScoreRangeOptions = {}): (Buffer | string)[] {
      const limit = options.limit ?? -1;
      const offset = options.offset ?? 0;
      if (offset < 0 || offset > Number.MAX_SAFE_INTEGER) return [];
      const rows = rangeByScoreStmt.all(key, min, max, limit < 0 ? -1 : Math.min(limit, Number.MAX_SAFE_INTEGER), offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out: (Buffer | string)[] = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /**
     * Rank of member in reverse order (ZREVRANK). Rank 0 = highest score.
     * Returns null if key does not exist or member not in set.
     * @returns 0-based rank or null
     */
    rankReverse(key: Buffer, member: Buffer): number | null {
      const scoreRow = scoreStmt.get(key, member);
      if (scoreRow == null) return null;
      const row = rankReverseStmt.get(key, scoreRow.score, scoreRow.score, member);
      return row ? row.n : 0;
    },

    /**
     * Rank of member in ascending order (ZRANK). Rank 0 = lowest score.
     * Returns null if key does not exist or member not in set.
     * @returns 0-based rank or null
     */
    rank(key: Buffer, member: Buffer): number | null {
      const scoreRow = scoreStmt.get(key, member);
      if (scoreRow == null) return null;
      const row = rankStmt.get(key, scoreRow.score, scoreRow.score, member);
      return row ? row.n : 0;
    },

    /**
     * Range by score in reverse order (ZREVRANGEBYSCORE). max/min inclusive, order score DESC, member DESC.
     */
    rangeByScoreReverse(key: Buffer, max: number, min: number, options: ZsetScoreRangeOptions = {}): (Buffer | string)[] {
      const limit = options.limit ?? -1;
      const offset = options.offset ?? 0;
      if (offset < 0 || offset > Number.MAX_SAFE_INTEGER) return [];
      const rows = rangeByScoreReverseStmt.all(key, max, min, limit < 0 ? -1 : Math.min(limit, Number.MAX_SAFE_INTEGER), offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out: (Buffer | string)[] = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /** Copy all member/score rows from oldKey to newKey. Caller ensures newKey exists in redis_keys. */
    copyKey(oldKey: Buffer, newKey: Buffer): void {
      const rows = selectAllStmt.all(oldKey);
      for (const r of rows) {
        upsertStmt.run(newKey, r.member, r.score);
      }
      const sourceMeta = keys.get(oldKey);
      const nextCount = sourceMeta && sourceMeta.zsetCount != null ? sourceMeta.zsetCount : rows.length;
      keys.setZsetCount(newKey, nextCount, { touchUpdatedAt: false });
    },

    countByScore(key: Buffer, min: number, max: number): number {
      if (min === Number.NEGATIVE_INFINITY && max === Number.POSITIVE_INFINITY) {
        return this.count(key);
      }
      const row = countByScoreStmt.get(key, min, max);
      return row ? row.n : 0;
    },

    incr(key: Buffer, member: Buffer, increment: number, options: { updatedAt?: number } = {}): string {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const meta = keys.get(key);
        if (meta && meta.type !== KEY_TYPES.ZSET) {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        if (!meta) {
          keys.set(key, KEY_TYPES.ZSET, { updatedAt: now, zsetCount: 0 });
        } else {
          keys.bumpVersion(key);
          if (meta.zsetCount == null) {
            const row = countStmt.get(key);
            const hydrated = (row && row.n) || 0;
            keys.setZsetCount(key, hydrated, { touchUpdatedAt: false });
          }
        }
        const cur = scoreStmt.get(key, member);
        const prev = cur == null ? 0 : cur.score;
        const next = prev + increment;
        upsertStmt.run(key, member, next);
        if (cur == null) {
          if (meta) keys.incrZsetCount(key, 1, { touchUpdatedAt: false });
          else keys.setZsetCount(key, 1, { touchUpdatedAt: false });
        }
        return formatScore(next);
      });
    },

    removeRangeByRank(key: Buffer, start: number, stop: number): number {
      return runInTransaction(db, () => {
        const len = this.count(key);
        if (len === 0) return 0;
        const s = start >= 0 ? start : Math.max(0, len + start);
        let e = stop >= 0 ? stop : len + stop;
        if (s > e || s >= len) return 0;
        e = Math.min(e, len - 1);
        const limit = e - s + 1;
        const offset = s;
        const rows = rangeByRankStmt.all(key, limit, offset);
        let n = 0;
        for (const r of rows) {
          n += deleteStmt.run(key, r.member).changes as number;
        }
        const row = countStmt.get(key);
        const remaining = (row && row.n) || 0;
        if (remaining === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        } else if (n > 0) {
          keys.setZsetCount(key, remaining, { touchUpdatedAt: false });
        }
        return n;
      });
    },

    removeRangeByScore(key: Buffer, min: number, max: number): number {
      return runInTransaction(db, () => {
        const r = deleteByScoreRangeStmt.run(key, min, max);
        const remaining = countStmt.get(key);
        const n = (remaining && remaining.n) || 0;
        if (n === 0) {
          deleteAllStmt.run(key);
          keys.delete(key);
        } else if (r.changes > 0) {
          keys.bumpVersion(key);
          keys.setZsetCount(key, n, { touchUpdatedAt: false });
        }
        return r.changes as number;
      });
    },
  };
}

export type ZsetsStorage = ReturnType<typeof createZsetsStorage>;
