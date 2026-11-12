/**
 * Active expiration: background sweeper that deletes expired keys in batches.
 * Also prunes expired hash fields (redis_hash_field_ttl) and drops now-empty hashes.
 */

import type Database from '../storage/sqlite/driver.ts';
import type { Row } from '../storage/sqlite/driver.ts';
import { getKeyCounter } from '../storage/sqlite/keys.ts';

export interface ExpirationSweeperOptions {
  db: Database;
  clock: () => number;
  /** Defaults to 1000. */
  sweepIntervalMs?: number;
  /** Defaults to 500. */
  maxKeysPerSweep?: number;
}

export interface ExpirationSweeper {
  start: () => void;
  stop: () => void;
}

export function createExpirationSweeper(opts: ExpirationSweeperOptions): ExpirationSweeper {
  const { db, clock } = opts;
  const sweepIntervalMs = opts.sweepIntervalMs ?? 1000;
  const maxKeysPerSweep = opts.maxKeysPerSweep ?? 500;
  const keyCounter = getKeyCounter(db);

  const deleteExpiredStmt = db.prepare(
    'DELETE FROM redis_keys WHERE key IN (SELECT key FROM redis_keys WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?)'
  );
  const selectExpiredFieldsStmt = db.prepare(
    'SELECT key, field FROM redis_hash_field_ttl WHERE expires_at <= ? LIMIT ?'
  );
  const deleteHashFieldStmt = db.prepare('DELETE FROM redis_hashes WHERE key = ? AND field = ?');
  const deleteFieldTtlStmt = db.prepare('DELETE FROM redis_hash_field_ttl WHERE key = ? AND field = ?');
  const countHashStmt = db.prepare('SELECT COUNT(*) AS n FROM redis_hashes WHERE key = ?');
  const updateHashCountStmt = db.prepare('UPDATE redis_keys SET hash_count = ? WHERE key = ?');
  const deleteKeyStmt = db.prepare('DELETE FROM redis_keys WHERE key = ?');

  const sweepFieldsTxn = db.transaction((pairs: Row[]) => {
    const affected = new Map<string, Buffer>();
    for (const pair of pairs) {
      deleteHashFieldStmt.run(pair.key, pair.field);
      deleteFieldTtlStmt.run(pair.key, pair.field);
      const seenKey = pair.key.toString('base64');
      if (!affected.has(seenKey)) affected.set(seenKey, pair.key);
    }
    for (const key of affected.values()) {
      const row = countHashStmt.get(key);
      const n = row ? row.n : 0;
      if (n === 0) keyCounter.add(-deleteKeyStmt.run(key).changes);
      else updateHashCountStmt.run(n, key);
    }
  });

  let intervalId: NodeJS.Timeout | null = null;

  function sweep(): void {
    const now = clock();
    keyCounter.add(-deleteExpiredStmt.run(now, maxKeysPerSweep).changes);
    const pairs = selectExpiredFieldsStmt.all(now, maxKeysPerSweep);
    if (pairs.length > 0) sweepFieldsTxn(pairs);
  }

  return {
    start() {
      if (intervalId != null) return;
      intervalId = setInterval(sweep, sweepIntervalMs);
    },
    stop() {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
}
