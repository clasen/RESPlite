/**
 * LPUSH key value [value ...]
 */

export function handleLpush(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'LPUSH\' command' };
  }
  try {
    const n = engine.lpush(args[0], ...args.slice(1));
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
