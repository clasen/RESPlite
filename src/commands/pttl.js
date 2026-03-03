/**
 * PTTL key - remaining time to live in milliseconds.
 */

export function handlePttl(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'PTTL\' command' };
  }
  const t = engine.pttl(args[0]);
  return t;
}
