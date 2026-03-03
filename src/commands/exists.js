/**
 * EXISTS key [key ...] - returns count of existing keys.
 */

export function handleExists(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'EXISTS\' command' };
  }
  const n = engine.exists(args);
  return n;
}
