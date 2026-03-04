/**
 * LREM key count element
 */

export function handleLrem(engine, args) {
  if (!args || args.length < 3) {
    return { error: "ERR wrong number of arguments for 'LREM' command" };
  }
  try {
    return engine.lrem(args[0], args[1], args[2]);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
