/**
 * HEXPIRE key seconds [NX | XX | GT | LT] FIELDS numfields field [field ...]
 * Redis 7.4 per-field TTL. Returns array of integers (-2/0/1/2) per field.
 */

const CONDITIONS = new Set(['NX', 'XX', 'GT', 'LT']);

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

export function handleHexpire(engine, args) {
  if (!args || args.length < 5) {
    return { error: "ERR wrong number of arguments for 'HEXPIRE' command" };
  }
  const key = args[0];
  const secondsStr = Buffer.isBuffer(args[1]) ? args[1].toString('utf8') : String(args[1]);
  const seconds = parseInt(secondsStr, 10);
  if (!Number.isInteger(seconds)) {
    return { error: 'ERR value is not an integer or out of range' };
  }

  let idx = 2;
  let condition = null;
  const maybeCond = (Buffer.isBuffer(args[idx]) ? args[idx].toString('utf8') : String(args[idx])).toUpperCase();
  if (CONDITIONS.has(maybeCond)) {
    condition = maybeCond;
    idx += 1;
  }

  const parsed = parseFieldsTail(args, idx);
  if (parsed.error) return parsed;

  const expiresAtMs = engine._clock() + seconds * 1000;
  try {
    return engine.hexpire(key, expiresAtMs, parsed.fields, { condition });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { error: msg.startsWith('ERR ') || msg.startsWith('WRONGTYPE') ? msg : 'ERR ' + msg };
  }
}
