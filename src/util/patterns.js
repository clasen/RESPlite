/**
 * Placeholder for future MATCH pattern support in SCAN (v1: minimal SCAN only).
 */

/**
 * Check if key matches glob pattern (v1: not used; SCAN has no MATCH in v1).
 * @param {Buffer} key
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchKey(key, pattern) {
  if (!pattern || pattern === '*') return true;
  // Future: implement glob matching
  return true;
}
