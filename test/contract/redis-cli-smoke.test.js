import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { createTestServer } from '../helpers/server.js';

describe('redis client contract', () => {
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

  it('PING returns PONG', async () => {
    const pong = await client.ping();
    assert.equal(pong, 'PONG');
  });

  it('SET and GET', async () => {
    await client.set('foo', 'bar');
    const v = await client.get('foo');
    assert.equal(v, 'bar');
  });

  it('acceptance sequence from SPEC 24', async () => {
    await client.set('foo', 'bar');
    assert.equal(await client.get('foo'), 'bar');
    await client.expire('foo', 10);
    assert.ok((await client.ttl('foo')) >= 0);
    await client.del('foo');
    await client.hSet('user:1', { name: 'Martin', age: '42' });
    assert.equal(await client.hGet('user:1', 'name'), 'Martin');
    const all = await client.hGetAll('user:1');
    assert.equal(all.name, 'Martin');
    assert.equal(all.age, '42');
    await client.sAdd('tags', ['a', 'b', 'c']);
    const members = await client.sMembers('tags');
    assert.equal(members.length, 3);
    assert.ok(members.includes('a'));
    assert.equal(await client.type('foo'), 'none');
    const scanResult = await client.scan(0);
    const keys = Array.isArray(scanResult) ? scanResult[1] : scanResult?.keys ?? [];
    assert.ok(Array.isArray(keys));
  });
});
