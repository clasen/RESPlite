/**
 * MSETNX key value [key value ...]
 */

export function handleMsetnx(engine, args) {
  if (!args || args.length < 2 || args.length % 2 !== 0) {
    return { error: 'ERR wrong number of arguments for \'MSETNX\' command' };
  }
  return engine.msetnx(args);
}
