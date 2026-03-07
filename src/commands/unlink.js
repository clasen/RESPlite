/**
 * UNLINK key [key ...] - same as DEL; returns count of removed keys.
 * In Redis, UNLINK is non-blocking; in RESPlite we delegate to DEL.
 */

export function handleUnlink(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'UNLINK\' command' };
  }
  const n = engine.del(args);
  return n;
}
