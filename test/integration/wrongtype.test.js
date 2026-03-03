import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('WRONGTYPE integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('GET on hash key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('HSET', 'h', 'f', 'v'));
    const reply = await sendCommand(port, argv('GET', 'h'));
    const msg = reply.toString('utf8');
    assert.ok(msg.includes('WRONGTYPE'));
    assert.ok(msg.includes('wrong kind of value'));
  });

  it('HSET on string key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('SET', 's', 'x'));
    const reply = await sendCommand(port, argv('HSET', 's', 'f', 'v'));
    const msg = reply.toString('utf8');
    assert.ok(msg.includes('WRONGTYPE'));
  });
});
