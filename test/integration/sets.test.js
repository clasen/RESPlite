import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('Sets integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('SADD and SMEMBERS', async () => {
    await sendCommand(port, argv('SADD', 'tags', 'a', 'b', 'c'));
    const reply = await sendCommand(port, argv('SMEMBERS', 'tags'));
    const s = reply.toString('ascii');
    assert.ok(s.includes('$1\r\na\r\n'));
    assert.ok(s.includes('$1\r\nb\r\n'));
    assert.ok(s.includes('$1\r\nc\r\n'));
  });

  it('SCARD returns member count', async () => {
    await sendCommand(port, argv('SADD', 'scard:1', 'a', 'b', 'c'));
    const reply = await sendCommand(port, argv('SCARD', 'scard:1'));
    assert.equal(tryParseValue(reply, 0).value, 3);
  });

  it('SCARD on non-existent key returns 0', async () => {
    const reply = await sendCommand(port, argv('SCARD', 'scard:none'));
    assert.equal(tryParseValue(reply, 0).value, 0);
  });

  it('SCARD decreases after SREM', async () => {
    await sendCommand(port, argv('SADD', 'scard:2', 'x', 'y'));
    await sendCommand(port, argv('SREM', 'scard:2', 'x'));
    const reply = await sendCommand(port, argv('SCARD', 'scard:2'));
    assert.equal(tryParseValue(reply, 0).value, 1);
  });

  it('RENAME keeps set cardinality metadata', async () => {
    await sendCommand(port, argv('SADD', 'srename:src', 'm1', 'm2', 'm3'));
    await sendCommand(port, argv('RENAME', 'srename:src', 'srename:dst'));
    const reply = await sendCommand(port, argv('SCARD', 'srename:dst'));
    assert.equal(tryParseValue(reply, 0).value, 3);
  });

  it('legacy set rows with null set_count hydrate on first SCARD', async () => {
    const s1 = await createTestServer();
    await sendCommand(s1.port, argv('SADD', 'legacy:s', 'a', 'b'));
    const dbPath = s1.dbPath;
    await s1.closeAsync();
    s1.db.close();

    const legacyDb = new Database(dbPath);
    legacyDb.prepare('UPDATE redis_keys SET set_count = NULL WHERE key = ?').run(Buffer.from('legacy:s', 'utf8'));
    legacyDb.close();

    const s2 = await createTestServer({ dbPath });
    const first = await sendCommand(s2.port, argv('SCARD', 'legacy:s'));
    assert.equal(tryParseValue(first, 0).value, 2);
    const second = await sendCommand(s2.port, argv('SCARD', 'legacy:s'));
    assert.equal(tryParseValue(second, 0).value, 2);

    const row = s2.db.prepare('SELECT set_count AS n FROM redis_keys WHERE key = ?').get(Buffer.from('legacy:s', 'utf8'));
    assert.equal(row.n, 2);
    await s2.closeAsync();
  });
});
