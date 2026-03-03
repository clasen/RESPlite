/**
 * RESP2 encoder: encode responses for wire output.
 * All string/bulk values are written as-is (binary-safe when Buffer).
 */

import { TYPES, CRLF, NULL_BULK } from './types.js';

/**
 * Encode a value to RESP2 format.
 * - null -> null bulk string ($-1\r\n)
 * - number -> integer (:\r\n)
 * - string/Buffer -> bulk string
 * - array -> array
 * @param {string|Buffer|number|null|Array} value
 * @returns {Buffer}
 */
export function encode(value) {
  if (value === null || value === NULL_BULK) {
    return Buffer.from('$-1\r\n', 'ascii');
  }
  if (typeof value === 'number') {
    return Buffer.from(':' + String(value) + CRLF, 'ascii');
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const header = Buffer.from('$' + buf.length + CRLF, 'ascii');
    return Buffer.concat([header, buf, Buffer.from(CRLF, 'ascii')]);
  }
  if (Array.isArray(value)) {
    const parts = [Buffer.from('*' + value.length + CRLF, 'ascii')];
    for (const item of value) {
      parts.push(encode(item));
    }
    return Buffer.concat(parts);
  }
  throw new TypeError('Cannot encode value: ' + typeof value);
}

/**
 * Encode simple string (no bulk; for +OK style).
 * @param {string} s
 * @returns {Buffer}
 */
export function encodeSimpleString(s) {
  return Buffer.from('+' + s + CRLF, 'utf8');
}

/**
 * Encode error message.
 * @param {string} message
 * @returns {Buffer}
 */
export function encodeError(message) {
  return Buffer.from('-' + message + CRLF, 'utf8');
}

/**
 * Encode integer.
 * @param {number} n
 * @returns {Buffer}
 */
export function encodeInteger(n) {
  return Buffer.from(':' + String(n) + CRLF, 'ascii');
}

/**
 * Encode bulk string (binary-safe). Null -> $-1\r\n
 * @param {Buffer|string|null} value
 * @returns {Buffer}
 */
export function encodeBulk(value) {
  if (value === null || value === undefined) {
    return Buffer.from('$-1\r\n', 'ascii');
  }
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const header = Buffer.from('$' + buf.length + CRLF, 'ascii');
  return Buffer.concat([header, buf, Buffer.from(CRLF, 'ascii')]);
}

/**
 * Encode array of values (each encoded with encode).
 * @param {Array} arr
 * @returns {Buffer}
 */
export function encodeArray(arr) {
  const parts = [Buffer.from('*' + arr.length + CRLF, 'ascii')];
  for (const item of arr) {
    parts.push(encode(item));
  }
  return Buffer.concat(parts);
}
