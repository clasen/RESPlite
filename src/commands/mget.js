/**
 * MGET key [key ...] - returns array of values (null for missing).
 */

export function handleMget(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'MGET\' command' };
  }
  return engine.mget(args);
}
