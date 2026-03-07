/**
 * ZREVRANGE key start stop [WITHSCORES]
 * Same as ZRANGE but ordered from highest to lowest score (rank 0 = highest).
 */

export function handleZrevrange(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZREVRANGE\' command' };
  }
  let withScores = false;
  for (let i = 3; i < args.length; i++) {
    const a = (Buffer.isBuffer(args[i]) ? args[i].toString('utf8') : String(args[i])).toUpperCase();
    if (a === 'WITHSCORES') withScores = true;
  }
  try {
    const start = parseInt(String(args[1]), 10);
    const stop = parseInt(String(args[2]), 10);
    if (Number.isNaN(start) || Number.isNaN(stop)) {
      return { error: 'ERR value is not an integer or out of range' };
    }
    const arr = engine.zrevrange(args[0], start, stop, { withScores });
    return arr;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
