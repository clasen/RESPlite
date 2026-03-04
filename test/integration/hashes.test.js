import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('Hashes integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('HSET and HGET', async () => {
    await sendCommand(port, argv('HSET', 'user:1', 'name', 'Martin', 'age', '42'));
    const nameReply = await sendCommand(port, argv('HGET', 'user:1', 'name'));
    assert.equal(nameReply.toString('utf8'), '$6\r\nMartin\r\n');
  });

  it('HGETALL', async () => {
    await sendCommand(port, argv('HSET', 'h', 'a', '1', 'b', '2'));
    const reply = await sendCommand(port, argv('HGETALL', 'h'));
    const s = reply.toString('ascii');
    assert.ok(s.includes('$1\r\na\r\n'));
    assert.ok(s.includes('$1\r\n1\r\n'));
    assert.ok(s.includes('$1\r\nb\r\n'));
    assert.ok(s.includes('$1\r\n2\r\n'));
  });

  it('HLEN returns field count', async () => {
    await sendCommand(port, argv('HSET', 'hlen:1', 'f1', 'v1', 'f2', 'v2', 'f3', 'v3'));
    const reply = await sendCommand(port, argv('HLEN', 'hlen:1'));
    assert.equal(tryParseValue(reply, 0).value, 3);
  });

  it('HLEN on non-existent key returns 0', async () => {
    const reply = await sendCommand(port, argv('HLEN', 'hlen:nonexistent'));
    assert.equal(tryParseValue(reply, 0).value, 0);
  });

  it('HLEN decreases after HDEL', async () => {
    await sendCommand(port, argv('HSET', 'hlen:2', 'a', '1', 'b', '2'));
    await sendCommand(port, argv('HDEL', 'hlen:2', 'a'));
    const reply = await sendCommand(port, argv('HLEN', 'hlen:2'));
    assert.equal(tryParseValue(reply, 0).value, 1);
  });

  it('HLEN on wrong type returns WRONGTYPE', async () => {
    await sendCommand(port, argv('SET', 'hlen:str', 'value'));
    const reply = await sendCommand(port, argv('HLEN', 'hlen:str'));
    assert.ok(reply.toString('utf8').includes('WRONGTYPE'));
  });
});
