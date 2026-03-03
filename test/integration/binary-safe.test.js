import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('Binary-safe', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('SET/GET with binary value', async () => {
    const bin = Buffer.from([0x00, 0x01, 0xff, 0x0a]);
    await sendCommand(port, [...argv('SET', 'bin'), bin]);
    const reply = await sendCommand(port, argv('GET', 'bin'));
    assert.ok(reply.toString('ascii').startsWith('$4\r\n'));
    assert.ok(reply.slice(4, 8).equals(bin));
  });
});
