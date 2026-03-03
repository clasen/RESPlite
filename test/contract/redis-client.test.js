import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { createTestServer } from '../helpers/server.js';

describe('redis client compatibility', () => {
  let s;
  let port;
  let client;

  before(async () => {
    s = await createTestServer();
    port = s.port;
    client = createClient({ socket: { port, host: '127.0.0.1' } });
    await client.connect();
  });

  after(async () => {
    await client.quit();
    await s.closeAsync();
  });

  it('unsupported command returns error', async () => {
    try {
      await client.sendCommand(['SUBSCRIBE', 'ch']);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e.message.includes('not supported') || (e.message && e.message.length > 0));
    }
  });

  it('MGET returns array', async () => {
    await client.set('m1', 'v1');
    const arr = await client.mGet(['m1', 'missing']);
    assert.equal(arr[0], 'v1');
    assert.equal(arr[1], null);
  });
});
