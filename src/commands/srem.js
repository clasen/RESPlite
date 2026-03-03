/**
 * SREM key member [member ...]
 */

export function handleSrem(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'SREM\' command' };
  }
  try {
    const n = engine.srem(args[0], args.slice(1));
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
