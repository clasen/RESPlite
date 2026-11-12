/**
 * ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]
 */

import { parseInteger } from '../util/integers.ts';
import { parseScoreBound } from './score-bounds.ts';
import type { CommandReply, Engine } from '../types.ts';

export function handleZrangebyscore(engine: Engine, args: Buffer[]): CommandReply {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZRANGEBYSCORE\' command' };
  }
  try {
    let withScores = false;
    let limitOffset = null;
    let limitCount = null;
    const raw = args.slice(3);
    for (let i = 0; i < raw.length; i++) {
      const option = String(raw[i]).toUpperCase();
      if (option === 'WITHSCORES') {
        withScores = true;
      } else if (option === 'LIMIT' && i + 2 < raw.length) {
        limitOffset = parseInteger(raw[i + 1]);
        limitCount = parseInteger(raw[i + 2]);
        i += 2;
      } else {
        return { error: 'ERR syntax error' };
      }
    }
    const min = parseScoreBound(args[1]);
    const max = parseScoreBound(args[2]);
    if (min == null || max == null) {
      return { error: 'ERR value is not a valid float' };
    }
    const options: { withScores: boolean; offset?: number; limit?: number } = { withScores };
    if (limitOffset != null && limitCount != null) {
      options.offset = limitOffset;
      options.limit = limitCount;
    }
    const arr = engine.zrangebyscore(args[0], min, max, options);
    return arr;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
