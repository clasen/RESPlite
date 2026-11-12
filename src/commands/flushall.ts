/**
 * FLUSHALL [ASYNC|SYNC] - single-database alias for FLUSHDB.
 * SQLite executes both accepted modes synchronously.
 */

import { validateFlushMode } from './flush-mode.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleFlushall(engine: Engine, args: Buffer[]): CommandReply {
  const error = validateFlushMode('FLUSHALL', args);
  if (error) return { error };
  engine.flushDatabase();
  return { simple: 'OK' };
}
