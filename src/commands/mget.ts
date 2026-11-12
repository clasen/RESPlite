/**
 * MGET key [key ...] - returns array of values (null for missing).
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleMget(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'MGET\' command' };
  }
  return engine.mget(args);
}
