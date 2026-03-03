import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('Multi-client', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('concurrent INCR on same key', async () => {
    await sendCommand(port, argv('SET', 'counter', '0'));
    const promises = Array.from({ length: 10 }, () => sendCommand(port, argv('INCR', 'counter')));
    const replies = await Promise.all(promises);
    const values = replies.map((r) => parseInt(r.toString('ascii').replace(/\D/g, ''), 10));
    assert.equal(values[values.length - 1], 10);
    const final = await sendCommand(port, argv('GET', 'counter'));
    assert.equal(final.toString('ascii'), '$2\r\n10\r\n');
  });
});
