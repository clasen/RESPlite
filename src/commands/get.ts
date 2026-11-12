/**
 * GET key - returns bulk string or null.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleGet(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'GET\' command' };
  }
  const key = args[0];
  const value = engine.get(key);
  return value; // null -> encoder sends $-1\r\n; Buffer -> bulk
}
