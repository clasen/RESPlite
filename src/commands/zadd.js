/**
 * ZADD key score member [score member ...]
 * Minimal v1: no NX/XX/CH/INCR. Returns count of new members added.
 */

export function handleZadd(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZADD\' command' };
  }
  const pairsLen = args.length - 1;
  if (pairsLen % 2 !== 0) {
    return { error: 'ERR syntax error' };
  }
  try {
    const n = engine.zadd(args[0], args.slice(1));
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
