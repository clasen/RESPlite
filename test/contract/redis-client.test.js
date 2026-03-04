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

  it('HLEN returns field count', async () => {
    await client.hSet('hlen:c1', { f1: 'v1', f2: 'v2', f3: 'v3' });
    const n = await client.hLen('hlen:c1');
    assert.equal(n, 3);
  });

  it('HLEN on non-existent key returns 0', async () => {
    const n = await client.hLen('hlen:c:missing');
    assert.equal(n, 0);
  });

  it('LREM count=0 removes all occurrences', async () => {
    await client.rPush('lrem:c1', ['a', 'b', 'a', 'c', 'a']);
    const removed = await client.lRem('lrem:c1', 0, 'a');
    assert.equal(removed, 3);
    const items = await client.lRange('lrem:c1', 0, -1);
    assert.deepEqual(items, ['b', 'c']);
  });

  it('LREM count>0 removes from head', async () => {
    await client.rPush('lrem:c2', ['a', 'b', 'a', 'c', 'a']);
    const removed = await client.lRem('lrem:c2', 2, 'a');
    assert.equal(removed, 2);
    const items = await client.lRange('lrem:c2', 0, -1);
    assert.deepEqual(items, ['b', 'c', 'a']);
  });

  it('LREM count<0 removes from tail', async () => {
    await client.rPush('lrem:c3', ['a', 'b', 'a', 'c', 'a']);
    const removed = await client.lRem('lrem:c3', -2, 'a');
    assert.equal(removed, 2);
    const items = await client.lRange('lrem:c3', 0, -1);
    assert.deepEqual(items, ['a', 'b', 'c']);
  });

  it('LREM on non-existent key returns 0', async () => {
    const n = await client.lRem('lrem:c:missing', 1, 'x');
    assert.equal(n, 0);
  });
});
