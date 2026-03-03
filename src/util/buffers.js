/**
 * Helpers for binary-safe key/value handling (Buffer as default).
 */

/**
 * Coerce value to Buffer. Accepts string or Buffer.
 * @param {string|Buffer} value
 * @returns {Buffer}
 */
export function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('Value must be string or Buffer');
}

/**
 * Coerce value to Buffer for storage. Null/undefined not allowed for values.
 * @param {string|Buffer} value
 * @returns {Buffer}
 */
export function asKey(value) {
  return toBuffer(value);
}

/**
 * Same as toBuffer; alias for value coercion.
 * @param {string|Buffer} value
 * @returns {Buffer}
 */
export function asValue(value) {
  return toBuffer(value);
}
