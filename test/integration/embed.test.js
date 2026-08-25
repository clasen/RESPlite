import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createClient } from 'redis';
import { createRESPlite, createRESPliteGroup } from '../../src/embed.js';
import { tmpDbPath } from '../helpers/tmp.js';

async function redisClient(port) {
  const client = createClient({ socket: { port, host: '127.0.0.1' } });
  await client.connect();
  return client;
}

function infoObject(reply) {
  return Object.fromEntries(
    Array.from({ length: reply.length / 2 }, (_, i) => reply.slice(i * 2, i * 2 + 2))
  );
}

describe('createRESPlite', () => {
  it('removes its graceful-shutdown listeners when closed', async () => {
    const initialSigtermListeners = process.listenerCount('SIGTERM');
    const initialSigintListeners = process.listenerCount('SIGINT');
    const srv = await createRESPlite();
    try {
      assert.equal(process.listenerCount('SIGTERM'), initialSigtermListeners + 1);
      assert.equal(process.listenerCount('SIGINT'), initialSigintListeners + 1);
    } finally {
      await srv.close();
    }
    await srv.close();
    assert.equal(process.listenerCount('SIGTERM'), initialSigtermListeners);
    assert.equal(process.listenerCount('SIGINT'), initialSigintListeners);
  });

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

  it('shares Pub/Sub across embedded client connections', async () => {
    const srv = await createRESPlite();
    const publisher = await redisClient(srv.port);
    const subscriber = publisher.duplicate();
    await subscriber.connect();
    const messages = [];
    try {
      await subscriber.subscribe('embedded:events', (message) => messages.push(message));
      assert.equal(await publisher.publish('embedded:events', 'hello'), 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(messages, ['hello']);
      await subscriber.unsubscribe('embedded:events');
    } finally {
      await subscriber.quit();
      await publisher.quit();
      await srv.close();
    }
  });

  it('enables the hot string cache by default and allows disabling it', async () => {
    const srv = await createRESPlite();
    const client = await redisClient(srv.port);
    await client.set('hot', 'value');
    assert.equal(await client.get('hot'), 'value');
    const enabledInfo = await client.sendCommand(['CACHE.INFO']);
    const enabled = infoObject(enabledInfo);
    assert.equal(enabled.enabled, '1');
    assert.equal(enabled.entries, '1');
    assert.ok(Number(enabled.hits) >= 1);
    await client.quit();
    await srv.close();

    const uncachedSrv = await createRESPlite({ cache: false });
    const uncachedClient = await redisClient(uncachedSrv.port);
    await uncachedClient.set('hot', 'value');
    await uncachedClient.get('hot');
    const disabledInfo = await uncachedClient.sendCommand(['CACHE.INFO']);
    const disabled = infoObject(disabledInfo);
    assert.equal(disabled.enabled, '0');
    assert.equal(disabled.entries, '0');
    await uncachedClient.quit();
    await uncachedSrv.close();
  });

  it('warms, reuses and invalidates the hash cache through RESP commands', async () => {
    const srv = await createRESPlite();
    const client = await redisClient(srv.port);
    try {
      await client.hSet('profile', { name: 'Ada', role: 'engineer' });

      const beforeWarm = infoObject(await client.sendCommand(['CACHE.INFO']));
      assert.equal(beforeWarm.entries, '0');

      assert.deepEqual(
        { ...await client.hGetAll('profile') },
        { name: 'Ada', role: 'engineer' }
      );
      const warmed = infoObject(await client.sendCommand(['CACHE.INFO']));
      assert.equal(warmed.entries, '1');
      assert.equal(warmed.misses, '1');

      assert.equal(await client.hGet('profile', 'name'), 'Ada');
      assert.deepEqual(await client.hmGet('profile', ['role', 'missing']), ['engineer', null]);
      const reused = infoObject(await client.sendCommand(['CACHE.INFO']));
      assert.equal(reused.hits, '2');

      await client.hSet('profile', 'role', 'scientist');
      const invalidated = infoObject(await client.sendCommand(['CACHE.INFO']));
      assert.equal(invalidated.entries, '0');

      assert.equal(await client.hGet('profile', 'role'), 'scientist');
    } finally {
      await client.quit();
      await srv.close();
    }
  });

  it('warms, reuses and invalidates set, list and sorted-set caches through RESP commands', async () => {
    const srv = await createRESPlite();
    const client = await redisClient(srv.port);
    try {
      await client.sAdd('tags', ['a', 'b']);
      await client.rPush('queue', ['first', 'second']);
      await client.zAdd('ranking', [
        { score: 1, value: 'alice' },
        { score: 2, value: 'bob' },
      ]);

      assert.equal(infoObject(await client.sendCommand(['CACHE.INFO'])).entries, '0');
      assert.deepEqual((await client.sMembers('tags')).sort(), ['a', 'b']);
      assert.deepEqual(await client.lRange('queue', 0, -1), ['first', 'second']);
      assert.deepEqual(await client.zRange('ranking', 0, -1), ['alice', 'bob']);

      const warmed = infoObject(await client.sendCommand(['CACHE.INFO']));
      assert.equal(warmed.entries, '3');
      assert.equal(warmed.misses, '3');

      assert.equal(await client.sIsMember('tags', 'b'), true);
      assert.equal(await client.lIndex('queue', 1), 'second');
      assert.equal(await client.zScore('ranking', 'bob'), 2);
      assert.equal(infoObject(await client.sendCommand(['CACHE.INFO'])).hits, '3');

      await client.sAdd('tags', 'c');
      await client.lPush('queue', 'zero');
      await client.zAdd('ranking', { score: 3, value: 'carol' });
      assert.equal(infoObject(await client.sendCommand(['CACHE.INFO'])).entries, '0');
    } finally {
      await client.quit();
      await srv.close();
    }
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

  it('accepts pragma overrides (convention: template first, overrides only when needed)', async () => {
    const srv = await createRESPlite({
      pragma: { synchronous: 'FULL', cache_size: -10_000 },
    });
    const client = await redisClient(srv.port);
    await client.set('k', 'v');
    assert.equal(await client.get('k'), 'v');
    await client.quit();
    await srv.close();
  });

  it('unsupported command still returns ERR command not supported yet to client', async () => {
    const srv = await createRESPlite();
    const client = await redisClient(srv.port);
    try {
      await client.sendCommand(['EVAL', 'return 1', '0']);
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
      await client.sendCommand(['EVAL', 'return 1', '0']);
    } catch (_) {}
    try {
      await client.sendCommand(['XADD', 'stream', '*', 'field', 'value']);
    } catch (_) {}
    await client.quit();
    await srv.close();
    const commands = unknownCalls.map((c) => c.command);
    assert.ok(commands.includes('EVAL'), 'expected EVAL in ' + commands.join(', '));
    assert.ok(commands.includes('XADD'), 'expected XADD in ' + commands.join(', '));
    const evalCall = unknownCalls.find((c) => c.command === 'EVAL');
    const xaddCall = unknownCalls.find((c) => c.command === 'XADD');
    assert.equal(evalCall.argsCount, 2);
    assert.equal(xaddCall.argsCount, 4);
    assert.equal(typeof evalCall.connectionId, 'number');
    assert.ok(evalCall.clientAddress.length > 0);
  });

  it('onUnknownCommand hook is also called for disabled commands', async () => {
    const unknownCalls = [];
    const srv = await createRESPlite({
      commandPolicy: {
        disabled: ['MONITOR'],
      },
      hooks: {
        onUnknownCommand(payload) {
          unknownCalls.push(payload);
        },
      },
    });
    const client = await redisClient(srv.port);
    try {
      await client.sendCommand(['MONITOR']);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e.message.includes('not supported'), e.message);
    }
    await client.quit();
    await srv.close();

    assert.equal(unknownCalls.length, 1);
    assert.equal(unknownCalls[0].command, 'MONITOR');
    assert.equal(unknownCalls[0].argsCount, 0);
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
    const hgetError = errorCalls.find((c) => c.command === 'HGET');
    assert.ok(hgetError, 'expected at least one HGET error (got: ' + errorCalls.map((c) => c.command).join(', ') + ')');
    assert.ok(hgetError.error.includes('WRONGTYPE'));
    assert.equal(typeof hgetError.connectionId, 'number');
    assert.ok(hgetError.clientAddress.length > 0);
  });
});

describe('createRESPliteGroup', () => {
  it('starts named independent servers with one pair of signal listeners', async () => {
    const initialSigtermListeners = process.listenerCount('SIGTERM');
    const initialSigintListeners = process.listenerCount('SIGINT');
    const group = await createRESPliteGroup({
      main: { port: 0, gracefulShutdown: true },
      cluster: { port: 0 },
    });
    const mainClient = await redisClient(group.servers.main.port);
    const clusterClient = await redisClient(group.servers.cluster.port);

    try {
      assert.deepEqual(Object.keys(group.servers), ['main', 'cluster']);
      assert.notEqual(group.servers.main.port, group.servers.cluster.port);
      assert.equal(process.listenerCount('SIGTERM'), initialSigtermListeners + 1);
      assert.equal(process.listenerCount('SIGINT'), initialSigintListeners + 1);

      await mainClient.set('scope', 'main');
      await clusterClient.set('scope', 'cluster');
      assert.equal(await mainClient.get('scope'), 'main');
      assert.equal(await clusterClient.get('scope'), 'cluster');
    } finally {
      await mainClient.quit();
      await clusterClient.quit();
      await group.close();
    }

    await group.close();
    assert.equal(process.listenerCount('SIGTERM'), initialSigtermListeners);
    assert.equal(process.listenerCount('SIGINT'), initialSigintListeners);
  });

  it('supports application-owned graceful shutdown', async () => {
    const initialSigtermListeners = process.listenerCount('SIGTERM');
    const initialSigintListeners = process.listenerCount('SIGINT');
    const group = await createRESPliteGroup({
      main: { port: 0 },
      cluster: { port: 0 },
    }, { gracefulShutdown: false });

    try {
      assert.equal(process.listenerCount('SIGTERM'), initialSigtermListeners);
      assert.equal(process.listenerCount('SIGINT'), initialSigintListeners);
    } finally {
      await group.close();
    }
  });

  it('attempts every server close before reporting failures', async () => {
    const group = await createRESPliteGroup({
      main: { port: 0 },
      cluster: { port: 0 },
    }, { gracefulShutdown: false });
    const closeMain = group.servers.main.close;
    const closeCluster = group.servers.cluster.close;
    let clusterClosed = false;

    group.servers.main.close = async () => {
      await closeMain();
      throw new Error('main close failed');
    };
    group.servers.cluster.close = async () => {
      await closeCluster();
      clusterClosed = true;
    };

    const firstClose = group.close();
    assert.strictEqual(group.close(), firstClose);
    await assert.rejects(
      firstClose,
      (error) => error instanceof AggregateError
        && error.message.includes('main')
        && error.errors[0].message === 'main close failed'
    );
    assert.equal(clusterClosed, true);
  });

  it('rejects empty groups and duplicate persistent databases', async () => {
    await assert.rejects(
      createRESPliteGroup({}),
      /requires at least one instance/
    );

    const dbPath = tmpDbPath();
    const aliasedDbPath = `${path.dirname(dbPath)}/./${path.basename(dbPath)}`;
    await assert.rejects(
      createRESPliteGroup({
        main: { db: dbPath },
        cluster: { db: aliasedDbPath },
      }),
      /cannot share SQLite database/
    );
  });

  it('rolls back servers already started when a later instance fails', async () => {
    const reservation = await createRESPlite({ port: 0, gracefulShutdown: false });
    const firstPort = reservation.port;
    await reservation.close();

    const blocker = await createRESPlite({ port: 0, gracefulShutdown: false });
    try {
      await assert.rejects(
        createRESPliteGroup({
          first: { port: firstPort },
          blocked: { port: blocker.port },
        }, { gracefulShutdown: false }),
        (error) => error?.code === 'EADDRINUSE'
      );

      const replacement = await createRESPlite({
        port: firstPort,
        gracefulShutdown: false,
      });
      await replacement.close();
    } finally {
      await blocker.close();
    }
  });
});
