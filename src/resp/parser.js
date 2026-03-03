/**
 * RESP2 parser. Binary-safe: bulk strings returned as Buffer.
 * Handles fragmented input and multiple complete commands per chunk.
 * Does not consume buffer until a full value is parsed.
 */

import { TYPES, CRLF_BUF } from './types.js';

/**
 * Try to parse one RESP value from buffer at offset.
 * @param {Buffer} buf
 * @param {number} i
 * @returns {{ value: unknown, end: number } | null} value and end offset, or null if incomplete
 */
export function tryParseValue(buf, i) {
  if (i >= buf.length) return null;
  const type = String.fromCharCode(buf[i]);
  const lineEnd = buf.indexOf(CRLF_BUF, i + 1);
  if (lineEnd === -1) return null;

  if (type === TYPES.SIMPLE_STRING || type === TYPES.ERROR) {
    const line = buf.subarray(i + 1, lineEnd).toString('utf8');
    return { value: type === TYPES.ERROR ? { error: line } : line, end: lineEnd + 2 };
  }

  if (type === TYPES.INTEGER) {
    const line = buf.subarray(i + 1, lineEnd).toString('ascii');
    return { value: parseInt(line, 10), end: lineEnd + 2 };
  }

  if (type === TYPES.BULK_STRING) {
    const len = parseInt(buf.subarray(i + 1, lineEnd).toString('ascii'), 10);
    const payloadStart = lineEnd + 2;
    if (len === -1) return { value: null, end: payloadStart };
    if (buf.length < payloadStart + len + 2) return null;
    const bulk = Buffer.from(buf.subarray(payloadStart, payloadStart + len));
    return { value: bulk, end: payloadStart + len + 2 };
  }

  if (type === TYPES.ARRAY) {
    const count = parseInt(buf.subarray(i + 1, lineEnd).toString('ascii'), 10);
    let pos = lineEnd + 2;
    if (count === -1) return { value: null, end: pos };
    const arr = [];
    for (let k = 0; k < count; k++) {
      const next = tryParseValue(buf, pos);
      if (next === null) return null;
      arr.push(next.value);
      pos = next.end;
    }
    return { value: arr, end: pos };
  }

  return null;
}

export class RESPReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Append data. Call parseCommands() to get complete commands.
   * @param {Buffer} chunk
   */
  feed(chunk) {
    if (chunk && chunk.length > 0) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  /**
   * Parse one RESP value from current buffer. Only consumes buffer when a full value is parsed.
   * @returns {{ value: unknown, done: boolean }}
   */
  parseOne() {
    const result = tryParseValue(this.buffer, 0);
    if (result === null) return { value: null, done: false };
    this.buffer = this.buffer.subarray(result.end);
    return { value: result.value, done: true };
  }

  /**
   * Parse all complete commands from the buffer. Each command is an array of Buffer (args).
   * @returns {Buffer[][]} array of commands
   */
  parseCommands() {
    const commands = [];
    for (;;) {
      const result = tryParseValue(this.buffer, 0);
      if (result === null) break;
      this.buffer = this.buffer.subarray(result.end);
      if (result.value != null && Array.isArray(result.value)) {
        const args = result.value.map((v) =>
          Buffer.isBuffer(v) ? v : v != null ? Buffer.from(String(v)) : Buffer.alloc(0)
        );
        commands.push(args);
      }
    }
    return commands;
  }
}
