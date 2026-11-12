/**
 * TYPE key - returns string, hash, set, or none.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleType(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'TYPE\' command' };
  }
  const t = engine.type(args[0]);
  return { simple: t };
}
