/**
 * LTRIM key start stop - trims list to the specified range. Returns OK.
 */

export function handleLtrim(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'LTRIM\' command' };
  }
  try {
    engine.ltrim(args[0], args[1], args[2]);
    return { simple: 'OK' };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
