/**
 * HLEN key
 */

export function handleHlen(engine, args) {
  if (!args || args.length < 1) {
    return { error: "ERR wrong number of arguments for 'HLEN' command" };
  }
  try {
    return engine.hlen(args[0]);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
