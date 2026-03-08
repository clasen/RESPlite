/**
 * ZINCRBY key increment member - increments member's score, returns new score.
 */

export function handleZincrby(engine, args) {
  if (!args || args.length < 3) {
    return { error: 'ERR wrong number of arguments for \'ZINCRBY\' command' };
  }
  try {
    const score = engine.zincrby(args[0], args[1], args[2]);
    return score;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') ? msg : msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
