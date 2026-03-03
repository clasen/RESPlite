/**
 * HGETALL key - returns flat array [field, value, field, value, ...]
 */

export function handleHgetall(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'HGETALL\' command' };
  }
  try {
    const flat = engine.hgetall(args[0]);
    return flat;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
