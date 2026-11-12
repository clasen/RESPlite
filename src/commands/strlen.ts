/**
 * STRLEN key - returns length of string value in bytes, or 0 if key does not exist.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleStrlen(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'STRLEN\' command' };
  }
  try {
    const len = engine.strlen(args[0]);
    return len;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
