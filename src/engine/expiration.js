/**
 * Active expiration: background sweeper that deletes expired keys in batches.
 * Also prunes expired hash fields (redis_hash_field_ttl) and drops now-empty hashes.
 */

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {() => number} opts.clock
 * @param {number} [opts.sweepIntervalMs=1000]
 * @param {number} [opts.maxKeysPerSweep=500]
 * @returns {{ start: () => void; stop: () => void }}
 */
export function createExpirationSweeper(opts) {
  const { db, clock } = opts;
  const sweepIntervalMs = opts.sweepIntervalMs ?? 1000;
  const maxKeysPerSweep = opts.maxKeysPerSweep ?? 500;

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

  const sweepFieldsTxn = db.transaction((pairs) => {
    const affected = new Map();
    for (const pair of pairs) {
      deleteHashFieldStmt.run(pair.key, pair.field);
      deleteFieldTtlStmt.run(pair.key, pair.field);
      const seenKey = pair.key.toString('base64');
      if (!affected.has(seenKey)) affected.set(seenKey, pair.key);
    }
    for (const key of affected.values()) {
      const row = countHashStmt.get(key);
      const n = row ? row.n : 0;
      if (n === 0) deleteKeyStmt.run(key);
      else updateHashCountStmt.run(n, key);
    }
  });

  let intervalId = null;

  function sweep() {
    const now = clock();
    deleteExpiredStmt.run(now, maxKeysPerSweep);
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
