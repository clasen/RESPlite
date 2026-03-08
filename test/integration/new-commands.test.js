import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

function parseIntegerReply(buf) {
  const r = tryParseValue(buf, 0);
  return r && typeof r.value === 'number' ? r.value : null;
}

function parseBulkReply(buf) {
  const r = tryParseValue(buf, 0);
  return r && r.value && Buffer.isBuffer(r.value) ? r.value.toString('utf8') : null;
}

function parseArrayReply(buf) {
  const r = tryParseValue(buf, 0);
  if (!r || !Array.isArray(r.value)) return null;
  return r.value.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v));
}

describe('New commands integration (STRLEN, HKEYS, HVALS, LSET, LTRIM, RENAME, Z*, SPOP, SRANDMEMBER)', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('STRLEN returns byte length, 0 for missing key', async () => {
    await sendCommand(port, argv('SET', 'slen', 'hello'));
    const r = await sendCommand(port, argv('STRLEN', 'slen'));
    assert.equal(parseIntegerReply(r), 5);
    const r0 = await sendCommand(port, argv('STRLEN', 'nonexistent'));
    assert.equal(parseIntegerReply(r0), 0);
  });

  it('HKEYS returns field names', async () => {
    await sendCommand(port, argv('HSET', 'hk', 'a', '1', 'b', '2'));
    const r = await sendCommand(port, argv('HKEYS', 'hk'));
    const arr = parseArrayReply(r);
    assert.ok(Array.isArray(arr));
    assert.ok(arr.includes('a') && arr.includes('b'));
    const empty = await sendCommand(port, argv('HKEYS', 'nonexistent'));
    assert.equal(parseArrayReply(empty).length, 0);
  });

  it('HVALS returns values', async () => {
    await sendCommand(port, argv('HSET', 'hv', 'x', '10', 'y', '20'));
    const r = await sendCommand(port, argv('HVALS', 'hv'));
    const arr = parseArrayReply(r);
    assert.ok(arr.includes('10') && arr.includes('20'));
  });

  it('LSET sets element at index and returns OK', async () => {
    await sendCommand(port, argv('RPUSH', 'lst', 'one', 'two', 'three'));
    const ok = await sendCommand(port, argv('LSET', 'lst', '1', 'TWO'));
    assert.ok(ok.toString('utf8').startsWith('+OK'));
    const r = await sendCommand(port, argv('LRANGE', 'lst', '0', '-1'));
    const arr = parseArrayReply(r);
    assert.equal(arr[1], 'TWO');
  });

  it('LTRIM keeps only range and returns OK', async () => {
    await sendCommand(port, argv('RPUSH', 'lt', 'a', 'b', 'c', 'd'));
    await sendCommand(port, argv('LTRIM', 'lt', '1', '2'));
    const r = await sendCommand(port, argv('LRANGE', 'lt', '0', '-1'));
    const arr = parseArrayReply(r);
    assert.deepEqual(arr, ['b', 'c']);
  });

  it('RENAME renames key and overwrites destination', async () => {
    await sendCommand(port, argv('SET', 'old', 'value'));
    const ok = await sendCommand(port, argv('RENAME', 'old', 'new'));
    assert.ok(ok.toString('utf8').startsWith('+OK'));
    const v = await sendCommand(port, argv('GET', 'new'));
    assert.equal(parseBulkReply(v), 'value');
    const missing = await sendCommand(port, argv('GET', 'old'));
    assert.equal(missing.toString('ascii'), '$-1\r\n');
  });

  it('ZCOUNT returns count in score range', async () => {
    await sendCommand(port, argv('ZADD', 'zc', '1', 'a', '2', 'b', '3', 'c'));
    const r = await sendCommand(port, argv('ZCOUNT', 'zc', '1', '2'));
    assert.equal(parseIntegerReply(r), 2);
    assert.equal(parseIntegerReply(await sendCommand(port, argv('ZCOUNT', 'zc', '10', '20'))), 0);
  });

  it('ZINCRBY increments score and returns new score', async () => {
    await sendCommand(port, argv('ZADD', 'zi', '10', 'm'));
    const r = await sendCommand(port, argv('ZINCRBY', 'zi', '5', 'm'));
    const score = r.toString('utf8').replace(/\r\n$/, '');
    assert.ok(score.includes('15'));
    const r2 = await sendCommand(port, argv('ZINCRBY', 'zi', '1', 'new'));
    assert.ok(r2.toString('utf8').includes('1'));
  });

  it('ZREMRANGEBYRANK removes by rank and returns count', async () => {
    await sendCommand(port, argv('ZADD', 'zr', '1', 'a', '2', 'b', '3', 'c'));
    const n = await sendCommand(port, argv('ZREMRANGEBYRANK', 'zr', '0', '0'));
    assert.equal(parseIntegerReply(n), 1);
    const arr = await sendCommand(port, argv('ZRANGE', 'zr', '0', '-1'));
    assert.equal(parseArrayReply(arr).length, 2);
  });

  it('ZREMRANGEBYSCORE removes by score range and returns count', async () => {
    await sendCommand(port, argv('ZADD', 'zs', '1', 'a', '2', 'b', '3', 'c'));
    const n = await sendCommand(port, argv('ZREMRANGEBYSCORE', 'zs', '1', '2'));
    assert.equal(parseIntegerReply(n), 2);
    const arr = await sendCommand(port, argv('ZRANGE', 'zs', '0', '-1'));
    assert.deepEqual(parseArrayReply(arr), ['c']);
  });

  it('SPOP removes and returns random member(s)', async () => {
    await sendCommand(port, argv('SADD', 'sp', 'x', 'y', 'z'));
    const one = await sendCommand(port, argv('SPOP', 'sp'));
    const v = parseBulkReply(one);
    assert.ok(['x', 'y', 'z'].includes(v));
    const card = await sendCommand(port, argv('SCARD', 'sp'));
    assert.equal(parseIntegerReply(card), 2);
  });

  it('SRANDMEMBER returns random member without removing', async () => {
    await sendCommand(port, argv('SADD', 'sr', 'a', 'b'));
    const r = await sendCommand(port, argv('SRANDMEMBER', 'sr'));
    assert.ok(['a', 'b'].includes(parseBulkReply(r)));
    assert.equal(parseIntegerReply(await sendCommand(port, argv('SCARD', 'sr'))), 2);
  });
});
