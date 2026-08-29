/**
 * Hash storage: redis_hashes + coordination with redis_keys.
 * Empty hash removes the key (Section 8.6).
 * Per-field TTL is tracked in redis_hash_field_ttl (epoch milliseconds);
 * HSET clears a field's TTL, lazy-expiration prunes stale fields.
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

  const getFieldStateStmt = db.prepare(
    `SELECT h.value, t.expires_at AS expiresAt
       FROM redis_hashes h
       LEFT JOIN redis_hash_field_ttl t ON t.key = h.key AND t.field = h.field
      WHERE h.key = ? AND h.field = ?`
  );
  const getAllStmt = db.prepare('SELECT field, value FROM redis_hashes WHERE key = ?').raw(true);
  const getAllLiveStmt = db
    .prepare(
      `SELECT h.field, h.value
         FROM redis_hashes h
         LEFT JOIN redis_hash_field_ttl t ON t.key = h.key AND t.field = h.field
        WHERE h.key = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`
    )
    .raw(true);
  const scanLiveStmt = db
    .prepare(
      `SELECT h.field, h.value
         FROM redis_hashes h
         LEFT JOIN redis_hash_field_ttl t ON t.key = h.key AND t.field = h.field
        WHERE h.key = ? AND (t.expires_at IS NULL OR t.expires_at > ?)
        ORDER BY h.field
        LIMIT ? OFFSET ?`
    )
    .raw(true);
  const scanStmt = db
    .prepare('SELECT field, value FROM redis_hashes WHERE key = ? ORDER BY field LIMIT ? OFFSET ?')
    .raw(true);
  const insertStmt = db.prepare(
    `INSERT INTO redis_hashes (key, field, value) VALUES (?, ?, ?)
     ON CONFLICT(key, field) DO UPDATE SET value = excluded.value`
  );
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

  const upsertFieldTtlStmt = db.prepare(
    `INSERT INTO redis_hash_field_ttl (key, field, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(key, field) DO UPDATE SET expires_at = excluded.expires_at`
  );
  const deleteFieldTtlStmt = db.prepare('DELETE FROM redis_hash_field_ttl WHERE key = ? AND field = ?');
  const fieldStateListStmts = new Map();
  const deleteFieldTtlListStmts = new Map();
  const upsertFieldListStmts = new Map();

  const FLOAT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  function parseFloatValue(value) {
    const text = value.toString('utf8');
    if (!FLOAT_PATTERN.test(text)) {
      throw new Error('ERR hash value is not a float');
    }
    const number = Number(text);
    if (!Number.isFinite(number)) {
      throw new Error('ERR hash value is not a float');
    }
    return number;
  }

  function formatFloatValue(number) {
    const text = String(Object.is(number, -0) ? 0 : number);
    const exponentIndex = text.search(/[eE]/);
    if (exponentIndex === -1) return text;

    const negative = text[0] === '-';
    const unsigned = negative || text[0] === '+' ? text.slice(1) : text;
    const [mantissa, exponentText] = unsigned.toLowerCase().split('e');
    const exponent = Number(exponentText);
    const [integer, fraction = ''] = mantissa.split('.');
    const digits = integer + fraction;
    const decimalIndex = integer.length + exponent;
    let expanded;
    if (decimalIndex <= 0) {
      expanded = `0.${'0'.repeat(-decimalIndex)}${digits}`;
    } else if (decimalIndex >= digits.length) {
      expanded = digits + '0'.repeat(decimalIndex - digits.length);
    } else {
      expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
    }
    return negative ? `-${expanded}` : expanded;
  }

  /**
   * If the field has an expired TTL row, delete the field + TTL row, adjust count
   * (and drop the whole key when empty). Returns true if the field was purged.
   */
  function expireFieldIfDue(key, field, now, state = getFieldStateStmt.get(key, field)) {
    if (!state || state.expiresAt == null || state.expiresAt > now) return false;
    deleteFieldTtlStmt.run(key, field);
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

  function statementForFieldCount(cache, count, buildSql) {
    let statement = cache.get(count);
    if (!statement) {
      statement = db.prepare(buildSql(Array(count).fill('?').join(', ')));
      cache.set(count, statement);
    }
    return statement;
  }

  function getFieldStates(key, fields) {
    const rows = [];
    for (let offset = 0; offset < fields.length; offset += 250) {
      const chunk = fields.slice(offset, offset + 250);
      const statement = statementForFieldCount(
        fieldStateListStmts,
        chunk.length,
        (placeholders) => (
          `SELECT h.field, t.expires_at AS expiresAt
             FROM redis_hashes h
             LEFT JOIN redis_hash_field_ttl t ON t.key = h.key AND t.field = h.field
            WHERE h.key = ? AND h.field IN (${placeholders})`
        )
      );
      rows.push(...statement.all(key, ...chunk));
    }
    return rows;
  }

  function deleteFieldTtls(key, fields) {
    for (let offset = 0; offset < fields.length; offset += 250) {
      const chunk = fields.slice(offset, offset + 250);
      const statement = statementForFieldCount(
        deleteFieldTtlListStmts,
        chunk.length,
        (placeholders) => `DELETE FROM redis_hash_field_ttl WHERE key = ? AND field IN (${placeholders})`
      );
      statement.run(key, ...chunk);
    }
  }

  function upsertFields(key, entries) {
    for (let offset = 0; offset < entries.length; offset += 250) {
      const chunk = entries.slice(offset, offset + 250);
      const statement = statementForFieldCount(
        upsertFieldListStmts,
        chunk.length,
        () => {
          const values = Array(chunk.length).fill('(?, ?, ?)').join(', ');
          return `INSERT INTO redis_hashes (key, field, value) VALUES ${values}
                  ON CONFLICT(key, field) DO UPDATE SET value = excluded.value`;
        }
      );
      const parameters = [];
      for (const { field, value } of chunk) parameters.push(key, field, value);
      statement.run(...parameters);
    }
  }

  function getAllWithMeta(key) {
    const now = clock();
    const hasFieldTtl = !!hasAnyTtlStmt.get(key);
    const values = hasFieldTtl
      ? getAllLiveStmt.all(key, now).flat()
      : getAllStmt.all(key).flat();
    return { values, hasFieldTtl };
  }

  function setPairs(key, pairs, options = {}) {
    return runInTransaction(db, () => {
      const now = options.updatedAt ?? clock();
      let meta = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
        ? options.existingMeta
        : keys.get(key);
      if (meta && meta.type !== KEY_TYPES.HASH) {
        throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      }

      const entriesByField = new Map();
      for (let i = 0; i < pairs.length; i += 2) {
        entriesByField.set(pairs[i].toString('hex'), { field: pairs[i], value: pairs[i + 1] });
      }
      const entries = [...entriesByField.values()];
      const fields = entries.map(({ field }) => field);
      const states = getFieldStates(key, fields);
      const liveFields = new Set();
      let expired = 0;
      let hasTargetTtl = false;
      for (const state of states) {
        if (state.expiresAt != null) hasTargetTtl = true;
        if (state.expiresAt != null && state.expiresAt <= now) expired++;
        else liveFields.add(state.field.toString('hex'));
      }
      const added = entries.reduce(
        (count, { field }) => count + (liveFields.has(field.toString('hex')) ? 0 : 1),
        0
      );

      let knownCount = 0;
      if (meta) {
        keys.bumpVersion(key);
        if (meta.hashCount == null) {
          const row = countStmt.get(key);
          knownCount = (row && row.n) || 0;
          keys.setHashCount(key, knownCount, { touchUpdatedAt: false });
        } else {
          knownCount = meta.hashCount;
        }
      } else {
        keys.set(key, KEY_TYPES.HASH, { updatedAt: now, hashCount: 0, existingMeta: null });
      }

      upsertFields(key, entries);
      if (hasTargetTtl) deleteFieldTtls(key, fields);
      const countDelta = added - expired;
      if (countDelta !== 0) {
        if (meta) keys.incrHashCount(key, countDelta, { touchUpdatedAt: false });
        else keys.setHashCount(key, added, { touchUpdatedAt: false });
      } else if (meta && meta.hashCount == null) {
        keys.setHashCount(key, knownCount, { touchUpdatedAt: false });
      }
      return added;
    });
  }

  return {
    get(key, field) {
      const now = clock();
      const state = getFieldStateStmt.get(key, field);
      if (!state) return null;
      if (state.expiresAt != null && state.expiresAt <= now) {
        runInTransaction(db, () => expireFieldIfDue(key, field, now));
        return null;
      }
      return state.value;
    },

    getAll(key) {
      return getAllWithMeta(key).values;
    },

    getAllWithMeta,

    scan(key, limit, offset) {
      if (!hasAnyTtlStmt.get(key)) return scanStmt.all(key, limit, offset).flat();
      return scanLiveStmt.all(key, clock(), limit, offset).flat();
    },

    set(key, field, value, options = {}) {
      return setPairs(key, [field, value], options);
    },

    setMultiple(key, pairs, options = {}) {
      return setPairs(key, pairs, options);
    },

    setIfAbsent(key, field, value, options = {}) {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? clock();
        let meta = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
          ? options.existingMeta
          : keys.get(key);
        if (meta && meta.type !== KEY_TYPES.HASH) {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }

        const state = getFieldStateStmt.get(key, field);
        if (state && !expireFieldIfDue(key, field, now, state)) return 0;

        meta = keys.get(key);
        if (meta) {
          keys.bumpVersion(key);
          if (meta.hashCount == null) {
            const row = countStmt.get(key);
            keys.setHashCount(key, (row && row.n) || 0, { touchUpdatedAt: false });
          }
        } else {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now, hashCount: 0, existingMeta: null });
        }
        insertStmt.run(key, field, value);
        if (meta) keys.incrHashCount(key, 1, { touchUpdatedAt: false });
        else keys.setHashCount(key, 1, { touchUpdatedAt: false });
        return 1;
      });
    },

    delete(key, fields, options = {}) {
      return runInTransaction(db, () => {
        const meta = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
          ? options.existingMeta
          : keys.get(key);
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

    count(key, options = {}) {
      const meta = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
        ? options.existingMeta
        : keys.get(key);
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
        let meta = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
          ? options.existingMeta
          : keys.get(key);
        if (meta && meta.type !== KEY_TYPES.HASH) {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        const state = getFieldStateStmt.get(key, field);
        expireFieldIfDue(key, field, now, state);
        meta = keys.get(key);
        const cur = state && (state.expiresAt == null || state.expiresAt > now) ? state : null;
        const num = cur == null ? 0 : parseInt(cur.value.toString('utf8'), 10);
        if (Number.isNaN(num)) throw new Error('ERR hash value is not an integer');
        const next = num + delta;

        if (!meta) {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now, hashCount: 0, existingMeta: null });
        } else {
          keys.bumpVersion(key);
          if (meta.hashCount == null) {
            const row = countStmt.get(key);
            keys.setHashCount(key, (row && row.n) || 0, { touchUpdatedAt: false });
          }
        }
        insertStmt.run(key, field, Buffer.from(String(next), 'utf8'));
        if (cur == null) {
          if (meta) keys.incrHashCount(key, 1, { touchUpdatedAt: false });
          else keys.setHashCount(key, 1, { touchUpdatedAt: false });
        }
        return next;
      });
    },

    incrFloat(key, field, delta, options = {}) {
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? clock();
        let meta = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
          ? options.existingMeta
          : keys.get(key);
        if (meta && meta.type !== KEY_TYPES.HASH) {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }

        const state = getFieldStateStmt.get(key, field);
        expireFieldIfDue(key, field, now, state);
        meta = keys.get(key);
        const cur = state && (state.expiresAt == null || state.expiresAt > now) ? state : null;
        const current = cur == null ? 0 : parseFloatValue(cur.value);
        const next = current + delta;
        if (!Number.isFinite(next)) {
          throw new Error('ERR increment would produce NaN or Infinity');
        }

        if (!meta) {
          keys.set(key, KEY_TYPES.HASH, { updatedAt: now, hashCount: 0, existingMeta: null });
        } else {
          keys.bumpVersion(key);
          if (meta.hashCount == null) {
            const row = countStmt.get(key);
            keys.setHashCount(key, (row && row.n) || 0, { touchUpdatedAt: false });
          }
        }
        const value = Buffer.from(formatFloatValue(next), 'utf8');
        insertStmt.run(key, field, value);
        if (cur == null) {
          if (meta) keys.incrHashCount(key, 1, { touchUpdatedAt: false });
          else keys.setHashCount(key, 1, { touchUpdatedAt: false });
        }
        return value;
      });
    },

    /**
     * Per-field expiration set. Returns -2/0/1/2 per HEXPIRE spec.
     * `condition` is null or one of 'NX','XX','GT','LT'.
     */
    setFieldExpire(key, field, expiresAtMs, { condition = null } = {}) {
      return runInTransaction(db, () => {
        const now = clock();
        const state = getFieldStateStmt.get(key, field);
        if (!state || expireFieldIfDue(key, field, now, state)) return -2;
        const currentMs = state.expiresAt ?? null;
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
     * Returns remaining ms plus whether lazy expiration mutated the hash.
     */
    getFieldTtl(key, field) {
      const now = clock();
      const state = getFieldStateStmt.get(key, field);
      if (!state) return { value: -2, expired: false };
      if (state.expiresAt != null && state.expiresAt <= now) {
        runInTransaction(db, () => expireFieldIfDue(key, field, now));
        return { value: -2, expired: true };
      }
      if (state.expiresAt == null) return { value: -1, expired: false };
      return { value: state.expiresAt - now, expired: false };
    },

    /**
     * Returns absolute expiry plus whether lazy expiration mutated the hash.
     */
    getFieldExpireAt(key, field) {
      const now = clock();
      const state = getFieldStateStmt.get(key, field);
      if (!state) return { value: -2, expired: false };
      if (state.expiresAt != null && state.expiresAt <= now) {
        runInTransaction(db, () => expireFieldIfDue(key, field, now));
        return { value: -2, expired: true };
      }
      return { value: state.expiresAt ?? -1, expired: false };
    },

    /**
     * Clears a field's TTL. Returns 1 if cleared, -1 if no TTL, -2 if field missing.
     */
    persistField(key, field) {
      return runInTransaction(db, () => {
        const now = clock();
        const state = getFieldStateStmt.get(key, field);
        if (!state || expireFieldIfDue(key, field, now, state)) return -2;
        if (state.expiresAt == null) return -1;
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
