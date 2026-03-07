/**
 * ZRANK key member
 * Returns the 0-based rank of member in the sorted set (low to high score).
 * Returns null if key does not exist or member is not in the set.
 */

export function handleZrank(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'ZRANK\' command' };
  }
  try {
    const rank = engine.zrank(args[0], args[1]);
    return rank;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
