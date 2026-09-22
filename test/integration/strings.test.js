import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('Strings integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  async function assertTtlAround(key, expected) {
    const reply = await sendCommand(port, argv('TTL', key));
    const ttl = parseInt(reply.toString('ascii').slice(1), 10);
    assert.ok(ttl === expected || ttl === expected - 1, `TTL ${ttl} should be ~${expected}`);
  }

  it('SET and GET', async () => {
    await sendCommand(port, argv('SET', 'foo', 'bar'));
    const getReply = await sendCommand(port, argv('GET', 'foo'));
    assert.equal(getReply.toString('utf8'), '$3\r\nbar\r\n');
  });

  it('GET missing returns null bulk', async () => {
    const reply = await sendCommand(port, argv('GET', 'missing'));
    assert.equal(reply.toString('ascii'), '$-1\r\n');
  });

  it('DEL returns count', async () => {
    await sendCommand(port, argv('SET', 'd1', 'x'));
    const reply = await sendCommand(port, argv('DEL', 'd1'));
    assert.equal(reply.toString('ascii'), ':1\r\n');
  });

  it('UNLINK returns count like DEL', async () => {
    await sendCommand(port, argv('SET', 'u1', 'a'));
    await sendCommand(port, argv('SET', 'u2', 'b'));
    const one = await sendCommand(port, argv('UNLINK', 'u1'));
    assert.equal(one.toString('ascii'), ':1\r\n');
    const two = await sendCommand(port, argv('UNLINK', 'u2', 'u3'));
    assert.equal(two.toString('ascii'), ':1\r\n');
    const zero = await sendCommand(port, argv('UNLINK', 'u1'));
    assert.equal(zero.toString('ascii'), ':0\r\n');
  });

  it('EXISTS returns count', async () => {
    await sendCommand(port, argv('SET', 'ex1', 'a'));
    const r = await sendCommand(port, argv('EXISTS', 'ex1', 'ex2'));
    assert.equal(r.toString('ascii'), ':1\r\n');
  });

  it('SETEX sets key with TTL and returns OK', async () => {
    const setexReply = await sendCommand(port, argv('SETEX', 'setexkey', '60', 'setexval'));
    assert.equal(setexReply.toString('utf8'), '+OK\r\n');
    const getReply = await sendCommand(port, argv('GET', 'setexkey'));
    assert.equal(getReply.toString('utf8'), '$8\r\nsetexval\r\n');
    const ttlReply = await sendCommand(port, argv('TTL', 'setexkey'));
    const t = parseInt(ttlReply.toString('ascii').replace(/\D/g, ''), 10);
    assert.ok(t >= 59 && t <= 60);
  });

  it('SETNX writes only when the key is absent', async () => {
    const created = await sendCommand(port, argv('SETNX', 'setnxkey', 'first'));
    assert.equal(created.toString('ascii'), ':1\r\n');

    const blocked = await sendCommand(port, argv('SETNX', 'setnxkey', 'second'));
    assert.equal(blocked.toString('ascii'), ':0\r\n');
    assert.equal(
      (await sendCommand(port, argv('GET', 'setnxkey'))).toString('utf8'),
      '$5\r\nfirst\r\n'
    );

    const expired = await sendCommand(port, argv('SET', 'setnxexpires', 'old', 'PX', '10'));
    assert.equal(expired.toString('utf8'), '+OK\r\n');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      (await sendCommand(port, argv('SETNX', 'setnxexpires', 'new'))).toString('ascii'),
      ':1\r\n'
    );
  });

  it('SETNX returns 0 for an existing key of another type', async () => {
    await sendCommand(port, argv('HSET', 'setnxhash', 'field', 'value'));
    assert.equal(
      (await sendCommand(port, argv('SETNX', 'setnxhash', 'string-value'))).toString('ascii'),
      ':0\r\n'
    );
    assert.equal(
      (await sendCommand(port, argv('TYPE', 'setnxhash'))).toString('utf8'),
      '+hash\r\n'
    );
  });

  it('SETNX wrong number of arguments returns error', async () => {
    const reply = await sendCommand(port, argv('SETNX', 'setnxkey'));
    assert.ok(reply.toString('utf8').includes('wrong number of arguments'));
  });

  it('SET NX and XX report a skipped write as nil', async () => {
    assert.equal((await sendCommand(port, argv('SET', 'opt:nx', 'first', 'NX'))).toString('utf8'), '+OK\r\n');
    assert.equal((await sendCommand(port, argv('SET', 'opt:nx', 'second', 'NX'))).toString('ascii'), '$-1\r\n');
    assert.equal((await sendCommand(port, argv('GET', 'opt:nx'))).toString('utf8'), '$5\r\nfirst\r\n');

    assert.equal((await sendCommand(port, argv('SET', 'opt:xx', 'value', 'XX'))).toString('ascii'), '$-1\r\n');
    assert.equal((await sendCommand(port, argv('SET', 'opt:nx', 'second', 'XX'))).toString('utf8'), '+OK\r\n');
    assert.equal((await sendCommand(port, argv('GET', 'opt:nx'))).toString('utf8'), '$6\r\nsecond\r\n');
  });

  it('SET GET replies with the previous value in every combination', async () => {
    assert.equal((await sendCommand(port, argv('SET', 'opt:get', 'first', 'GET'))).toString('ascii'), '$-1\r\n');
    assert.equal((await sendCommand(port, argv('SET', 'opt:get', 'second', 'GET'))).toString('utf8'), '$5\r\nfirst\r\n');
    assert.equal((await sendCommand(port, argv('GET', 'opt:get'))).toString('utf8'), '$6\r\nsecond\r\n');

    assert.equal((await sendCommand(port, argv('SET', 'opt:get', 'third', 'NX', 'GET'))).toString('utf8'), '$6\r\nsecond\r\n');
    assert.equal((await sendCommand(port, argv('GET', 'opt:get'))).toString('utf8'), '$6\r\nsecond\r\n');

    assert.equal((await sendCommand(port, argv('SET', 'opt:get', 'fourth', 'GET', 'XX'))).toString('utf8'), '$6\r\nsecond\r\n');
    assert.equal((await sendCommand(port, argv('GET', 'opt:get'))).toString('utf8'), '$6\r\nfourth\r\n');

    assert.equal((await sendCommand(port, argv('SET', 'opt:get:missing', 'value', 'GET', 'XX'))).toString('ascii'), '$-1\r\n');
    assert.equal((await sendCommand(port, argv('EXISTS', 'opt:get:missing'))).toString('ascii'), ':0\r\n');

    await sendCommand(port, argv('SET', 'opt:get:empty', ''));
    assert.equal((await sendCommand(port, argv('SET', 'opt:get:empty', 'value', 'GET'))).toString('utf8'), '$0\r\n\r\n');
  });

  it('SET GET returns WRONGTYPE without writing when the key holds another type', async () => {
    await sendCommand(port, argv('HSET', 'opt:hash', 'field', 'value'));

    assert.ok((await sendCommand(port, argv('SET', 'opt:hash', 'string', 'GET'))).toString('utf8').startsWith('-WRONGTYPE'));
    assert.ok((await sendCommand(port, argv('SET', 'opt:hash', 'string', 'NX', 'GET'))).toString('utf8').startsWith('-WRONGTYPE'));
    assert.equal((await sendCommand(port, argv('TYPE', 'opt:hash'))).toString('utf8'), '+hash\r\n');
    assert.equal((await sendCommand(port, argv('SET', 'opt:hash', 'string', 'NX'))).toString('ascii'), '$-1\r\n');
  });

  it('SET expiry options match Redis TTL behavior', async () => {
    await sendCommand(port, argv('SET', 'opt:ttl', 'value', 'EX', '100'));
    await assertTtlAround('opt:ttl', 100);

    await sendCommand(port, argv('SET', 'opt:ttl', 'next', 'KEEPTTL'));
    await assertTtlAround('opt:ttl', 100);
    assert.equal((await sendCommand(port, argv('GET', 'opt:ttl'))).toString('utf8'), '$4\r\nnext\r\n');

    await sendCommand(port, argv('SET', 'opt:ttl', 'value', 'EX', '100'));
    await sendCommand(port, argv('SET', 'opt:ttl', 'plain'));
    assert.equal((await sendCommand(port, argv('TTL', 'opt:ttl'))).toString('ascii'), ':-1\r\n');

    await sendCommand(port, argv('SET', 'opt:ttl', 'value', 'EX', '100'));
    await sendCommand(port, argv('SET', 'opt:ttl', 'xx', 'XX'));
    assert.equal((await sendCommand(port, argv('TTL', 'opt:ttl'))).toString('ascii'), ':-1\r\n');

    await sendCommand(port, argv('SET', 'opt:ttl', 'value', 'EX', '100'));
    assert.equal((await sendCommand(port, argv('SET', 'opt:ttl', 'ignored', 'NX'))).toString('ascii'), '$-1\r\n');
    await assertTtlAround('opt:ttl', 100);
    assert.equal((await sendCommand(port, argv('GET', 'opt:ttl'))).toString('utf8'), '$5\r\nvalue\r\n');

    await sendCommand(port, argv('SET', 'opt:exat', 'value', 'EXAT', String(Math.floor(Date.now() / 1000) + 100)));
    await assertTtlAround('opt:exat', 100);
    await sendCommand(port, argv('SET', 'opt:pxat', 'value', 'PXAT', String(Date.now() + 200000)));
    await assertTtlAround('opt:pxat', 200);

    assert.equal((await sendCommand(port, argv('SET', 'opt:past', 'value', 'EXAT', '1'))).toString('utf8'), '+OK\r\n');
    assert.equal((await sendCommand(port, argv('EXISTS', 'opt:past'))).toString('ascii'), ':0\r\n');

    await sendCommand(port, argv('SET', 'opt:repeat', 'value', 'EX', '30', 'EX', '100'));
    await assertTtlAround('opt:repeat', 100);

    assert.equal((await sendCommand(port, argv('set', 'opt:lower', 'value', 'nx', 'ex', '100'))).toString('utf8'), '+OK\r\n');
    await assertTtlAround('opt:lower', 100);
  });

  it('returns full-width PTTL integers on the wire and preserves them with KEEPTTL', async () => {
    const max = 9223372036854775807n;
    await sendCommand(port, argv('SET', 'wide-ttl', 'first', 'PXAT', String(max)));
    assert.equal((await sendCommand(port, argv('SET', 'wide-ttl', 'next', 'GET', 'KEEPTTL'))).toString(), '$5\r\nfirst\r\n');
    const before = BigInt(Date.now());
    const raw = (await sendCommand(port, argv('PTTL', 'wide-ttl'))).toString();
    const after = BigInt(Date.now());
    assert.match(raw, /^:\d+\r\n$/);
    const remaining = BigInt(raw.slice(1).trim());
    assert.ok(remaining >= max - after && remaining <= max - before);
  });

  it('SET rejects invalid option combinations like Redis', async () => {
    const errors = [
      [['SET', 'opt:bad', 'value', 'NX', 'XX'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'XX', 'NX'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'BLAH'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'EX', '10', 'PX', '1000'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'EX', '10', 'EXAT', '99999999'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'EX', '10', 'KEEPTTL'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'KEEPTTL', 'EX', '10'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'EX'], 'ERR syntax error'],
      [['SET', 'opt:bad', 'value', 'EX', '0'], 'ERR invalid expire time in \'set\' command'],
      [['SET', 'opt:bad', 'value', 'EX', '-1'], 'ERR invalid expire time in \'set\' command'],
      [['SET', 'opt:bad', 'value', 'EXAT', '0'], 'ERR invalid expire time in \'set\' command'],
      [['SET', 'opt:bad', 'value', 'PXAT', '-1'], 'ERR invalid expire time in \'set\' command'],
      [['SET', 'opt:bad', 'value', 'EX', 'abc'], 'ERR value is not an integer or out of range'],
      [['SET', 'opt:bad', 'value', 'EX', '10.5'], 'ERR value is not an integer or out of range'],
      [['SET', 'opt:bad', 'value', 'EX', 'NX'], 'ERR value is not an integer or out of range'],
      [['SET', 'opt:bad', 'value', 'EX', '99999999999999999999'], 'ERR value is not an integer or out of range'],
    ];
    for (const [command, expected] of errors) {
      const reply = await sendCommand(port, argv(...command));
      assert.equal(reply.toString('utf8'), `-${expected}\r\n`, command.join(' '));
    }
    assert.equal((await sendCommand(port, argv('EXISTS', 'opt:bad'))).toString('ascii'), ':0\r\n');
  });

  it('SET rejects a missing value and keeps SETEX working through the shared parser', async () => {
    const reply = await sendCommand(port, argv('SET', 'opt:arity'));
    assert.ok(reply.toString('utf8').includes('wrong number of arguments'));
    assert.equal((await sendCommand(port, argv('SETEX', 'opt:setex', '100', 'value'))).toString('utf8'), '+OK\r\n');
    await assertTtlAround('opt:setex', 100);
  });

  it('SETEX wrong number of arguments returns error', async () => {
    const reply = await sendCommand(port, argv('SETEX', 'k', '10'));
    assert.ok(reply.toString('utf8').includes('wrong number of arguments'));
  });

  it('SETEX invalid seconds returns error', async () => {
    const reply = await sendCommand(port, argv('SETEX', 'k', '0', 'v'));
    assert.ok(reply.toString('utf8').includes('invalid expire time'));
  });
});
