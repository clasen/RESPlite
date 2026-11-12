/**
 * ZRANGE key start stop [WITHSCORES]
 */

import { parseInteger } from '../util/integers.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleZrange(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZRANGE\' command' };
  }
  let withScores = false;
  const rest = [];
  for (let i = 3; i < args.length; i++) {
    const a = (Buffer.isBuffer(args[i]) ? args[i].toString('utf8') : String(args[i])).toUpperCase();
    if (a === 'WITHSCORES') withScores = true;
    else rest.push(args[i]);
  }
  try {
    const start = parseInteger(args[1]);
    const stop = parseInteger(args[2]);
    const arr = engine.zrange(args[0], start, stop, { withScores });
    return arr;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
