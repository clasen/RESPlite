/**
 * SPOP key [count] - removes and returns one or more random members. Default count 1.
 */

export function handleSpop(engine, args) {
  if (!args || args.length < 1) {
    return { error: 'ERR wrong number of arguments for \'SPOP\' command' };
  }
  try {
    let count = null;
    if (args.length >= 2) {
      const n = parseInt(String(args[1]), 10);
      if (!Number.isNaN(n)) count = n;
    }
    const result = engine.spop(args[0], count);
    return result;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
