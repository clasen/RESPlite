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
  const rangeByScoreStmt = db.prepare(
    `SELECT member, score FROM redis_zsets
     WHERE key = ? AND score >= ? AND score <= ?
     ORDER BY score ASC, member ASC
     LIMIT ? OFFSET ?`
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
        if (meta) {
          if (meta.type !== KEY_TYPES.ZSET) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
          keys.bumpVersion(key);
        } else {
          keys.set(key, KEY_TYPES.ZSET, { updatedAt: now });
        }
        const before = countStmt.get(key)?.n ?? 0;
        for (const { score, member } of pairs) {
          upsertStmt.run(key, member, score);
        }
        return (countStmt.get(key)?.n ?? 0) - before;
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

    count(key) {
      const row = countStmt.get(key);
      return row ? row.n : 0;
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
  };
}
