/**
 * LLEN key
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleLlen(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'LLEN\' command' };
  }
  try {
    const n = engine.llen(args[0]);
    return n;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
