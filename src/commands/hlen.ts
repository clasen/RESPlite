/**
 * HLEN key
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleHlen(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: "ERR wrong number of arguments for 'HLEN' command" };
  }
  try {
    return engine.hlen(args[0]);
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
