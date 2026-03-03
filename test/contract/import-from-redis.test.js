/**
 * Contract test for Redis import CLI (SPEC §26).
 * Requires a local Redis on 127.0.0.1:6379; skips if unavailable.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { importFromRedis } from '../../src/cli/import-from-redis.js';
import { createTestServer } from '../helpers/server.js';
import { tmpDbPath } from '../helpers/tmp.js';

const PREFIX = 'resplite:import:';
const REDIS_URL = 'redis://127.0.0.1:6379';

describe('import-from-redis', () => {
  let redisClient;
  let redisAvailable = false;

  before(async () => {
    try {
      redisClient = createClient({ url: REDIS_URL });
      await redisClient.connect();
      await redisClient.ping();
      redisAvailable = true;
    } catch (_) {
      redisAvailable = false;
    }
  });

  after(async () => {
    if (redisClient) {
      try {
        const keys = await redisClient.keys(PREFIX + '*');
        if (keys.length) await redisClient.del(keys);
        await redisClient.quit();
      } catch (_) {}
    }
  });

  it('skips when Redis is not available', { skip: redisAvailable }, () => {});

  it('imports strings, hashes, sets and TTL from Redis into SQLite', { skip: !redisAvailable }, async () => {
    const k1 = PREFIX + 's1';
    const k2 = PREFIX + 'h1';
    const k3 = PREFIX + 'set1';
    const k4 = PREFIX + 'ttl1';

    await redisClient.set(k1, 'hello');
    await redisClient.hSet(k2, { a: '1', b: '2' });
    await redisClient.sAdd(k3, ['x', 'y', 'z']);
    await redisClient.set(k4, 'expires');
    await redisClient.pExpire(k4, 60_000);

    const dbPath = tmpDbPath();
    const { stats } = await importFromRedis(redisClient, dbPath);

    assert.ok(stats.string >= 1, 'at least one string imported');
    assert.ok(stats.hash >= 1, 'at least one hash imported');
    assert.ok(stats.set >= 1, 'at least one set imported');

    const server = await createTestServer({ dbPath });
    const client = createClient({ socket: { port: server.port, host: '127.0.0.1' } });
    await client.connect();

    try {
      assert.equal(await client.get(k1), 'hello');
      const h = await client.hGetAll(k2);
      assert.equal(h?.a, '1');
      assert.equal(h?.b, '2');
      const members = await client.sMembers(k3);
      assert.ok(members.includes('x'));
      assert.ok(members.includes('y'));
      assert.ok(members.includes('z'));
      assert.equal(await client.get(k4), 'expires');
      const ttl = await client.ttl(k4);
      assert.ok(ttl > 0 && ttl <= 60, 'TTL preserved in ms range');
    } finally {
      await client.quit();
      await server.closeAsync();
    }
  });
});
