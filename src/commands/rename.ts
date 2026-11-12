/**
 * RENAME key newkey - renames key to newkey, overwriting newkey if it exists. Returns OK.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleRename(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'RENAME\' command' };
  }
  try {
    engine.rename(args[0], args[1]);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
