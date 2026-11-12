/**
 * DEL key [key ...] - returns count of removed keys.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleDel(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'DEL\' command' };
  }
  const n = engine.del(args);
  return n;
}
