/**
 * SQLite driver on node:sqlite, which both Node and Bun provide.
 * Exposes the small statement/transaction surface RESPLite uses and returns BLOB
 * columns as Buffer (node:sqlite returns Uint8Array).
 */

import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSyncOptions, SQLInputValue, StatementResultingChanges, StatementSync } from 'node:sqlite';

/** Column value as read back: BLOBs become Buffers, INTEGERs are BigInt with safeIntegers(). */
export type SqlValue = null | number | bigint | string | Buffer;
/**
 * A row keyed by column name. Columns are typed `any` because each query
 * defines its own shape; storage modules narrow them at the call site.
 */
export type Row = Record<string, any>;
export type { SQLInputValue };

function toBuffer(value: unknown): SqlValue {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : (value as SqlValue);
}

function normalizeValues(values: unknown[]): SqlValue[] {
  for (let i = 0; i < values.length; i++) values[i] = toBuffer(values[i]);
  return values as SqlValue[];
}

/**
 * Statements always read rows as arrays: building plain objects from column
 * names is faster than copying node:sqlite's null-prototype row objects.
 */
export class Statement {
  #stmt: StatementSync;
  #mode: 'object' | 'raw' | 'pluck' = 'object';
  #names: string[] | null = null;

  constructor(stmt: StatementSync) {
    this.#stmt = stmt;
    stmt.setReturnArrays(true);
  }

  /** Return only the first column of each row. */
  pluck(toggle = true): this {
    this.#mode = toggle ? 'pluck' : 'object';
    return this;
  }

  /** Return rows as arrays of column values. */
  raw(toggle = true): this {
    this.#mode = toggle ? 'raw' : 'object';
    return this;
  }

  #toRow(values: unknown[]): any {
    if (this.#mode === 'pluck') return toBuffer(values[0]);
    if (this.#mode === 'raw') return normalizeValues(values);
    const names = (this.#names ??= this.#stmt.columns().map((column) => column.name));
    const row: Row = {};
    for (let i = 0; i < names.length; i++) row[names[i]] = toBuffer(values[i]);
    return row;
  }

  /** Read INTEGER columns as BigInt. */
  safeIntegers(toggle = true): this {
    this.#stmt.setReadBigInts(toggle);
    return this;
  }

  run(...params: SQLInputValue[]): StatementResultingChanges {
    return this.#stmt.run(...params);
  }

  /** Row object, value array (raw) or first column (pluck); undefined when no row matches. */
  get(...params: SQLInputValue[]): any {
    const values = this.#stmt.get(...params) as unknown[] | undefined;
    return values === undefined ? undefined : this.#toRow(values);
  }

  all(...params: SQLInputValue[]): any[] {
    const rows = this.#stmt.all(...params) as unknown[];
    for (let i = 0; i < rows.length; i++) rows[i] = this.#toRow(rows[i] as unknown[]);
    return rows;
  }
}

type AnyFunction = (...args: any[]) => any;

export default class Database {
  #db: DatabaseSync;
  #savepointDepth = 0;
  readonly name: string;

  /**
   * @param filename - Database file path or ':memory:'
   */
  constructor(filename: string, options: DatabaseSyncOptions = {}) {
    this.#db = new DatabaseSync(filename, { enableForeignKeyConstraints: false, ...options });
    this.name = filename;
  }

  prepare(sql: string): Statement {
    return new Statement(this.#db.prepare(sql));
  }

  exec(sql: string): this {
    this.#db.exec(sql);
    return this;
  }

  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  /**
   * Wrap fn so each call runs in a transaction; nested calls use savepoints.
   * The `.immediate` variant takes the write lock at BEGIN.
   */
  transaction<F extends AnyFunction>(fn: F): F & { immediate: F } {
    const wrapped = this.#wrapTransaction(fn, 'BEGIN') as F & { immediate: F };
    wrapped.immediate = this.#wrapTransaction(fn, 'BEGIN IMMEDIATE');
    return wrapped;
  }

  #wrapTransaction<F extends AnyFunction>(fn: F, begin: string): F {
    const db = this.#db;
    return ((...args: Parameters<F>): ReturnType<F> => {
      const nested = db.isTransaction;
      const savepoint = `resplite_sp_${this.#savepointDepth}`;
      if (nested) {
        db.exec(`SAVEPOINT ${savepoint}`);
        this.#savepointDepth++;
      } else {
        db.exec(begin);
      }
      try {
        const result = fn(...args);
        db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (err) {
        if (db.isTransaction) {
          if (nested) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          else db.exec('ROLLBACK');
        }
        throw err;
      } finally {
        if (nested) this.#savepointDepth--;
      }
    }) as F;
  }

  close(): void {
    this.#db.close();
  }
}
