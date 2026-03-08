/**
 * LSET key index element - sets list element at index to element. Returns OK.
 */

export function handleLset(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'LSET\' command' };
  }
  try {
    engine.lset(args[0], args[1], args[2]);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
