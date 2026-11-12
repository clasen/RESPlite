/**
 * DBSIZE - returns the number of logical keys in the single database.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleDbsize(engine: Engine, args: Buffer[]): CommandReply {
  if (args && args.length !== 0) {
    return { error: 'ERR wrong number of arguments for \'DBSIZE\' command' };
  }
  return engine.dbsize();
}
