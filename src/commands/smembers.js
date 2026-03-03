/**
 * SMEMBERS key
 */

export function handleSmembers(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'SMEMBERS\' command' };
  }
  try {
    const arr = engine.smembers(args[0]);
    return arr;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
