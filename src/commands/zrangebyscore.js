/**
 * ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]
 */

import { parseScoreBound } from './score-bounds.js';

export function handleZrangebyscore(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZRANGEBYSCORE\' command' };
  }
  let withScores = false;
  let limitOffset = null;
  let limitCount = null;
  const raw = args.slice(3);
  for (let i = 0; i < raw.length; i++) {
    const a = (Buffer.isBuffer(raw[i]) ? raw[i].toString('utf8') : String(raw[i])).toUpperCase();
    if (a === 'WITHSCORES') {
      withScores = true;
    } else if (a === 'LIMIT' && i + 2 < raw.length) {
      const off = parseInt(String(raw[i + 1]), 10);
      const cnt = parseInt(String(raw[i + 2]), 10);
      if (!Number.isNaN(off) && !Number.isNaN(cnt)) {
        limitOffset = off;
        limitCount = cnt;
      }
      i += 2;
    }
  }
  try {
    const min = parseScoreBound(args[1]);
    const max = parseScoreBound(args[2]);
    if (min == null || max == null) {
      return { error: 'ERR value is not a valid float' };
    }
    const options = { withScores };
    if (limitOffset != null && limitCount != null) {
      options.offset = limitOffset;
      options.limit = limitCount;
    }
    const arr = engine.zrangebyscore(args[0], min, max, options);
    return arr;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
