/**
 * HKEYS key - returns array of field names in the hash.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleHkeys(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'HKEYS\' command' };
  }
  try {
    const fields = engine.hkeys(args[0]);
    return fields;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
