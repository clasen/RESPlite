/**
 * HEXISTS key field
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleHexists(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'HEXISTS\' command' };
  }
  try {
    const n = engine.hexists(args[0], args[1]);
    return n;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
