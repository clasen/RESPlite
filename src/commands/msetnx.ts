/**
 * MSETNX key value [key value ...]
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleMsetnx(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2 || args.length % 2 !== 0) {
    return { error: 'ERR wrong number of arguments for \'MSETNX\' command' };
  }
  return engine.msetnx(args);
}
