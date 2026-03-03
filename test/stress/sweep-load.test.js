import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('Sweep under load', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('SET with EX and GET during TTL', async () => {
    await sendCommand(port, argv('SET', 'ttlkey', 'v', 'EX', '2'));
    const v = await sendCommand(port, argv('GET', 'ttlkey'));
    assert.ok(v.toString().includes('v'));
  });
});
