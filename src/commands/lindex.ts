/**
 * LINDEX key index
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleLindex(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'LINDEX\' command' };
  }
  try {
    const value = engine.lindex(args[0], args[1]);
    return value;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
