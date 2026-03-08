/**
 * STRLEN key - returns length of string value in bytes, or 0 if key does not exist.
 */

export function handleStrlen(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'STRLEN\' command' };
  }
  try {
    const len = engine.strlen(args[0]);
    return len;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
