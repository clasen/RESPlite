/**
 * SETNX key value - legacy form of SET key value NX.
 * Returns 1 when the value was written, 0 when the key already exists.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleSetnx(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length !== 2) {
    return { error: 'ERR wrong number of arguments for \'setnx\' command' };
  }
  try {
    return engine.setnx(args[0], args[1]);
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
