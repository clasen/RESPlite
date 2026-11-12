/**
 * PERSIST key - remove TTL.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handlePersist(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'PERSIST\' command' };
  }
  const ok = engine.persist(args[0]);
  return ok ? 1 : 0;
}
