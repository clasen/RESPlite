import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('Sets integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('SADD and SMEMBERS', async () => {
    await sendCommand(port, argv('SADD', 'tags', 'a', 'b', 'c'));
    const reply = await sendCommand(port, argv('SMEMBERS', 'tags'));
    const s = reply.toString('ascii');
    assert.ok(s.includes('$1\r\na\r\n'));
    assert.ok(s.includes('$1\r\nb\r\n'));
    assert.ok(s.includes('$1\r\nc\r\n'));
  });
});
