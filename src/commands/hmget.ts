/**
 * HMGET key field [field ...]
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleHmget(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'HMGET\' command' };
  }
  try {
    const values = engine.hmget(args[0], args.slice(1));
    return values;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
