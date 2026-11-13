/**
 * RESP2 encoder: encode responses for wire output.
 * All string/bulk values are written as-is (binary-safe when Buffer).
 * Each reply is sized first and then written into one Buffer, so encoding
 * allocates once per reply instead of once per header, payload and CRLF.
 */

import type { RespValue } from '../types.ts';

const CR = 13;
const LF = 10;
const MINUS = 45;
const DIGIT_ZERO = 48;
const NULL_BULK_BYTES = [36, MINUS, 49, CR, LF]; // $-1\r\n

function decimalLength(n: number): number {
  let length = 1;
  for (let limit = 10; n >= limit; limit *= 10) length++;
  return length;
}

/** Writes a non-negative safe integer followed by CRLF. */
function writeLength(out: Buffer, offset: number, n: number): number {
  const end = offset + decimalLength(n);
  for (let i = end - 1; i >= offset; i--) {
    out[i] = DIGIT_ZERO + (n % 10);
    n = Math.floor(n / 10);
  }
  out[end] = CR;
  out[end + 1] = LF;
  return end + 2;
}

/** Counts and lengths take the digit path; other numbers are written from their string form. */
function isNatural(value: number | bigint): value is number {
  return typeof value === 'number' && value >= 0 && Number.isSafeInteger(value);
}

function lineLength(text: string): number {
  return 1 + Buffer.byteLength(text, 'utf8') + 2;
}

function encodedLength(value: RespValue): number {
  if (Buffer.isBuffer(value)) return 1 + decimalLength(value.length) + 2 + value.length + 2;
  if (value === null) return NULL_BULK_BYTES.length;
  if (typeof value === 'string') {
    const length = Buffer.byteLength(value, 'utf8');
    return 1 + decimalLength(length) + 2 + length + 2;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return 1 + (isNatural(value) ? decimalLength(value) : String(value).length) + 2;
  }
  if (Array.isArray(value)) {
    let length = 1 + decimalLength(value.length) + 2;
    for (const item of value) length += encodedLength(item);
    return length;
  }
  if (value && typeof value === 'object') {
    if ('simple' in value && value.simple !== undefined) return lineLength(value.simple);
    if ('error' in value && value.error !== undefined) return lineLength(value.error);
  }
  throw new TypeError('Cannot encode value: ' + typeof value);
}

function writeLine(out: Buffer, offset: number, prefix: number, text: string): number {
  out[offset] = prefix;
  offset += 1 + out.write(text, offset + 1, 'utf8');
  out[offset] = CR;
  out[offset + 1] = LF;
  return offset + 2;
}

function writeValue(value: RespValue, out: Buffer, offset: number): number {
  if (Buffer.isBuffer(value)) {
    out[offset] = 36; // $
    offset = writeLength(out, offset + 1, value.length);
    offset += value.copy(out, offset);
    out[offset] = CR;
    out[offset + 1] = LF;
    return offset + 2;
  }
  if (value === null) {
    for (const byte of NULL_BULK_BYTES) out[offset++] = byte;
    return offset;
  }
  if (typeof value === 'string') {
    out[offset] = 36; // $
    offset = writeLength(out, offset + 1, Buffer.byteLength(value, 'utf8'));
    offset += out.write(value, offset, 'utf8');
    out[offset] = CR;
    out[offset + 1] = LF;
    return offset + 2;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    out[offset++] = 58; // :
    if (isNatural(value)) return writeLength(out, offset, value);
    offset += out.write(String(value), offset, 'latin1');
    out[offset] = CR;
    out[offset + 1] = LF;
    return offset + 2;
  }
  if (Array.isArray(value)) {
    out[offset] = 42; // *
    offset = writeLength(out, offset + 1, value.length);
    for (const item of value) offset = writeValue(item, out, offset);
    return offset;
  }
  const marked = value as { simple?: string; error?: string };
  if (marked.simple !== undefined) return writeLine(out, offset, 43, marked.simple); // +
  return writeLine(out, offset, MINUS, marked.error as string);
}

/**
 * Encode a value to RESP2 format.
 * - null -> null bulk string ($-1\r\n)
 * - number/BigInt -> integer (:\r\n)
 * - string/Buffer -> bulk string
 * - array -> array
 */
export function encode(value: RespValue): Buffer {
  const out = Buffer.allocUnsafe(encodedLength(value));
  // allocUnsafe is not zeroed: a size mismatch would leak old memory to the client.
  if (writeValue(value, out, 0) !== out.length) throw new Error('RESP encoder size mismatch');
  return out;
}

/**
 * Encode simple string (no bulk; for +OK style).
 */
export function encodeSimpleString(s: string): Buffer {
  return encode({ simple: s });
}

/**
 * Encode error message.
 */
export function encodeError(message: string): Buffer {
  return encode({ error: message });
}

/**
 * Encode integer.
 */
export function encodeInteger(n: number): Buffer {
  return encode(n);
}

/**
 * Encode bulk string (binary-safe). Null -> $-1\r\n
 */
export function encodeBulk(value: Buffer | string | null | undefined): Buffer {
  if (value === null || value === undefined) return encode(null);
  return encode(Buffer.isBuffer(value) ? value : String(value));
}

/**
 * Encode array of values (each encoded with encode).
 */
export function encodeArray(arr: RespValue[]): Buffer {
  return encode(arr);
}
