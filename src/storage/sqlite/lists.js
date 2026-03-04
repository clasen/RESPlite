/**
 * List storage: redis_list_meta + redis_list_items (SPEC_B).
 * Monotonic sequence per key; empty list = no meta row.
 */

import { KEY_TYPES } from './schema.js';
import { runInTransaction } from './tx.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('./keys.js').createKeysStorage>} keys
 */
export function createListsStorage(db, keys) {
  const getMetaStmt = db.prepare(
    'SELECT head_seq AS headSeq, tail_seq AS tailSeq FROM redis_list_meta WHERE key = ?'
  );
  const insertMetaStmt = db.prepare(
    'INSERT INTO redis_list_meta (key, head_seq, tail_seq) VALUES (?, ?, ?)'
  );
  const updateMetaStmt = db.prepare(
    'UPDATE redis_list_meta SET head_seq = ?, tail_seq = ? WHERE key = ?'
  );
  const deleteMetaStmt = db.prepare('DELETE FROM redis_list_meta WHERE key = ?');

  const insertItemStmt = db.prepare(
    'INSERT INTO redis_list_items (key, seq, value) VALUES (?, ?, ?)'
  );
  const deleteItemStmt = db.prepare(
    'DELETE FROM redis_list_items WHERE key = ? AND seq = ?'
  );
  const selectRangeStmt = db.prepare(
    'SELECT value FROM redis_list_items WHERE key = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC'
  );
  const selectBySeqStmt = db.prepare(
    'SELECT value FROM redis_list_items WHERE key = ? AND seq = ?'
  );
  const deleteRangeStmt = db.prepare(
    'DELETE FROM redis_list_items WHERE key = ? AND seq BETWEEN ? AND ?'
  );
  const selectAllWithSeqStmt = db.prepare(
    'SELECT seq, value FROM redis_list_items WHERE key = ? ORDER BY seq ASC'
  );
  const deleteAllItemsStmt = db.prepare('DELETE FROM redis_list_items WHERE key = ?');

  function getMeta(key) {
    return getMetaStmt.get(key) || null;
  }

  function length(meta) {
    if (!meta) return 0;
    return meta.tailSeq - meta.headSeq + 1;
  }

  return {
    lpush(key, values, options = {}) {
      if (!values || values.length === 0) return 0;
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const keyMeta = keys.get(key);
        if (keyMeta) {
          if (keyMeta.type !== KEY_TYPES.LIST) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
        } else {
          keys.set(key, KEY_TYPES.LIST, { updatedAt: now });
        }

        const existing = getMeta(key);
        if (!existing) {
          // New list: LPUSH v1 v2 v3 -> [v3, v2, v1], seq 0,1,2
          const headSeq = 0;
          const tailSeq = values.length - 1;
          for (let i = 0; i < values.length; i++) {
            insertItemStmt.run(key, i, values[values.length - 1 - i]);
          }
          insertMetaStmt.run(key, headSeq, tailSeq);
        } else {
          const startSeq = existing.headSeq - values.length;
          for (let i = 0; i < values.length; i++) {
            insertItemStmt.run(key, startSeq + i, values[values.length - 1 - i]);
          }
          updateMetaStmt.run(startSeq, existing.tailSeq, key);
        }
        keys.bumpVersion(key);
        return length(getMeta(key));
      });
    },

    rpush(key, values, options = {}) {
      if (!values || values.length === 0) return 0;
      return runInTransaction(db, () => {
        const now = options.updatedAt ?? Date.now();
        const keyMeta = keys.get(key);
        if (keyMeta) {
          if (keyMeta.type !== KEY_TYPES.LIST) {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
          }
        } else {
          keys.set(key, KEY_TYPES.LIST, { updatedAt: now });
        }

        const existing = getMeta(key);
        if (!existing) {
          const headSeq = 0;
          const tailSeq = values.length - 1;
          for (let i = 0; i < values.length; i++) {
            insertItemStmt.run(key, i, values[i]);
          }
          insertMetaStmt.run(key, headSeq, tailSeq);
        } else {
          const startSeq = existing.tailSeq + 1;
          for (let i = 0; i < values.length; i++) {
            insertItemStmt.run(key, startSeq + i, values[i]);
          }
          updateMetaStmt.run(existing.headSeq, startSeq + values.length - 1, key);
        }
        keys.bumpVersion(key);
        return length(getMeta(key));
      });
    },

    llen(key) {
      const meta = getMeta(key);
      return length(meta);
    },

    lrange(key, start, stop) {
      const meta = getMeta(key);
      const len = length(meta);
      if (len === 0) return [];

      // Redis: 0-based, negative from end. Clamp to [0, len-1]
      let s = start < 0 ? Math.max(0, len + start) : Math.min(start, len - 1);
      let e = stop < 0 ? Math.max(0, len + stop) : Math.min(stop, len - 1);
      if (s > e) return [];

      const seqStart = meta.headSeq + s;
      const seqStop = meta.headSeq + e;
      const rows = selectRangeStmt.all(key, seqStart, seqStop);
      return rows.map((r) => r.value);
    },

    lindex(key, index) {
      const meta = getMeta(key);
      const len = length(meta);
      if (len === 0) return null;
      const i = index < 0 ? len + index : index;
      if (i < 0 || i >= len) return null;
      const seq = meta.headSeq + i;
      const row = selectBySeqStmt.get(key, seq);
      return row ? row.value : null;
    },

    lpop(key, count = null) {
      const meta = getMeta(key);
      const len = length(meta);
      if (len === 0) return count != null && count > 0 ? [] : null;

      if (count == null || count <= 0) {
        return runInTransaction(db, () => {
          const seq = meta.headSeq;
          const row = selectBySeqStmt.get(key, seq);
          const value = row ? row.value : null;
          deleteItemStmt.run(key, seq);
          const newHead = meta.headSeq + 1;
          if (newHead > meta.tailSeq) {
            deleteMetaStmt.run(key);
            keys.delete(key);
          } else {
            updateMetaStmt.run(newHead, meta.tailSeq, key);
            keys.bumpVersion(key);
          }
          return value;
        });
      }

      return runInTransaction(db, () => {
        const take = Math.min(count, len);
        const seqEnd = meta.headSeq + take - 1;
        const rows = selectRangeStmt.all(key, meta.headSeq, seqEnd);
        const values = rows.map((r) => r.value);
        deleteRangeStmt.run(key, meta.headSeq, seqEnd);
        const newHead = meta.headSeq + take;
        if (newHead > meta.tailSeq) {
          deleteMetaStmt.run(key);
          keys.delete(key);
        } else {
          updateMetaStmt.run(newHead, meta.tailSeq, key);
          keys.bumpVersion(key);
        }
        return values;
      });
    },

    rpop(key, count = null) {
      const meta = getMeta(key);
      const len = length(meta);
      if (len === 0) return count != null && count > 0 ? [] : null;

      if (count == null || count <= 0) {
        return runInTransaction(db, () => {
          const seq = meta.tailSeq;
          const row = selectBySeqStmt.get(key, seq);
          const value = row ? row.value : null;
          deleteItemStmt.run(key, seq);
          const newTail = meta.tailSeq - 1;
          if (meta.headSeq > newTail) {
            deleteMetaStmt.run(key);
            keys.delete(key);
          } else {
            updateMetaStmt.run(meta.headSeq, newTail, key);
            keys.bumpVersion(key);
          }
          return value;
        });
      }

      return runInTransaction(db, () => {
        const take = Math.min(count, len);
        const seqStart = meta.tailSeq - take + 1;
        const rows = selectRangeStmt.all(key, seqStart, meta.tailSeq);
        // Redis returns rightmost (tail) first, so reverse the order
        const values = rows.map((r) => r.value).reverse();
        deleteRangeStmt.run(key, seqStart, meta.tailSeq);
        const newTail = meta.tailSeq - take;
        if (meta.headSeq > newTail) {
          deleteMetaStmt.run(key);
          keys.delete(key);
        } else {
          updateMetaStmt.run(meta.headSeq, newTail, key);
          keys.bumpVersion(key);
        }
        return values;
      });
    },

    lrem(key, count, element) {
      return runInTransaction(db, () => {
        const meta = getMeta(key);
        if (!meta) return 0;

        const allItems = selectAllWithSeqStmt.all(key);
        const matches = allItems.filter((item) => {
          const v = item.value;
          return Buffer.isBuffer(v) && Buffer.isBuffer(element)
            ? v.equals(element)
            : String(v) === String(element);
        });

        if (matches.length === 0) return 0;

        let toDelete;
        if (count === 0) {
          toDelete = matches;
        } else if (count > 0) {
          toDelete = matches.slice(0, count);
        } else {
          toDelete = matches.slice(count);
        }

        for (const item of toDelete) {
          deleteItemStmt.run(key, item.seq);
        }

        const remaining = selectAllWithSeqStmt.all(key);
        if (remaining.length === 0) {
          deleteMetaStmt.run(key);
          keys.delete(key);
        } else {
          deleteAllItemsStmt.run(key);
          const baseSeq = meta.headSeq;
          for (let i = 0; i < remaining.length; i++) {
            insertItemStmt.run(key, baseSeq + i, remaining[i].value);
          }
          updateMetaStmt.run(baseSeq, baseSeq + remaining.length - 1, key);
          keys.bumpVersion(key);
        }

        return toDelete.length;
      });
    },
  };
}
