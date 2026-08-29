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
    const first = await sendCommand(port, argv('HSET', 'user:1', 'name', 'Martin', 'age', '42'));
    assert.equal(tryParseValue(first, 0).value, 2);
    const second = await sendCommand(port, argv('HSET', 'user:1', 'name', 'Martín', 'city', 'Buenos Aires'));
    assert.equal(tryParseValue(second, 0).value, 1);
    const nameReply = await sendCommand(port, argv('HGET', 'user:1', 'name'));
    assert.equal(nameReply.toString('utf8'), '$7\r\nMartín\r\n');
  });

  it('HSETNX and HMSET', async () => {
    assert.equal(tryParseValue(await sendCommand(port, argv('HSETNX', 'nx', 'field', 'first')), 0).value, 1);
    assert.equal(tryParseValue(await sendCommand(port, argv('HSETNX', 'nx', 'field', 'second')), 0).value, 0);
    assert.equal((await sendCommand(port, argv('HGET', 'nx', 'field'))).toString('utf8'), '$5\r\nfirst\r\n');
    assert.equal((await sendCommand(port, argv('HMSET', 'legacy', 'a', '1', 'b', '2'))).toString('utf8'), '+OK\r\n');
  });

  it('HINCRBYFLOAT and HSTRLEN', async () => {
    await sendCommand(port, argv('HSET', 'numbers', 'amount', '10.5', 'binary', Buffer.from([0, 1, 2])));
    const incremented = await sendCommand(port, argv('HINCRBYFLOAT', 'numbers', 'amount', '0.25'));
    assert.equal(tryParseValue(incremented, 0).value.toString('utf8'), '10.75');
    assert.equal(tryParseValue(await sendCommand(port, argv('HSTRLEN', 'numbers', 'binary')), 0).value, 3);
    assert.equal(tryParseValue(await sendCommand(port, argv('HSTRLEN', 'numbers', 'missing')), 0).value, 0);
  });

  it('HSCAN supports MATCH, COUNT and NOVALUES', async () => {
    await sendCommand(port, argv('HSET', 'scan-hash', 'user:3', 'c', 'other', 'x', 'user:1', 'a', 'user:2', 'b'));
    const first = tryParseValue(
      await sendCommand(port, argv('HSCAN', 'scan-hash', '0', 'MATCH', 'user:*', 'COUNT', '2')),
      0
    ).value;
    assert.equal(first[0].toString('utf8'), '2');
    assert.deepEqual(first[1].map((value) => value.toString('utf8')), ['user:1', 'a']);
    const second = tryParseValue(
      await sendCommand(port, argv('HSCAN', 'scan-hash', '2', 'MATCH', 'user:*', 'COUNT', '2', 'NOVALUES')),
      0
    ).value;
    assert.equal(second[0].toString('utf8'), '4');
    assert.deepEqual(second[1].map((value) => value.toString('utf8')), ['user:2', 'user:3']);
    const done = tryParseValue(await sendCommand(port, argv('HSCAN', 'scan-hash', '4', 'COUNT', '2')), 0).value;
    assert.equal(done[0].toString('utf8'), '0');
    assert.deepEqual(done[1], []);
  });

  it('HRANDFIELD supports count and WITHVALUES', async () => {
    await sendCommand(port, argv('HSET', 'random-hash', 'a', '1', 'b', '2'));
    const single = tryParseValue(await sendCommand(port, argv('HRANDFIELD', 'random-hash')), 0).value;
    assert.ok(['a', 'b'].includes(single.toString('utf8')));
    const fields = tryParseValue(await sendCommand(port, argv('HRANDFIELD', 'random-hash', '5')), 0).value;
    assert.equal(fields.length, 2);
    const pairs = tryParseValue(
      await sendCommand(port, argv('HRANDFIELD', 'random-hash', '2', 'WITHVALUES')),
      0
    ).value;
    assert.equal(pairs.length, 4);
  });

  it('validates new hash command arguments and wrong types', async () => {
    await sendCommand(port, argv('SET', 'hash-wrongtype', 'value'));
    for (const command of [
      argv('HSETNX', 'hash-wrongtype', 'field', 'value'),
      argv('HINCRBYFLOAT', 'hash-wrongtype', 'field', '1.5'),
      argv('HSTRLEN', 'hash-wrongtype', 'field'),
      argv('HSCAN', 'hash-wrongtype', '0'),
      argv('HRANDFIELD', 'hash-wrongtype'),
      argv('HPTTL', 'hash-wrongtype', 'FIELDS', '1', 'field'),
    ]) {
      assert.ok((await sendCommand(port, command)).toString('utf8').includes('WRONGTYPE'));
    }

    assert.ok((await sendCommand(port, argv('HINCRBYFLOAT', 'h', 'field', 'NaN'))).toString('utf8').startsWith('-ERR'));
    assert.ok((await sendCommand(port, argv('HSCAN', 'h', '-1'))).toString('utf8').startsWith('-ERR'));
    assert.ok((await sendCommand(port, argv('HSCAN', 'h', '0', 'COUNT', '0'))).toString('utf8').startsWith('-ERR'));
    assert.ok((await sendCommand(port, argv('HRANDFIELD', 'h', 'not-a-number'))).toString('utf8').startsWith('-ERR'));
    assert.ok((await sendCommand(port, argv('HPEXPIRE', 'h', '1.5', 'FIELDS', '1', 'field'))).toString('utf8').startsWith('-ERR'));
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

  it('supports millisecond and absolute hash field expiration variants', async () => {
    await sendCommand(port, argv('HSET', 'ttl-variants', 'field', 'value'));
    assert.equal(
      Number(tryParseValue(await sendCommand(port, argv('HPEXPIRE', 'ttl-variants', '5000', 'FIELDS', '1', 'field')), 0).value[0]),
      1
    );
    const pttl = Number(
      tryParseValue(await sendCommand(port, argv('HPTTL', 'ttl-variants', 'FIELDS', '1', 'field')), 0).value[0]
    );
    assert.ok(pttl > 0 && pttl <= 5000);
    const expireAtMs = Number(
      tryParseValue(await sendCommand(port, argv('HPEXPIRETIME', 'ttl-variants', 'FIELDS', '1', 'field')), 0).value[0]
    );
    assert.ok(expireAtMs > Date.now());

    const expireAtSeconds = Math.floor(Date.now() / 1000) + 30;
    assert.equal(
      Number(tryParseValue(await sendCommand(port, argv('HEXPIREAT', 'ttl-variants', String(expireAtSeconds), 'FIELDS', '1', 'field')), 0).value[0]),
      1
    );
    assert.equal(
      Number(tryParseValue(await sendCommand(port, argv('HEXPIRETIME', 'ttl-variants', 'FIELDS', '1', 'field')), 0).value[0]),
      expireAtSeconds
    );

    const absoluteMs = Date.now() + 45_000;
    assert.equal(
      Number(tryParseValue(await sendCommand(port, argv('HPEXPIREAT', 'ttl-variants', String(absoluteMs), 'FIELDS', '1', 'field')), 0).value[0]),
      1
    );
    assert.equal(
      Number(tryParseValue(await sendCommand(port, argv('HPEXPIRETIME', 'ttl-variants', 'FIELDS', '1', 'field')), 0).value[0]),
      absoluteMs
    );
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
