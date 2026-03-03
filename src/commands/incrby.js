/**
 * INCRBY key increment - add integer to key.
 */

export function handleIncrby(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'INCRBY\' command' };
  }
  const delta = parseInt(args[1].toString(), 10);
  if (Number.isNaN(delta)) return { error: 'ERR value is not an integer or out of range' };
  try {
    const n = engine.incrby(args[0], delta);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
