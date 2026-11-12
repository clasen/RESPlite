/**
 * PTTL key - remaining time to live in milliseconds.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handlePttl(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'PTTL\' command' };
  }
  const t = engine.pttl(args[0]);
  return t;
}
