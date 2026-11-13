import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  encodeSimpleString,
  encodeError,
  encodeInteger,
  encodeBulk,
  encodeArray,
} from '../../src/resp/encoder.ts';

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

  it('matches the RESP2 wire format for every reply shape', () => {
    // Straightforward per-part encoding used as the reference for the sized single-buffer encoder.
    const reference = (value) => {
      if (value === null) return Buffer.from('$-1\r\n');
      if (typeof value === 'number' || typeof value === 'bigint') return Buffer.from(':' + String(value) + '\r\n');
      if (typeof value === 'string' || Buffer.isBuffer(value)) {
        const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
        return Buffer.concat([Buffer.from('$' + payload.length + '\r\n'), payload, Buffer.from('\r\n')]);
      }
      if (Array.isArray(value)) {
        return Buffer.concat([Buffer.from('*' + value.length + '\r\n'), ...value.map(reference)]);
      }
      if (value.simple !== undefined) return Buffer.from('+' + value.simple + '\r\n', 'utf8');
      return Buffer.from('-' + value.error + '\r\n', 'utf8');
    };
    const values = [
      0, 9, 10, 99, 100, 123456789, Number.MAX_SAFE_INTEGER, -1, -0, -42, 1.5, -2.25, 2 ** 60, NaN, 0n, -7n,
      12345678901234567890n, '', 'a', 'x'.repeat(10), 'x'.repeat(100), 'héllo €', '😀', '\ud800',
      Buffer.alloc(0), Buffer.from([0, 13, 10, 255]), Buffer.alloc(1000, 7), null, [],
      { simple: 'OK' }, { simple: 'ñandú' }, { error: 'ERR bad' }, { error: 'WRONGTYPE ¿?' },
    ];
    values.push(values.slice(), [values.slice(0, 5), [[null, 'x', 3n], []], { simple: 'QUEUED' }]);
    for (const value of values) {
      assert.deepEqual(encode(value), reference(value), `value ${String(value)}`);
    }
    const flat = Array.from({ length: 12000 }, (_, i) => Buffer.from(i % 2 ? 'value-' + i : 'f' + i));
    assert.deepEqual(encode(flat), reference(flat));
  });

  it('rejects values that have no RESP2 form', () => {
    assert.throws(() => encode(undefined), TypeError);
    assert.throws(() => encode(true), TypeError);
    assert.throws(() => encode([1, {}]), TypeError);
  });
});
