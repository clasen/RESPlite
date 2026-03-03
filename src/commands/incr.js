/**
 * INCR key - increment integer string by 1.
 */

export function handleIncr(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'INCR\' command' };
  }
  try {
    const n = engine.incr(args[0]);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
