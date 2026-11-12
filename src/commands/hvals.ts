/**
 * HVALS key - returns array of values in the hash.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleHvals(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'HVALS\' command' };
  }
  try {
    const values = engine.hvals(args[0]);
    return values;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
