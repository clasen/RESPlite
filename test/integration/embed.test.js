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

  it('unsupported command still returns ERR command not supported yet to client', async () => {
    const srv = await createRESPlite();
    const client = await redisClient(srv.port);
    try {
      await client.sendCommand(['SUBSCRIBE', 'ch']);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e.message.includes('not supported'), e.message);
    }
    await client.quit();
    await srv.close();
  });

  it('onUnknownCommand hook is called for unsupported commands', async () => {
    const unknownCalls = [];
    const srv = await createRESPlite({
      hooks: {
        onUnknownCommand(payload) {
          unknownCalls.push(payload);
        },
      },
    });
    const client = await redisClient(srv.port);
    try {
      await client.sendCommand(['SUBSCRIBE', 'ch']);
    } catch (_) {}
    try {
      await client.sendCommand(['PUBLISH', 'ch', 'x']);
    } catch (_) {}
    await client.quit();
    await srv.close();
    const commands = unknownCalls.map((c) => c.command);
    assert.ok(commands.includes('SUBSCRIBE'), 'expected SUBSCRIBE in ' + commands.join(', '));
    assert.ok(commands.includes('PUBLISH'), 'expected PUBLISH in ' + commands.join(', '));
    const sub = unknownCalls.find((c) => c.command === 'SUBSCRIBE');
    const pub = unknownCalls.find((c) => c.command === 'PUBLISH');
    assert.equal(sub.argsCount, 1);
    assert.equal(pub.argsCount, 2);
    assert.equal(typeof sub.connectionId, 'number');
    assert.ok(sub.clientAddress.length > 0);
  });

  it('onCommandError hook is called when command returns or throws error', async () => {
    const errorCalls = [];
    const srv = await createRESPlite({
      hooks: {
        onCommandError(payload) {
          errorCalls.push(payload);
        },
      },
    });
    const client = await redisClient(srv.port);
    await client.set('k', 'str');
    try {
      await client.hGet('k', 'f');
    } catch (_) {}
    await client.quit();
    await srv.close();
    assert.equal(errorCalls.length, 1);
    assert.equal(errorCalls[0].command, 'HGET');
    assert.ok(errorCalls[0].error.includes('WRONGTYPE'));
    assert.equal(typeof errorCalls[0].connectionId, 'number');
    assert.ok(errorCalls[0].clientAddress.length > 0);
  });
});
