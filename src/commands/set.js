/**
 * SET key value [EX seconds] [PX milliseconds] - no NX/XX/GET/KEEPTTL in v1.
 */

export function handleSet(engine, args) {
  if (!args || args.length < 2) {
    return { error: 'ERR wrong number of arguments for \'SET\' command' };
  }
  const key = args[0];
  const value = args[1];
  const options = {};
  for (let i = 2; i < args.length; i++) {
    const arg = args[i].toString().toUpperCase();
    if (arg === 'EX' && i + 1 < args.length) {
      const sec = parseInt(args[++i].toString(), 10);
      if (Number.isNaN(sec) || sec < 1) return { error: 'ERR invalid expire time in \'SET\'' };
      options.ex = sec;
    } else if (arg === 'PX' && i + 1 < args.length) {
      const ms = parseInt(args[++i].toString(), 10);
      if (Number.isNaN(ms) || ms < 1) return { error: 'ERR invalid expire time in \'SET\'' };
      options.px = ms;
    } else {
      return { error: 'ERR syntax error' };
    }
  }
  try {
    engine.set(key, value, options);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
