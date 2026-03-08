/**
 * ZCOUNT key min max - returns count of members in sorted set with score in [min, max].
 */

export function handleZcount(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZCOUNT\' command' };
  }
  try {
    const min = parseFloat(String(args[1]));
    const max = parseFloat(String(args[2]));
    if (Number.isNaN(min) || Number.isNaN(max)) {
      return { error: 'ERR value is not a valid float' };
    }
    const n = engine.zcount(args[0], min, max);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
