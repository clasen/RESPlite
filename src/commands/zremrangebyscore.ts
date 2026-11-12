/**
 * ZREMRANGEBYSCORE key min max - removes members with score in [min, max]. Returns count removed.
 */

import { parseScoreBound } from './score-bounds.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleZremrangebyscore(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZREMRANGEBYSCORE\' command' };
  }
  try {
    const min = parseScoreBound(args[1]);
    const max = parseScoreBound(args[2]);
    if (min == null || max == null) {
      return { error: 'ERR value is not a valid float' };
    }
    const n = engine.zremrangebyscore(args[0], min, max);
    return n;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
