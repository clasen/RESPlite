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
  if (lower === '-inf') return Number.NEGATIVE_INFINITY;
  if (lower === '+inf' || lower === 'inf') return Number.POSITIVE_INFINITY;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}
