/**
 * DEL key [key ...] - returns count of removed keys.
 */

export function handleDel(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'DEL\' command' };
  }
  const n = engine.del(args);
  return n;
}
