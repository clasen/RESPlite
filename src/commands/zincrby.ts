/**
 * ZINCRBY key increment member - increments member's score, returns new score.
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleZincrby(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZINCRBY\' command' };
  }
  try {
    const score = engine.zincrby(args[0], args[1], args[2]);
    return score;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
