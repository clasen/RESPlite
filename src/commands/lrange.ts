/**
 * LRANGE key start stop
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleLrange(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'LRANGE\' command' };
  }
  try {
    const arr = engine.lrange(args[0], args[1], args[2]);
    return arr;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
