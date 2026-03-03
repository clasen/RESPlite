import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('TYPE integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('TYPE missing returns none', async () => {
    const reply = await sendCommand(port, argv('TYPE', 'nokey'));
    assert.equal(reply.toString('ascii'), '+none\r\n');
  });

  it('TYPE string key returns string', async () => {
    await sendCommand(port, argv('SET', 'sk', 'v'));
    const reply = await sendCommand(port, argv('TYPE', 'sk'));
    assert.equal(reply.toString('ascii'), '+string\r\n');
  });
});
