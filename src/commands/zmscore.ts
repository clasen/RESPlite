/**
 * ZMSCORE key member [member ...]
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleZmscore(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'ZMSCORE\' command' };
  }
  try {
    return engine.zmscore(args[0], args.slice(1));
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
