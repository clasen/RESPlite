/**
 * HINCRBY key field increment
 */

export function handleHincrby(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'HINCRBY\' command' };
  }
  const amount = parseInt(args[2].toString(), 10);
  if (Number.isNaN(amount)) return { error: 'ERR value is not an integer or out of range' };
  try {
    const n = engine.hincrby(args[0], args[1], amount);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
