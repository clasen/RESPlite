/**
 * HDEL key field [field ...]
 */

export function handleHdel(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'HDEL\' command' };
  }
  try {
    const n = engine.hdel(args[0], args.slice(1));
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
