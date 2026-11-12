/**
 * ZREVRANGE key start stop [WITHSCORES]
 * Same as ZRANGE but ordered from highest to lowest score (rank 0 = highest).
 */

import { parseInteger } from '../util/integers.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleZrevrange(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZREVRANGE\' command' };
  }
  let withScores = false;
  for (let i = 3; i < args.length; i++) {
    const a = (Buffer.isBuffer(args[i]) ? args[i].toString('utf8') : String(args[i])).toUpperCase();
    if (a === 'WITHSCORES') withScores = true;
  }
  try {
    const start = parseInteger(args[1]);
    const stop = parseInteger(args[2]);
    const arr = engine.zrevrange(args[0], start, stop, { withScores });
    return arr;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
