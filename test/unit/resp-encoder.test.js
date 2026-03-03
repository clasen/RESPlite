import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  encodeSimpleString,
  encodeError,
  encodeInteger,
  encodeBulk,
  encodeArray,
} from '../../src/resp/encoder.js';

describe('RESP encoder', () => {
  it('encodes null as null bulk', () => {
    const buf = encode(null);
    assert.equal(buf.toString('ascii'), '$-1\r\n');
  });

  it('encodes integer', () => {
    assert.equal(encode(42).toString('ascii'), ':42\r\n');
    assert.equal(encodeInteger(-1).toString('ascii'), ':-1\r\n');
  });

  it('encodes bulk string from Buffer', () => {
    const buf = encode(Buffer.from('hello', 'utf8'));
    assert.equal(buf.toString('ascii'), '$5\r\nhello\r\n');
  });

  it('encodes bulk string from string', () => {
    const buf = encode('world');
    assert.equal(buf.toString('ascii'), '$5\r\nworld\r\n');
  });

  it('encodes simple string', () => {
    const buf = encodeSimpleString('PONG');
    assert.equal(buf.toString('ascii'), '+PONG\r\n');
  });

  it('encodes error', () => {
    const buf = encodeError('ERR something');
    assert.equal(buf.toString('ascii'), '-ERR something\r\n');
  });

  it('encodes array', () => {
    const buf = encode(['a', 'b']);
    assert.equal(buf.toString('ascii'), '*2\r\n$1\r\na\r\n$1\r\nb\r\n');
  });

  it('encodeBulk null', () => {
    assert.equal(encodeBulk(null).toString('ascii'), '$-1\r\n');
  });
});
