/**
 * EXPIRE key seconds - set TTL in seconds.
 */

export function handleExpire(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'EXPIRE\' command' };
  }
  const sec = parseInt(args[1].toString(), 10);
  if (Number.isNaN(sec)) return { error: 'ERR value is not an integer or out of range' };
  const ok = engine.expire(args[0], sec);
  return ok ? 1 : 0;
}
