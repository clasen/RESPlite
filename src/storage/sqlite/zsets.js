/**
 * Sorted set storage: redis_zsets. Empty zset removes the key (SPEC_B Appendix C).
 */

import { KEY_TYPES } from './schema.js';
import { runInTransaction } from './tx.js';

/**
 * Format score for RESP (stable, avoid scientific notation when possible).
 * @param {number} score
 * @returns {string}
 */
function formatScore(score) {
  if (Number.isInteger(score)) return String(score);
  const s = String(score);
  if (s.includes('e') || s.includes('E')) return Number(score).toFixed(6).replace(/\.?0+$/, '');
  return s;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('./keys.js').createKeysStorage>} keys
 */
export function createZsetsStorage(db, keys) {
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
     * @param {Buffer} key
     * @param {{ score: number, member: Buffer }[]} pairs
     * @param {{ updatedAt?: number }} options
     * @returns {number} number of new members added
     */
    add(key, pairs, options = {}) {
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
     * @param {Buffer} key
     * @param {Buffer[]} members
     * @returns {number} number removed
     */
    remove(key, members) {
      return runInTransaction(db, () => {
        const meta = keys.get(key);
        const before = meta && meta.zsetCount != null ? meta.zsetCount : null;
        let n = 0;
        for (const m of members) {
          n += deleteStmt.run(key, m).changes;
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

    count(key) {
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

    score(key, member) {
      const row = scoreStmt.get(key, member);
      return row == null ? null : formatScore(row.score);
    },

    /**
     * Range by rank (0-based). Order: score ASC, member ASC.
     * @param {Buffer} key
     * @param {number} start 0-based inclusive
     * @param {number} stop 0-based inclusive
     * @param {{ withScores?: boolean }} options
     * @returns {Buffer[] | Array<Buffer|string>} members or [member, score, ...]
     */
    rangeByRank(key, start, stop, options = {}) {
      if (start >= 0 && stop >= 0) {
        if (start > stop) return [];
        const rows = rangeByRankStmt.all(key, stop - start + 1, start);
        if (rows.length === 0) return [];
        if (!options.withScores) return rows.map((r) => r.member);
        const out = [];
        for (const r of rows) {
          out.push(r.member, formatScore(r.score));
        }
        return out;
      }
      const len = this.count(key);
      if (len === 0) return [];
      let s = start < 0 ? Math.max(0, len + start) : start;
      let e = stop < 0 ? Math.max(0, len + stop) : stop;
      if (s > e) return [];
      s = Math.min(s, len - 1);
      e = Math.min(e, len - 1);
      const limit = e - s + 1;
      const offset = s;
      const rows = rangeByRankStmt.all(key, limit, offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /**
     * Range by rank in reverse order (ZREVRANGE). Rank 0 = highest score.
     * Same start/stop semantics as rangeByRank; order is score DESC, member DESC.
     * @param {Buffer} key
     * @param {number} start 0-based inclusive (0 = highest score)
     * @param {number} stop 0-based inclusive
     * @param {{ withScores?: boolean }} options
     * @returns {Buffer[] | Array<Buffer|string>} members or [member, score, ...]
     */
    rangeByRankReverse(key, start, stop, options = {}) {
      const len = this.count(key);
      if (len === 0) return [];
      let s = start >= 0 ? start : Math.max(0, len + start);
      let e = stop >= 0 ? stop : Math.max(0, len + stop);
      if (s > e) return [];
      s = Math.min(s, len - 1);
      e = Math.min(e, len - 1);
      const limit = e - s + 1;
      const offset = s;
      const rows = rangeByRankReverseStmt.all(key, limit, offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /**
     * Range by score (min/max inclusive). Order: score ASC, member ASC.
     * @param {Buffer} key
     * @param {number} min
     * @param {number} max
     * @param {{ withScores?: boolean, limit?: number, offset?: number }} options
     */
    rangeByScore(key, min, max, options = {}) {
      const limit = options.limit ?? -1;
      const offset = options.offset ?? 0;
      const rows = rangeByScoreStmt.all(key, min, max, limit < 0 ? 1e9 : limit, offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /**
     * Rank of member in reverse order (ZREVRANK). Rank 0 = highest score.
     * Returns null if key does not exist or member not in set.
     * @param {Buffer} key
     * @param {Buffer} member
     * @returns {number | null} 0-based rank or null
     */
    rankReverse(key, member) {
      const scoreRow = scoreStmt.get(key, member);
      if (scoreRow == null) return null;
      const row = rankReverseStmt.get(key, scoreRow.score, scoreRow.score, member);
      return row ? row.n : 0;
    },

    /**
     * Rank of member in ascending order (ZRANK). Rank 0 = lowest score.
     * Returns null if key does not exist or member not in set.
     * @param {Buffer} key
     * @param {Buffer} member
     * @returns {number | null} 0-based rank or null
     */
    rank(key, member) {
      const scoreRow = scoreStmt.get(key, member);
      if (scoreRow == null) return null;
      const row = rankStmt.get(key, scoreRow.score, scoreRow.score, member);
      return row ? row.n : 0;
    },

    /**
     * Range by score in reverse order (ZREVRANGEBYSCORE). max/min inclusive, order score DESC, member DESC.
     * @param {Buffer} key
     * @param {number} max
     * @param {number} min
     * @param {{ withScores?: boolean, limit?: number, offset?: number }} options
     */
    rangeByScoreReverse(key, max, min, options = {}) {
      const limit = options.limit ?? -1;
      const offset = options.offset ?? 0;
      const rows = rangeByScoreReverseStmt.all(key, max, min, limit < 0 ? 1e9 : limit, offset);
      if (!options.withScores) return rows.map((r) => r.member);
      const out = [];
      for (const r of rows) {
        out.push(r.member, formatScore(r.score));
      }
      return out;
    },

    /** Copy all member/score rows from oldKey to newKey. Caller ensures newKey exists in redis_keys. */
    copyKey(oldKey, newKey) {
      const rows = selectAllStmt.all(oldKey);
      for (const r of rows) {
        upsertStmt.run(newKey, r.member, r.score);
      }
      const sourceMeta = keys.get(oldKey);
      const nextCount = sourceMeta && sourceMeta.zsetCount != null ? sourceMeta.zsetCount : rows.length;
      keys.setZsetCount(newKey, nextCount, { touchUpdatedAt: false });
    },

    countByScore(key, min, max) {
      if (min === Number.NEGATIVE_INFINITY && max === Number.POSITIVE_INFINITY) {
        return this.count(key);
      }
      const row = countByScoreStmt.get(key, min, max);
      return row ? row.n : 0;
    },

    incr(key, member, increment, options = {}) {
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

    removeRangeByRank(key, start, stop) {
      return runInTransaction(db, () => {
        const len = this.count(key);
        if (len === 0) return 0;
        let s = start >= 0 ? start : Math.max(0, len + start);
        let e = stop >= 0 ? stop : Math.max(0, len + stop);
        if (s > e) return 0;
        s = Math.min(s, len - 1);
        e = Math.min(e, len - 1);
        const limit = e - s + 1;
        const offset = s;
        const rows = rangeByRankStmt.all(key, limit, offset);
        let n = 0;
        for (const r of rows) {
          n += deleteStmt.run(key, r.member).changes;
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

    removeRangeByScore(key, min, max) {
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
        return r.changes;
      });
    },
  };
}
