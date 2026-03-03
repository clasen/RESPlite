/**
 * LINDEX key index
 */

export function handleLindex(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'LINDEX\' command' };
  }
  try {
    const value = engine.lindex(args[0], args[1]);
    return value;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
