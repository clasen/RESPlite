/**
 * ZSCORE key member
 */

import type { CommandReply, Engine } from '../types.ts';

export function handleZscore(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'ZSCORE\' command' };
  }
  try {
    const score = engine.zscore(args[0], args[1]);
    return score;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
