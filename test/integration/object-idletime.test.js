import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('OBJECT IDLETIME integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('OBJECT IDLETIME missing key returns nil', async () => {
    const reply = await sendCommand(port, argv('OBJECT', 'IDLETIME', 'nokey'));
    assert.equal(reply.toString('ascii'), '$-1\r\n');
  });

  it('OBJECT IDLETIME returns seconds since last write', async () => {
    await sendCommand(port, argv('SET', 'idlekey', 'v'));
    const reply = await sendCommand(port, argv('OBJECT', 'IDLETIME', 'idlekey'));
    const line = reply.toString('ascii');
    assert.match(line, /^:\d+\r\n$/);
    const seconds = parseInt(line.replace(/\D/g, ''), 10);
    assert.ok(seconds >= 0);
  });

  it('OBJECT IDLETIME increases after write', async () => {
    await sendCommand(port, argv('SET', 'idlekey2', 'v'));
    await sendCommand(port, argv('OBJECT', 'IDLETIME', 'idlekey2'));
    await new Promise((r) => setTimeout(r, 1100));
    const reply = await sendCommand(port, argv('OBJECT', 'IDLETIME', 'idlekey2'));
    const seconds = parseInt(reply.toString('ascii').replace(/\D/g, ''), 10);
    assert.ok(seconds >= 1, 'idle time should be at least 1 second after 1.1s wait');
  });

  it('OBJECT wrong subcommand returns error', async () => {
    const reply = await sendCommand(port, argv('OBJECT', 'REFCOUNT', 'k'));
    assert.ok(reply.toString('ascii').startsWith('-ERR'));
  });

  it('OBJECT with wrong number of args returns error', async () => {
    const reply = await sendCommand(port, argv('OBJECT', 'IDLETIME'));
    assert.ok(reply.toString('ascii').startsWith('-ERR'));
  });
});
