/**
 * SADD key member [member ...]
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleSadd(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'SADD\' command' };
  }
  try {
    const n = engine.sadd(args[0], ...args.slice(1));
    return n;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
