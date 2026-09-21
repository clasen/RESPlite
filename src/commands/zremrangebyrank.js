/**
 * ZREMRANGEBYRANK key start stop - removes members in rank range. Returns count removed.
 */

import { parseInteger } from '../util/integers.js';

export function handleZremrangebyrank(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZREMRANGEBYRANK\' command' };
  }
  try {
    const start = parseInteger(args[1]);
    const stop = parseInteger(args[2]);
    const n = engine.zremrangebyrank(args[0], start, stop);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
