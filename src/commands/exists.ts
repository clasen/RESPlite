/**
 * EXISTS key [key ...] - returns count of existing keys.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleExists(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'EXISTS\' command' };
  }
  const n = engine.exists(args);
  return n;
}
