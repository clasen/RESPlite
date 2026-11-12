/**
 * RESP2 type constants and helpers.
 */

export const TYPES = {
  SIMPLE_STRING: '+',
  ERROR: '-',
  INTEGER: ':',
  BULK_STRING: '$',
  ARRAY: '*',
};

export const CRLF = '\r\n';
export const CRLF_BUF = Buffer.from('\r\n', 'ascii');

export const NULL_BULK = null; // Represent null bulk string in JS

export const INT_MIN = -0x7fffffff - 1;
export const INT_MAX = 0x7fffffff;
