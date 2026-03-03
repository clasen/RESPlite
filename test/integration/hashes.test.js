import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

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
});
