import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('TTL integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('TTL missing returns -2', async () => {
    const reply = await sendCommand(port, argv('TTL', 'nokey'));
    assert.equal(reply.toString('ascii'), ':-2\r\n');
  });

  it('TTL key without expiry returns -1', async () => {
    await sendCommand(port, argv('SET', 'k', 'v'));
    const reply = await sendCommand(port, argv('TTL', 'k'));
    assert.equal(reply.toString('ascii'), ':-1\r\n');
  });

  it('EXPIRE and TTL', async () => {
    await sendCommand(port, argv('SET', 'e', '1'));
    await sendCommand(port, argv('EXPIRE', 'e', '60'));
    const reply = await sendCommand(port, argv('TTL', 'e'));
    const t = parseInt(reply.toString('ascii').replace(/\D/g, ''), 10);
    assert.ok(t >= 59 && t <= 60);
  });

  it('PERSIST removes TTL', async () => {
    await sendCommand(port, argv('SET', 'p', 'v'));
    await sendCommand(port, argv('EXPIRE', 'p', '10'));
    await sendCommand(port, argv('PERSIST', 'p'));
    const reply = await sendCommand(port, argv('TTL', 'p'));
    assert.equal(reply.toString('ascii'), ':-1\r\n');
  });
});
