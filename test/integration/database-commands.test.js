import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

function parseReply(buffer) {
  return tryParseValue(buffer, 0).value;
}

describe('Database commands integration', () => {
  let server;
  let port;

  before(async () => {
    server = await createTestServer();
    port = server.port;
  });

  after(async () => {
    await server.closeAsync();
  });

  it('DBSIZE counts logical, non-expired keys', async () => {
    assert.equal(parseReply(await sendCommand(port, argv('DBSIZE'))), 0);

    await sendCommand(port, argv('SET', 'string', 'value'));
    await sendCommand(port, argv('HSET', 'hash', 'field', 'value'));
    await sendCommand(port, argv('SADD', 'set', 'member'));
    await sendCommand(port, argv('RPUSH', 'list', 'value'));
    await sendCommand(port, argv('ZADD', 'zset', '1', 'member'));
    assert.equal(parseReply(await sendCommand(port, argv('DBSIZE'))), 5);

    await sendCommand(port, argv('PEXPIRE', 'string', '0'));
    assert.equal(parseReply(await sendCommand(port, argv('DBSIZE'))), 4);
  });

  it('DBSIZE rejects arguments', async () => {
    const reply = parseReply(await sendCommand(port, argv('DBSIZE', 'extra')));
    assert.match(reply.error, /wrong number of arguments.*DBSIZE/i);
  });

  it('FLUSHDB removes the keyspace and FT data', async () => {
    await sendCommand(port, argv('FT.CREATE', 'flush_idx', 'SCHEMA', 'payload', 'TEXT'));
    await sendCommand(port, argv('FT.ADD', 'flush_idx', 'doc1', '1', 'FIELDS', 'payload', 'searchable'));
    await sendCommand(port, argv('FT.SUGADD', 'flush_idx', 'suggestion', '1'));
    server.db.prepare(
      `INSERT INTO migration_runs(run_id, source_uri, started_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?)`
    ).run('flush-run', 'redis://source', 1, 1, 'running');

    assert.equal(parseReply(await sendCommand(port, argv('FLUSHDB', 'SYNC'))), 'OK');
    assert.equal(parseReply(await sendCommand(port, argv('DBSIZE'))), 0);
    assert.equal(parseReply(await sendCommand(port, argv('GET', 'string'))), null);

    const info = parseReply(await sendCommand(port, argv('FT.INFO', 'flush_idx')));
    assert.match(info.error, /Unknown index name/);
    assert.equal(
      server.db.prepare('SELECT COUNT(*) AS n FROM migration_runs WHERE run_id = ?').get('flush-run').n,
      1
    );
  });

  it('FLUSHALL accepts ASYNC and has the same single-database effect', async () => {
    await sendCommand(port, argv('SET', 'all:key', 'value'));
    assert.equal(parseReply(await sendCommand(port, argv('FLUSHALL', 'ASYNC'))), 'OK');
    assert.equal(parseReply(await sendCommand(port, argv('DBSIZE'))), 0);
  });

  it('flush commands reject invalid syntax', async () => {
    for (const command of ['FLUSHDB', 'FLUSHALL']) {
      const invalidMode = parseReply(await sendCommand(port, argv(command, 'LATER')));
      assert.match(invalidMode.error, /syntax error/i);

      const tooMany = parseReply(await sendCommand(port, argv(command, 'SYNC', 'extra')));
      assert.match(tooMany.error, new RegExp(`wrong number of arguments.*${command}`, 'i'));
    }
  });

  it('COMMAND INFO exposes database commands with Redis-compatible metadata', async () => {
    const reply = parseReply(
      await sendCommand(port, argv('COMMAND', 'INFO', 'DBSIZE', 'FLUSHDB', 'FLUSHALL'))
    );
    assert.deepEqual(reply.map((doc) => doc[1]), [1, -1, -1]);
    assert.deepEqual(reply.map((doc) => doc.slice(3, 6)), [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    assert.deepEqual(reply[0][2].map((flag) => flag.toString('utf8')), ['readonly', 'fast']);
    assert.deepEqual(reply[1][2].map((flag) => flag.toString('utf8')), ['write', 'fast']);
    assert.deepEqual(reply[2][2].map((flag) => flag.toString('utf8')), ['write', 'fast']);
  });
});
