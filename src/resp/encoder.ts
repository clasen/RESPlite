/**
 * RESP2 encoder: encode responses for wire output.
 * All string/bulk values are written as-is (binary-safe when Buffer).
 */

import { TYPES, CRLF, NULL_BULK } from './types.ts';
import type { RespValue } from '../types.ts';

/**
 * Encode a value to RESP2 format.
 * - null -> null bulk string ($-1\r\n)
 * - number/BigInt -> integer (:\r\n)
 * - string/Buffer -> bulk string
 * - array -> array
 */
export function encode(value: RespValue): Buffer {
  if (value === null || value === NULL_BULK) {
    return Buffer.from('$-1\r\n', 'ascii');
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Buffer.from(':' + String(value) + CRLF, 'ascii');
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const header = Buffer.from('$' + buf.length + CRLF, 'ascii');
    return Buffer.concat([header, buf, Buffer.from(CRLF, 'ascii')]);
  }
  if (Array.isArray(value)) {
    const parts: Buffer[] = [Buffer.from('*' + value.length + CRLF, 'ascii')];
    for (const item of value) {
      parts.push(encode(item));
    }
    return Buffer.concat(parts);
  }
  if (value && typeof value === 'object') {
    if ('simple' in value && value.simple !== undefined) return encodeSimpleString(value.simple);
    if ('error' in value && value.error !== undefined) return encodeError(value.error);
  }
  throw new TypeError('Cannot encode value: ' + typeof value);
}

/**
 * Encode simple string (no bulk; for +OK style).
 */
export function encodeSimpleString(s: string): Buffer {
  return Buffer.from('+' + s + CRLF, 'utf8');
}

/**
 * Encode error message.
 */
export function encodeError(message: string): Buffer {
  return Buffer.from('-' + message + CRLF, 'utf8');
}

/**
 * Encode integer.
 */
export function encodeInteger(n: number): Buffer {
  return Buffer.from(':' + String(n) + CRLF, 'ascii');
}

/**
 * Encode bulk string (binary-safe). Null -> $-1\r\n
 */
export function encodeBulk(value: Buffer | string | null | undefined): Buffer {
  if (value === null || value === undefined) {
    return Buffer.from('$-1\r\n', 'ascii');
  }
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const header = Buffer.from('$' + buf.length + CRLF, 'ascii');
  return Buffer.concat([header, buf, Buffer.from(CRLF, 'ascii')]);
}

/**
 * Encode array of values (each encoded with encode).
 */
export function encodeArray(arr: RespValue[]): Buffer {
  const parts: Buffer[] = [Buffer.from('*' + arr.length + CRLF, 'ascii')];
  for (const item of arr) {
    parts.push(encode(item));
  }
  return Buffer.concat(parts);
}
