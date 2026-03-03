import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('SCAN integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('SCAN 0 returns cursor and keys', async () => {
    await sendCommand(port, argv('SET', 'k1', 'v1'));
    await sendCommand(port, argv('SET', 'k2', 'v2'));
    const reply = await sendCommand(port, argv('SCAN', '0'));
    const s = reply.toString('ascii');
    assert.ok(s.startsWith('*2'));
    assert.ok(s.includes('$1'));
  });
});
