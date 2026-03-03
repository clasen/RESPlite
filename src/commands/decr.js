/**
 * DECR key - decrement integer string by 1.
 */

export function handleDecr(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'DECR\' command' };
  }
  try {
    const n = engine.decr(args[0]);
    return n;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
