/**
 * ZCARD key
 */

export function handleZcard(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'ZCARD\' command' };
  }
  try {
    const n = engine.zcard(args[0]);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
