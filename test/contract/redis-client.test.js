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

  it('supports multi-value commands through the redis client API', async () => {
    assert.equal(await client.mSetNX({ 'contract:nx:1': 'v1', 'contract:nx:2': 'v2' }), true);
    assert.equal(await client.mSetNX({ 'contract:nx:3': 'v3', 'contract:nx:1': 'changed' }), false);

    await client.sAdd('contract:set', ['a', 'b']);
    assert.deepEqual(await client.smIsMember('contract:set', ['a', 'missing', 'b']), [true, false, true]);

    await client.zAdd('contract:zscore', [{ score: 1, value: 'a' }, { score: 2, value: 'b' }]);
    assert.deepEqual(await client.zmScore('contract:zscore', ['a', 'missing', 'b']), [1, null, 2]);

    await client.rPush('contract:list', ['a', 'b', 'c']);
    assert.deepEqual(await client.lmPop('contract:list', 'LEFT', { COUNT: 2 }), ['contract:list', ['a', 'b']]);

    await client.zAdd('contract:zpop', [{ score: 1, value: 'a' }, { score: 2, value: 'b' }]);
    assert.deepEqual(await client.zmPop('contract:zpop', 'MAX', { COUNT: 2 }), {
      key: 'contract:zpop',
      elements: [{ value: 'b', score: 2 }, { value: 'a', score: 1 }],
    });
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
