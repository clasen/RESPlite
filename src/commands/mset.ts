/**
 * MSET key value [key value ...] - sets multiple keys.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleMset(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2 || args.length % 2 !== 0) {
    return { error: 'ERR wrong number of arguments for \'MSET\' command' };
  }
  engine.mset(args);
  return { simple: 'OK' };
}
