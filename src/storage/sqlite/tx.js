/**
 * Transaction helper for multi-step storage operations.
 */

/**
 * Run fn inside a transaction. If fn throws, transaction is rolled back.
 * @param {import('better-sqlite3').Database} db
 * @param {() => void} fn
 */
export function runInTransaction(db, fn) {
  const tx = db.transaction(fn);
  return tx();
}
