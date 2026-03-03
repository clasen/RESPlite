/**
 * LPOP key [count]
 */

export function handleLpop(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'LPOP\' command' };
  }
  try {
    const countArg = args.length >= 2 ? parseInt(String(args[1]), 10) : null;
    const count = countArg != null && !Number.isNaN(countArg) && countArg > 0 ? countArg : null;
    const result = engine.lpop(args[0], count);
    return result;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
