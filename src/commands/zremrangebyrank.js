/**
 * ZREMRANGEBYRANK key start stop - removes members in rank range. Returns count removed.
 */

export function handleZremrangebyrank(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZREMRANGEBYRANK\' command' };
  }
  try {
    const start = parseInt(String(args[1]), 10);
    const stop = parseInt(String(args[2]), 10);
    if (Number.isNaN(start) || Number.isNaN(stop)) {
      return { error: 'ERR value is not an integer or out of range' };
    }
    const n = engine.zremrangebyrank(args[0], start, stop);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
