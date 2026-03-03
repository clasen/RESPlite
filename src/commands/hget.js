/**
 * HGET key field
 */

export function handleHget(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'HGET\' command' };
  }
  try {
    const value = engine.hget(args[0], args[1]);
    return value;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
