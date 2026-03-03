import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('Lists integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('LPUSH returns new length and order is c,b,a', async () => {
    const lenReply = await sendCommand(port, argv('LPUSH', 'mylist', 'a', 'b', 'c'));
    const len = tryParseValue(lenReply, 0);
    assert.equal(len.value, 3);

    const rangeReply = await sendCommand(port, argv('LRANGE', 'mylist', '0', '-1'));
    const arr = tryParseValue(rangeReply, 0);
    assert.ok(Array.isArray(arr.value));
    assert.equal(arr.value.length, 3);
    assert.equal(arr.value[0].toString('utf8'), 'c');
    assert.equal(arr.value[1].toString('utf8'), 'b');
    assert.equal(arr.value[2].toString('utf8'), 'a');
  });

  it('RPUSH appends and LLEN returns length', async () => {
    const lenReply = await sendCommand(port, argv('RPUSH', 'mylist2', 'x', 'y', 'z'));
    assert.equal(tryParseValue(lenReply, 0).value, 3);

    const llenReply = await sendCommand(port, argv('LLEN', 'mylist2'));
    assert.equal(tryParseValue(llenReply, 0).value, 3);

    const rangeReply = await sendCommand(port, argv('LRANGE', 'mylist2', '0', '-1'));
    const arr = tryParseValue(rangeReply, 0).value;
    assert.equal(arr[0].toString('utf8'), 'x');
    assert.equal(arr[1].toString('utf8'), 'y');
    assert.equal(arr[2].toString('utf8'), 'z');
  });

  it('LLEN on non-existent key returns 0', async () => {
    const reply = await sendCommand(port, argv('LLEN', 'nonexistent'));
    assert.equal(tryParseValue(reply, 0).value, 0);
  });

  it('LRANGE on non-existent key returns empty array', async () => {
    const reply = await sendCommand(port, argv('LRANGE', 'nonexistent', '0', '-1'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    assert.equal(arr.length, 0);
  });

  it('LPOP without count returns single value, then nil when empty', async () => {
    await sendCommand(port, argv('LPUSH', 'poplist', 'only'));
    const popReply = await sendCommand(port, argv('LPOP', 'poplist'));
    const v = tryParseValue(popReply, 0).value;
    assert.ok(Buffer.isBuffer(v));
    assert.equal(v.toString('utf8'), 'only');

    const nilReply = await sendCommand(port, argv('LPOP', 'poplist'));
    assert.ok(nilReply.toString('ascii').startsWith('$-1'));
  });

  it('RPOP with count returns array', async () => {
    await sendCommand(port, argv('RPUSH', 'rpoplist', 'a', 'b', 'c'));
    const reply = await sendCommand(port, argv('RPOP', 'rpoplist', '2'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    assert.equal(arr.length, 2);
    assert.equal(arr[0].toString('utf8'), 'c');
    assert.equal(arr[1].toString('utf8'), 'b');
  });

  it('LINDEX returns element at index', async () => {
    await sendCommand(port, argv('RPUSH', 'idxlist', 'first', 'second', 'third'));
    const v0 = tryParseValue(await sendCommand(port, argv('LINDEX', 'idxlist', '0')), 0).value;
    const v1 = tryParseValue(await sendCommand(port, argv('LINDEX', 'idxlist', '1')), 0).value;
    const vNeg1 = tryParseValue(await sendCommand(port, argv('LINDEX', 'idxlist', '-1')), 0).value;
    assert.equal(v0.toString('utf8'), 'first');
    assert.equal(v1.toString('utf8'), 'second');
    assert.equal(vNeg1.toString('utf8'), 'third');
  });

  it('LPUSH on string key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('SET', 'skey', 'sval'));
    const reply = await sendCommand(port, argv('LPUSH', 'skey', 'a'));
    const msg = reply.toString('utf8');
    assert.ok(msg.includes('WRONGTYPE'));
    assert.ok(msg.includes('wrong kind of value'));
  });

  it('GET on list key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('LPUSH', 'lkey', 'x'));
    const reply = await sendCommand(port, argv('GET', 'lkey'));
    assert.ok(reply.toString('utf8').includes('WRONGTYPE'));
  });

  it('list survives restart', async () => {
    const s1 = await createTestServer();
    await sendCommand(s1.port, argv('RPUSH', 'persist_list', 'one', 'two'));
    const dbPath = s1.dbPath;
    await s1.closeAsync();
    s1.db.close();
    const s2 = await createTestServer({ dbPath });
    const lenReply = await sendCommand(s2.port, argv('LLEN', 'persist_list'));
    assert.equal(tryParseValue(lenReply, 0).value, 2);
    const rangeReply = await sendCommand(s2.port, argv('LRANGE', 'persist_list', '0', '-1'));
    const arr = tryParseValue(rangeReply, 0).value;
    assert.equal(arr[0].toString('utf8'), 'one');
    assert.equal(arr[1].toString('utf8'), 'two');
    await s2.closeAsync();
  });

  it('binary-safe list values', async () => {
    const bin = Buffer.from([0x00, 0xff, 0x80]);
    await sendCommand(port, [Buffer.from('LPUSH'), Buffer.from('binlist'), bin]);
    const reply = await sendCommand(port, argv('LINDEX', 'binlist', '0'));
    const parsed = tryParseValue(reply, 0).value;
    assert.ok(Buffer.isBuffer(parsed));
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0], 0x00);
    assert.equal(parsed[1], 0xff);
    assert.equal(parsed[2], 0x80);
  });
});
