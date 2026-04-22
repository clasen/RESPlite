import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('Hashes integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('HSET and HGET', async () => {
    await sendCommand(port, argv('HSET', 'user:1', 'name', 'Martin', 'age', '42'));
    const nameReply = await sendCommand(port, argv('HGET', 'user:1', 'name'));
    assert.equal(nameReply.toString('utf8'), '$6\r\nMartin\r\n');
  });

  it('HGETALL', async () => {
    await sendCommand(port, argv('HSET', 'h', 'a', '1', 'b', '2'));
    const reply = await sendCommand(port, argv('HGETALL', 'h'));
    const s = reply.toString('ascii');
    assert.ok(s.includes('$1\r\na\r\n'));
    assert.ok(s.includes('$1\r\n1\r\n'));
    assert.ok(s.includes('$1\r\nb\r\n'));
    assert.ok(s.includes('$1\r\n2\r\n'));
  });

  it('HLEN returns field count', async () => {
    await sendCommand(port, argv('HSET', 'hlen:1', 'f1', 'v1', 'f2', 'v2', 'f3', 'v3'));
    const reply = await sendCommand(port, argv('HLEN', 'hlen:1'));
    assert.equal(tryParseValue(reply, 0).value, 3);
  });

  it('HLEN on non-existent key returns 0', async () => {
    const reply = await sendCommand(port, argv('HLEN', 'hlen:nonexistent'));
    assert.equal(tryParseValue(reply, 0).value, 0);
  });

  it('HLEN decreases after HDEL', async () => {
    await sendCommand(port, argv('HSET', 'hlen:2', 'a', '1', 'b', '2'));
    await sendCommand(port, argv('HDEL', 'hlen:2', 'a'));
    const reply = await sendCommand(port, argv('HLEN', 'hlen:2'));
    assert.equal(tryParseValue(reply, 0).value, 1);
  });

  it('HLEN on wrong type returns WRONGTYPE', async () => {
    await sendCommand(port, argv('SET', 'hlen:str', 'value'));
    const reply = await sendCommand(port, argv('HLEN', 'hlen:str'));
    assert.ok(reply.toString('utf8').includes('WRONGTYPE'));
  });

  it('RENAME keeps hash cardinality metadata', async () => {
    await sendCommand(port, argv('HSET', 'hrename:src', 'a', '1', 'b', '2', 'c', '3'));
    await sendCommand(port, argv('RENAME', 'hrename:src', 'hrename:dst'));
    const reply = await sendCommand(port, argv('HLEN', 'hrename:dst'));
    assert.equal(tryParseValue(reply, 0).value, 3);
  });

  it('HEXPIRE + HTTL + HPERSIST round-trip (node-redis style argv)', async () => {
    await sendCommand(port, argv('HSET', 'LobbyStream', '6GQZW:FBAX7', '1'));
    // Mirror the exact argv seen in the node-redis client log.
    const hexpireReply = await sendCommand(
      port,
      argv('HEXPIRE', 'LobbyStream', '90', 'FIELDS', '1', '6GQZW:FBAX7')
    );
    const hexpireVal = tryParseValue(hexpireReply, 0).value;
    assert.ok(Array.isArray(hexpireVal));
    assert.equal(hexpireVal.length, 1);
    assert.equal(Number(hexpireVal[0]), 1);

    const httlReply = await sendCommand(
      port,
      argv('HTTL', 'LobbyStream', 'FIELDS', '1', '6GQZW:FBAX7')
    );
    const httlVal = tryParseValue(httlReply, 0).value;
    assert.ok(Array.isArray(httlVal));
    assert.equal(httlVal.length, 1);
    const secs = Number(httlVal[0]);
    assert.ok(secs > 0 && secs <= 90, `expected 0 < ttl <= 90, got ${secs}`);

    const hpersistReply = await sendCommand(
      port,
      argv('HPERSIST', 'LobbyStream', 'FIELDS', '1', '6GQZW:FBAX7')
    );
    const hpersistVal = tryParseValue(hpersistReply, 0).value;
    assert.equal(Number(hpersistVal[0]), 1);

    const httlReply2 = await sendCommand(
      port,
      argv('HTTL', 'LobbyStream', 'FIELDS', '1', '6GQZW:FBAX7')
    );
    const ttl2 = Number(tryParseValue(httlReply2, 0).value[0]);
    assert.equal(ttl2, -1);
  });

  it('HEXPIRE returns -2 for missing key/field', async () => {
    const missingKey = await sendCommand(
      port,
      argv('HEXPIRE', 'hexp:nokey', '5', 'FIELDS', '1', 'f1')
    );
    assert.equal(Number(tryParseValue(missingKey, 0).value[0]), -2);

    await sendCommand(port, argv('HSET', 'hexp:k', 'f1', 'v1'));
    const missingField = await sendCommand(
      port,
      argv('HEXPIRE', 'hexp:k', '5', 'FIELDS', '1', 'nope')
    );
    assert.equal(Number(tryParseValue(missingField, 0).value[0]), -2);
  });

  it('HEXPIRE with 0 seconds deletes the field (returns 2)', async () => {
    await sendCommand(port, argv('HSET', 'hexp:zero', 'f1', 'v1', 'f2', 'v2'));
    const reply = await sendCommand(
      port,
      argv('HEXPIRE', 'hexp:zero', '0', 'FIELDS', '1', 'f1')
    );
    assert.equal(Number(tryParseValue(reply, 0).value[0]), 2);
    const getReply = await sendCommand(port, argv('HGET', 'hexp:zero', 'f1'));
    assert.ok(getReply.toString('utf8').startsWith('$-1'));
  });

  it('HEXPIRE NX condition fails on existing TTL', async () => {
    await sendCommand(port, argv('HSET', 'hexp:nx', 'f1', 'v1'));
    await sendCommand(port, argv('HEXPIRE', 'hexp:nx', '10', 'FIELDS', '1', 'f1'));
    const reply = await sendCommand(
      port,
      argv('HEXPIRE', 'hexp:nx', '20', 'NX', 'FIELDS', '1', 'f1')
    );
    assert.equal(Number(tryParseValue(reply, 0).value[0]), 0);
  });

  it('HEXPIRE FIELDS count mismatch is a syntax error', async () => {
    await sendCommand(port, argv('HSET', 'hexp:bad', 'f1', 'v1'));
    const reply = await sendCommand(
      port,
      argv('HEXPIRE', 'hexp:bad', '10', 'FIELDS', '2', 'f1')
    );
    assert.ok(reply.toString('utf8').startsWith('-'), 'expected error reply');
  });

  it('legacy hash rows with null hash_count hydrate on first HLEN', async () => {
    const s1 = await createTestServer();
    await sendCommand(s1.port, argv('HSET', 'legacy:h', 'f1', 'v1', 'f2', 'v2'));
    const dbPath = s1.dbPath;
    await s1.closeAsync();
    s1.db.close();

    const legacyDb = new Database(dbPath);
    legacyDb.prepare('UPDATE redis_keys SET hash_count = NULL WHERE key = ?').run(Buffer.from('legacy:h', 'utf8'));
    legacyDb.close();

    const s2 = await createTestServer({ dbPath });
    const first = await sendCommand(s2.port, argv('HLEN', 'legacy:h'));
    assert.equal(tryParseValue(first, 0).value, 2);
    const second = await sendCommand(s2.port, argv('HLEN', 'legacy:h'));
    assert.equal(tryParseValue(second, 0).value, 2);

    const row = s2.db.prepare('SELECT hash_count AS n FROM redis_keys WHERE key = ?').get(Buffer.from('legacy:h', 'utf8'));
    assert.equal(row.n, 2);
    await s2.closeAsync();
  });
});
