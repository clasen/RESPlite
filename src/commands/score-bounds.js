/**
 * Parse score bound used by sorted-set score range commands.
 * Supports Redis-style infinities: -inf, +inf, inf.
 *
 * @param {Buffer|string|number} raw
 * @returns {number|null}
 */
export function parseScoreBound(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const lower = s.toLowerCase();
  if (lower === '-inf' || lower === '-infinity') return Number.NEGATIVE_INFINITY;
  if (lower === '+inf' || lower === 'inf' || lower === 'infinity' || lower === '+infinity') return Number.POSITIVE_INFINITY;
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
