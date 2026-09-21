/**
 * ZREVRANGEBYSCORE key max min [WITHSCORES] [LIMIT offset count]
 * Same as ZRANGEBYSCORE but ordered from highest to lowest score.
 * Note: Redis uses max min (first score is upper bound, second is lower bound).
 */

import { parseInteger } from '../util/integers.js';
import { parseScoreBound } from './score-bounds.js';

export function handleZrevrangebyscore(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZREVRANGEBYSCORE\' command' };
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
    const max = parseScoreBound(args[1]);
    const min = parseScoreBound(args[2]);
    if (max == null || min == null) {
      return { error: 'ERR value is not a valid float' };
    }
    const options = { withScores };
    if (limitOffset != null && limitCount != null) {
      options.offset = limitOffset;
      options.limit = limitCount;
    }
    const arr = engine.zrevrangebyscore(args[0], max, min, options);
    return arr;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
