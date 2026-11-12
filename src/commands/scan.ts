/**
 * SCAN cursor - minimal form; returns [nextCursor, keys].
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleScan(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'SCAN\' command' };
  }
  const cursor = args[0].toString();
  const { cursor: next, keys } = engine.scan(cursor, { count: 10 });
  return [String(next), keys];
}
