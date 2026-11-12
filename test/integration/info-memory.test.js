/**
 * Integration tests for INFO and MEMORY.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createClient } from 'redis';
import { createTestServer } from '../helpers/server.js';
import { encode } from '../../src/resp/encoder.ts';

function parseInfo(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split('\r\n')) {
    if (line.startsWith('# ')) {
      current = new Map();
      sections.set(line.slice(2).toLowerCase(), current);
    } else if (line) {
      const idx = line.indexOf(':');
      current.set(line.slice(0, idx), line.slice(idx + 1));
    }
  }
  return sections;
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition not reached');
}

describe('INFO and MEMORY', () => {
  let s;
  let client;

  before(async () => {
    s = await createTestServer();
    client = createClient({ socket: { port: s.port, host: '127.0.0.1' } });
    await client.connect();
  });

  after(async () => {
    await client.quit();
    await s.closeAsync();
  });

  it('INFO returns every section in Redis text format', async () => {
    const sections = parseInfo(await client.info());
    assert.deepEqual(
      [...sections.keys()],
      ['server', 'clients', 'memory', 'persistence', 'stats', 'sqlite', 'cache', 'keyspace']
    );
    const server = sections.get('server');
    assert.equal(server.get('redis_mode'), 'standalone');
    assert.equal(server.get('tcp_port'), String(s.port));
    assert.match(server.get('resplite_version'), /^\d+\.\d+\.\d+/);
    assert.equal(sections.get('persistence').get('loading'), '0');
    assert.ok(Number(sections.get('memory').get('used_memory_rss')) > 0);
  });

  it('INFO filters sections case-insensitively and ignores unknown ones', async () => {
    const sections = parseInfo(await client.sendCommand(['INFO', 'CLIENTS', 'stats', 'nope']));
    assert.deepEqual([...sections.keys()], ['clients', 'stats']);
    assert.equal(await client.sendCommand(['INFO', 'nope']), '');
  });

  it('INFO keyspace reports live keys, expiring keys and omits db0 when empty', async () => {
    await client.flushAll();
    assert.equal(await client.info('keyspace'), '# Keyspace\r\n');
    await client.set('ks:a', '1');
    await client.set('ks:b', '2', { EX: 100 });
    await client.hSet('ks:h', 'f', 'v');
    const db0 = parseInfo(await client.info('keyspace')).get('keyspace').get('db0');
    const [, keys, expires, avgTtl] = db0.match(/^keys=(\d+),expires=(\d+),avg_ttl=(\d+)$/);
    assert.equal(keys, '3');
    assert.equal(expires, '1');
    assert.ok(Number(avgTtl) > 90_000 && Number(avgTtl) <= 100_000);
  });

  it('INFO tracks connections, commands and blocked clients', async () => {
    const before = parseInfo(await client.info());
    const raw = net.createConnection({ port: s.port, host: '127.0.0.1' });
    await new Promise((resolve) => raw.once('connect', resolve));
    try {
      raw.write(encode([Buffer.from('BLPOP'), Buffer.from('info:empty'), Buffer.from('0')]));
      await waitFor(async () => parseInfo(await client.info('clients')).get('clients').get('blocked_clients') === '1');
      const after = parseInfo(await client.info());
      assert.equal(Number(after.get('clients').get('connected_clients')), Number(before.get('clients').get('connected_clients')) + 1);
      assert.ok(Number(after.get('stats').get('total_connections_received')) > Number(before.get('stats').get('total_connections_received')));
      assert.ok(Number(after.get('stats').get('total_commands_processed')) > Number(before.get('stats').get('total_commands_processed')));
    } finally {
      raw.destroy();
    }
    await waitFor(async () => parseInfo(await client.info('clients')).get('clients').get('blocked_clients') === '0');
  });

  it('INFO reports Pub/Sub clients and channels', async () => {
    const subscriber = client.duplicate();
    await subscriber.connect();
    try {
      await subscriber.subscribe('info:chan', () => {});
      await subscriber.pSubscribe('info:*', () => {});
      const sections = parseInfo(await client.info());
      assert.equal(sections.get('clients').get('pubsub_clients'), '1');
      assert.equal(sections.get('stats').get('pubsub_channels'), '1');
      assert.equal(sections.get('stats').get('pubsub_patterns'), '1');
    } finally {
      await subscriber.quit();
    }
  });

  it('MEMORY USAGE returns stored bytes per type and nil for missing keys', async () => {
    await client.flushAll();
    await client.set('mu:s', 'hello');
    await client.hSet('mu:h', { ab: 'cde', f: 'g' });
    await client.sAdd('mu:set', ['x', 'yz']);
    await client.rPush('mu:l', ['abc', 'd']);
    await client.zAdd('mu:z', [{ score: 1, value: 'm' }]);

    assert.equal(await client.memoryUsage('mu:s'), 4 + 5);
    assert.equal(await client.memoryUsage('mu:h'), 4 + 5 + 2);
    assert.equal(await client.memoryUsage('mu:set'), 6 + 3);
    assert.equal(await client.memoryUsage('mu:l'), 4 + 4);
    assert.equal(await client.memoryUsage('mu:z'), 4 + 1 + 8);
    assert.equal(await client.memoryUsage('mu:missing'), null);
    assert.equal(await client.memoryUsage('mu:s', { SAMPLES: 5 }), 9);
  });

  it('MEMORY USAGE treats expired keys as missing', async () => {
    await client.set('mu:exp', 'v', { PX: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await client.memoryUsage('mu:exp'), null);
  });

  it('MEMORY STATS, PURGE, HELP and argument errors', async () => {
    const stats = await client.sendCommand(['MEMORY', 'STATS']);
    const fields = new Map();
    for (let i = 0; i < stats.length; i += 2) fields.set(stats[i], stats[i + 1]);
    assert.ok(fields.get('total.allocated') > 0);
    assert.ok(fields.get('peak.allocated') >= fields.get('rss'));
    assert.equal(typeof fields.get('keys.count'), 'number');

    assert.equal(await client.sendCommand(['MEMORY', 'PURGE']), 'OK');
    const help = await client.sendCommand(['MEMORY', 'HELP']);
    assert.ok(help.some((line) => line.startsWith('USAGE')));

    await assert.rejects(client.sendCommand(['MEMORY']), /wrong number of arguments/);
    await assert.rejects(client.sendCommand(['MEMORY', 'USAGE']), /wrong number of arguments/);
    await assert.rejects(client.sendCommand(['MEMORY', 'USAGE', 'k', 'FOO', '1']), /syntax error/);
    await assert.rejects(client.sendCommand(['MEMORY', 'USAGE', 'k', 'SAMPLES', 'x']), /not an integer/);
    await assert.rejects(client.sendCommand(['MEMORY', 'DOCTOR']), /unknown subcommand 'DOCTOR'/);
  });

  it('CACHE.INFO and SQLITE.INFO keep their reply shape', async () => {
    const cacheInfo = await client.sendCommand(['CACHE.INFO']);
    assert.deepEqual(cacheInfo.filter((_, i) => i % 2 === 0), ['enabled', 'entries', 'bytes', 'hits', 'misses', 'hit_ratio']);
    const sqliteInfo = await client.sendCommand(['SQLITE.INFO']);
    assert.deepEqual(
      sqliteInfo.filter((_, i) => i % 2 === 0),
      ['path', 'version', 'total_keys', 'string_keys', 'hash_keys', 'set_keys', 'list_keys', 'journal_mode']
    );
  });
});
