/**
 * SRANDMEMBER key [count] - returns one or more random members without removing. Default count 1.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleSrandmember(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'SRANDMEMBER\' command' };
  }
  try {
    let count = null;
    if (args.length >= 2) {
      const n = parseInt(String(args[1]), 10);
      if (!Number.isNaN(n)) count = n;
    }
    const result = engine.srandmember(args[0], count);
    return result;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
