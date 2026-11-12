/**
 * String storage: redis_strings + coordination with redis_keys.
 */

import { KEY_TYPES } from './schema.ts';
import { runInTransaction } from './tx.ts';
import type Database from './driver.ts';
import type { KeyMeta, KeysStorage } from './keys.ts';

export interface StringSetOptions {
  updatedAt?: number;
  expiresAt?: number | bigint | null;
  existingMeta?: KeyMeta | null;
  replaceForeignType?: boolean;
}

export function createStringsStorage(db: Database, keys: KeysStorage) {
  const getStmt = db.prepare('SELECT value FROM redis_strings WHERE key = ?');
  const insertStmt = db.prepare('INSERT INTO redis_strings (key, value) VALUES (?, ?)');
  const updateStmt = db.prepare('UPDATE redis_strings SET value = ? WHERE key = ?');
  const deleteStmt = db.prepare('DELETE FROM redis_strings WHERE key = ?');

  function _setOne(key: Buffer, value: Buffer, options: StringSetOptions): void {
    const now = options.updatedAt ?? Date.now();
    const expiresAt = options.expiresAt ?? null;
    let meta = Object.prototype.hasOwnProperty.call(options, 'existingMeta')
      ? options.existingMeta
      : keys.get(key);
    if (meta && meta.type !== KEY_TYPES.STRING) {
      if (!options.replaceForeignType) {
        throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      }
      // Redis replaces a key of any type on an unconditional string write; deleting the
      // keyspace row cascades to the rows of the previous type.
      keys.delete(key);
      meta = null;
    }
    if (meta) {
      keys.set(key, KEY_TYPES.STRING, { expiresAt, updatedAt: now, existingMeta: meta });
      updateStmt.run(value, key);
    } else {
      keys.set(key, KEY_TYPES.STRING, { expiresAt, updatedAt: now, existingMeta: null });
      insertStmt.run(key, value);
    }
  }

  return {
    get(key: Buffer): Buffer | null {
      const row = getStmt.get(key);
      return row ? row.value : null;
    },

    set(key: Buffer, value: Buffer, options: StringSetOptions = {}): void {
      runInTransaction(db, () => _setOne(key, value, options));
    },

    /**
     * Batch set: all key/value pairs in a single transaction.
     */
    setMultiple(entries: { key: Buffer; value: Buffer; options?: StringSetOptions }[]): void {
      runInTransaction(db, () => {
        for (const entry of entries) {
          _setOne(entry.key, entry.value, entry.options || {});
        }
      });
    },

    delete(key: Buffer): void {
      runInTransaction(db, () => {
        deleteStmt.run(key);
        keys.delete(key);
      });
    },

    /**
     * Copy key's value to newKey. Caller must ensure newKey row exists in redis_keys.
     */
    copyKey(oldKey: Buffer, newKey: Buffer): void {
      const row = getStmt.get(oldKey);
      if (row) insertStmt.run(newKey, row.value);
    },
  };
}

export type StringsStorage = ReturnType<typeof createStringsStorage>;
