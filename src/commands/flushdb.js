/**
 * FLUSHDB [ASYNC|SYNC] - removes all data from the single database.
 * SQLite executes both accepted modes synchronously.
 */

import { validateFlushMode } from './flush-mode.js';

export function handleFlushdb(engine, args) {
  const error = validateFlushMode('FLUSHDB', args);
  if (error) return { error };
  engine.flushDatabase();
  return { simple: 'OK' };
}
