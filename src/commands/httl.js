/**
 * HTTL key FIELDS numfields field [field ...]
 * Returns array of seconds per field: -2 (missing), -1 (no TTL), else remaining seconds.
 */

function parseFieldsTail(args, startIdx) {
  if (args.length <= startIdx) return { error: 'ERR syntax error' };
  const token = (Buffer.isBuffer(args[startIdx]) ? args[startIdx].toString('utf8') : String(args[startIdx])).toUpperCase();
  if (token !== 'FIELDS') return { error: 'ERR syntax error' };
  const numStr = args[startIdx + 1];
  if (numStr == null) return { error: 'ERR syntax error' };
  const n = parseInt(Buffer.isBuffer(numStr) ? numStr.toString('utf8') : String(numStr), 10);
  if (!Number.isInteger(n) || n < 1) {
    return { error: 'ERR numfields should be greater than 0' };
  }
  const fields = args.slice(startIdx + 2);
  if (fields.length !== n) {
    return { error: "ERR Parameter `numFields` should be equal to the number of arguments" };
  }
  return { fields };
}

export function handleHttl(engine, args) {
  if (!args || args.length < 4) {
    return { error: "ERR wrong number of arguments for 'HTTL' command" };
  }
  const key = args[0];
  const parsed = parseFieldsTail(args, 1);
  if (parsed.error) return parsed;
  try {
    return engine.httl(key, parsed.fields);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') || msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
