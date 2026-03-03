/**
 * MSET key value [key value ...] - sets multiple keys.
 */

export function handleMset(engine, args) {
  if (!args || args.length < 2 || args.length % 2 !== 0) {
    return { error: 'ERR wrong number of arguments for \'MSET\' command' };
  }
  engine.mset(args);
  return { simple: 'OK' };
}
