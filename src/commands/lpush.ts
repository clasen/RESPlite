/**
 * LPUSH key value [value ...]
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleLpush(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'LPUSH\' command' };
  }
  try {
    const n = engine.lpush(args[0], ...args.slice(1));
    return n;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
