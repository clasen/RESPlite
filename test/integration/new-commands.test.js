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

  it('ZREMRANGEBYRANK preserves a member when stop precedes the set', async () => {
    await sendCommand(port, argv('ZADD', 'prueba', '1', 'mensaje'));
    const removed = await sendCommand(port, argv('ZREMRANGEBYRANK', 'prueba', '0', '-13'));
    assert.equal(parseIntegerReply(removed), 0);
    assert.equal(parseIntegerReply(await sendCommand(port, argv('ZCARD', 'prueba'))), 1);
    assert.deepEqual(parseArrayReply(await sendCommand(port, argv('ZRANGE', 'prueba', '0', '-1'))), ['mensaje']);
  });

  it('ZREMRANGEBYRANK handles rank boundaries without selecting out-of-range members', async () => {
    const cases = [
      [0, -4, ['a', 'b', 'c']],
      [-4, -4, ['a', 'b', 'c']],
      [3, 10, ['a', 'b', 'c']],
      [3, -1, ['a', 'b', 'c']],
      [2, 1, ['a', 'b', 'c']],
      [0, -3, ['b', 'c']],
      [-10, 0, ['b', 'c']],
      [-2, -1, ['a']],
      [1, 10, ['a']],
      [-10, 10, []],
    ];
    for (const [start, stop, remaining] of cases) {
      await sendCommand(port, argv('DEL', 'rank-boundaries'));
      await sendCommand(port, argv('ZADD', 'rank-boundaries', '1', 'a', '2', 'b', '3', 'c'));
      const removed = await sendCommand(port, argv('ZREMRANGEBYRANK', 'rank-boundaries', String(start), String(stop)));
      assert.equal(parseIntegerReply(removed), 3 - remaining.length, `${start} ${stop}`);
      assert.equal(parseIntegerReply(await sendCommand(port, argv('ZCARD', 'rank-boundaries'))), remaining.length);
      assert.deepEqual(parseArrayReply(await sendCommand(port, argv('ZRANGE', 'rank-boundaries', '0', '-1'))), remaining);
      assert.equal(parseIntegerReply(await sendCommand(port, argv('EXISTS', 'rank-boundaries'))), remaining.length ? 1 : 0);
    }
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

  it('rejects malformed rank arguments without changing collections', async () => {
    const invalid = ['0junk', '1.5', '', ' 1', '01', '+1', '-0', '9223372036854775808', '-9223372036854775809'];
    await sendCommand(port, argv('RPUSH', 'strict-list', 'a', 'b'));
    await sendCommand(port, argv('ZADD', 'strict-zset', '1', 'a', '2', 'b'));
    for (const value of invalid) {
      const commands = [
        ['LINDEX', 'strict-list', value],
        ['LSET', 'strict-list', value, 'changed'],
        ['LRANGE', 'strict-list', value, '-1'],
        ['LTRIM', 'strict-list', '0', value],
        ['ZRANGE', 'strict-zset', value, '-1'],
        ['ZREVRANGE', 'strict-zset', '0', value],
        ['ZREMRANGEBYRANK', 'strict-zset', value, '0'],
        ['LTRIM', 'missing-strict', value, '0'],
        ['LSET', 'missing-strict', value, 'changed'],
      ];
      for (const command of commands) {
        const reply = await sendCommand(port, argv(...command));
        assert.equal(reply.toString(), '-ERR value is not an integer or out of range\r\n', command.join(' '));
      }
    }
    assert.deepEqual(parseArrayReply(await sendCommand(port, argv('LRANGE', 'strict-list', '0', '-1'))), ['a', 'b']);
    assert.deepEqual(parseArrayReply(await sendCommand(port, argv('ZRANGE', 'strict-zset', '0', '-1'))), ['a', 'b']);
    for (const command of ['LRANGE', 'ZRANGE', 'ZREVRANGE']) {
      const key = command === 'LRANGE' ? 'strict-list' : 'strict-zset';
      const reply = await sendCommand(port, argv(command, key, '-9223372036854775808', '9223372036854775807'));
      assert.deepEqual(parseArrayReply(reply), command === 'ZREVRANGE' ? ['b', 'a'] : ['a', 'b']);
    }
  });

  it('rejects malformed score bounds without removing members', async () => {
    await sendCommand(port, argv('ZADD', 'strict-scores', '1', 'a', '2', 'b'));
    for (const value of ['1junk', '', ' 1', 'NaN', '1e999']) {
      for (const command of ['ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZCOUNT', 'ZREMRANGEBYSCORE']) {
        const reply = await sendCommand(port, argv(command, 'strict-scores', value, '2'));
        assert.ok(reply.toString().startsWith('-ERR '), `${command} ${value}`);
      }
    }
    assert.deepEqual(parseArrayReply(await sendCommand(port, argv('ZRANGE', 'strict-scores', '0', '-1'))), ['a', 'b']);
    assert.deepEqual(parseArrayReply(await sendCommand(port, argv('ZRANGEBYSCORE', 'strict-scores', '+1e0', '2.0'))), ['a', 'b']);
  });

  it('validates score range LIMIT and preserves negative count semantics', async () => {
    await sendCommand(port, argv('ZADD', 'strict-limit', '1', 'a', '2', 'b'));
    for (const command of ['ZRANGEBYSCORE', 'ZREVRANGEBYSCORE']) {
      const bounds = command === 'ZRANGEBYSCORE' ? ['-inf', '+inf'] : ['+inf', '-inf'];
      for (const options of [['LIMIT', 'bad', '1'], ['LIMIT', '0', '1junk'], ['LIMIT', '0'], ['UNKNOWN']]) {
        const reply = await sendCommand(port, argv(command, 'strict-limit', ...bounds, ...options));
        assert.ok(reply.toString().startsWith('-ERR '), options.join(' '));
      }
      for (const options of [['LIMIT', '-1', '1'], ['LIMIT', '0', '0']]) {
        assert.deepEqual(parseArrayReply(await sendCommand(port, argv(command, 'strict-limit', ...bounds, ...options))), []);
      }
      const reply = await sendCommand(port, argv(command, 'strict-limit', ...bounds, 'LIMIT', '1', '-1'));
      assert.deepEqual(parseArrayReply(reply), command === 'ZRANGEBYSCORE' ? ['b'] : ['a']);
    }
  });


  it('accepts large valid rank and LIMIT integers without SQLite errors', async () => {
    await sendCommand(port, argv('ZADD', 'large-ranges', '1', 'a', '2', 'b'));
    const max = '9223372036854775807';
    assert.deepEqual(parseArrayReply(await sendCommand(port, argv('ZRANGE', 'large-ranges', '0', max))), ['a', 'b']);
    for (const command of ['ZRANGEBYSCORE', 'ZREVRANGEBYSCORE']) {
      const bounds = command === 'ZRANGEBYSCORE' ? ['-inf', '+inf'] : ['+inf', '-inf'];
      const all = command === 'ZRANGEBYSCORE' ? ['a', 'b'] : ['b', 'a'];
      assert.deepEqual(parseArrayReply(await sendCommand(port, argv(command, 'large-ranges', ...bounds, 'LIMIT', '0', max))), all);
      assert.deepEqual(parseArrayReply(await sendCommand(port, argv(command, 'large-ranges', ...bounds, 'LIMIT', max, '1'))), []);
    }
  });

});
