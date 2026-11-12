/**
 * Helpers for binary-safe key/value handling (Buffer as default).
 */

/**
 * Coerce value to Buffer. Accepts string or Buffer.
 */
export function toBuffer(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('Value must be string or Buffer');
}

/**
 * Coerce value to Buffer for storage. Null/undefined not allowed for values.
 */
export function asKey(value: string | Buffer): Buffer {
  return toBuffer(value);
}

/**
 * Same as toBuffer; alias for value coercion.
 */
export function asValue(value: string | Buffer): Buffer {
  return toBuffer(value);
}
