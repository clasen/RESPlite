/**
 * TTL key - remaining time to live in seconds.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleTtl(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'TTL\' command' };
  }
  const t = engine.ttl(args[0]);
  return t;
}
