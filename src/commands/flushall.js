/**
 * FLUSHALL [ASYNC|SYNC] - single-database alias for FLUSHDB.
 * SQLite executes both accepted modes synchronously.
 */

import { validateFlushMode } from './flush-mode.js';

export function handleFlushall(engine, args) {
  const error = validateFlushMode('FLUSHALL', args);
  if (error) return { error };
  engine.flushDatabase();
  return { simple: 'OK' };
}
