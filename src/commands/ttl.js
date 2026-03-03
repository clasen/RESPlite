/**
 * TTL key - remaining time to live in seconds.
 */

export function handleTtl(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'TTL\' command' };
  }
  const t = engine.ttl(args[0]);
  return t;
}
