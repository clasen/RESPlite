/**
 * ZREVRANK key member
 * Returns the 0-based rank of member in the sorted set (high to low score).
 * Returns null if key does not exist or member is not in the set.
 */

export function handleZrevrank(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'ZREVRANK\' command' };
  }
  try {
    const rank = engine.zrevrank(args[0], args[1]);
    return rank;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
