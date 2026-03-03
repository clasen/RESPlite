import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { createRESPlite } from '../../src/embed.js';
import { tmpDbPath } from '../helpers/tmp.js';

async function redisClient(port) {
  const client = createClient({ socket: { port, host: '127.0.0.1' } });
  await client.connect();
  return client;
}

describe('createRESPlite', () => {
  it('returns a numeric port and a close function', async () => {
    const srv = await createRESPlite();
    assert.equal(typeof srv.port, 'number');
    assert.ok(srv.port > 0);
    assert.equal(typeof srv.close, 'function');
    await srv.close();
  });

  it('accepts connections and handles basic SET/GET', async () => {
    const srv = await createRESPlite();
    const client = await redisClient(srv.port);

    await client.set('hello', 'world');
    assert.equal(await client.get('hello'), 'world');

    await client.quit();
    await srv.close();
  });

  it('defaults to in-memory db when no db path given', async () => {
    const srv = await createRESPlite();
    const client = await redisClient(srv.port);

    await client.set('k', 'v');
    assert.equal(await client.get('k'), 'v');

    await client.quit();
    await srv.close();
  });

  it('close() stops the server (new connections refused)', async () => {
    const srv = await createRESPlite();
    const { port } = srv;

    const client = await redisClient(port);
    await client.quit();
    await srv.close();

    const refused = await new Promise((resolve) => {
      const c = createClient({ socket: { port, host: '127.0.0.1' }, socket_timeout: 500 });
      c.connect().then(() => { c.quit(); resolve(false); }).catch(() => resolve(true));
    });
    assert.ok(refused, 'expected connection to be refused after close()');
  });

  it('data persists across two sessions on the same db file', async () => {
    const dbPath = tmpDbPath();

    const srv1 = await createRESPlite({ db: dbPath });
    const c1 = await redisClient(srv1.port);
    await c1.set('persistent_key', 'survives restart');
    await c1.hSet('user:1', { name: 'Alice' });
    await c1.quit();
    await srv1.close();

    const srv2 = await createRESPlite({ db: dbPath });
    const c2 = await redisClient(srv2.port);
    assert.equal(await c2.get('persistent_key'), 'survives restart');
    assert.equal(await c2.hGet('user:1', 'name'), 'Alice');
    await c2.quit();
    await srv2.close();
  });

  it('respects the port option', async () => {
    const srv = await createRESPlite({ port: 0 });
    assert.ok(srv.port > 0);
    await srv.close();
  });

  it('respects the pragmaTemplate option without throwing', async () => {
    const srv = await createRESPlite({ pragmaTemplate: 'performance' });
    const client = await redisClient(srv.port);
    await client.set('x', '1');
    assert.equal(await client.get('x'), '1');
    await client.quit();
    await srv.close();
  });
});
