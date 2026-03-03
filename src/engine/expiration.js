/**
 * Active expiration: background sweeper that deletes expired keys in batches.
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
  let intervalId = null;

  function sweep() {
    const now = clock();
    deleteExpiredStmt.run(now, maxKeysPerSweep);
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
