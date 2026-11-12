/**
 * FLUSHDB [ASYNC|SYNC] - removes all data from the single database.
 * SQLite executes both accepted modes synchronously.
 */

import { validateFlushMode } from './flush-mode.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFlushdb(engine: Engine, args: Buffer[]): CommandReply {
  const error = validateFlushMode('FLUSHDB', args);
  if (error) return { error };
  engine.flushDatabase();
  return { simple: 'OK' };
}
