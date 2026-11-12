/**
 * Transaction helper for multi-step storage operations.
 */

import type Database from './driver.ts';

/**
 * Run fn inside a transaction. If fn throws, transaction is rolled back.
 */
export function runInTransaction<T>(db: Database, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx();
}
