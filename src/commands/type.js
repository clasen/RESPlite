/**
 * TYPE key - returns string, hash, set, or none.
 */

export function handleType(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'TYPE\' command' };
  }
  const t = engine.type(args[0]);
  return { simple: t };
}
