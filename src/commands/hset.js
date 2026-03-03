/**
 * HSET key field value [field value ...]
 */

export function handleHset(engine, args) {
  if (!args || args.length < 3 || args.length % 2 !== 1) {
    return { error: 'ERR wrong number of arguments for \'HSET\' command' };
  }
  try {
    const key = args[0];
    const pairs = args.slice(1);
    const n = engine.hset(key, ...pairs);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
