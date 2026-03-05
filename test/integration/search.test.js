import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('Search integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('FT.CREATE creates index and rejects duplicate', async () => {
    const ok = await sendCommand(port, argv('FT.CREATE', 'names', 'SCHEMA', 'payload', 'TEXT'));
    assert.equal(tryParseValue(ok, 0).value, 'OK');
    const err = await sendCommand(port, argv('FT.CREATE', 'names', 'SCHEMA', 'payload', 'TEXT'));
    const errStr = tryParseValue(err, 0).value?.error ?? tryParseValue(err, 0).value;
    assert.ok(String(errStr).includes('index already exists'));
  });

  it('FT.INFO returns index metadata', async () => {
    const reply = await sendCommand(port, argv('FT.INFO', 'names'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    const idx = arr.findIndex((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x) === 'index_name');
    assert.ok(idx >= 0);
    assert.equal(arr[idx + 1].toString?.('utf8') ?? arr[idx + 1], 'names');
  });

  it('FT.ADD inserts doc and returns OK', async () => {
    const ok = await sendCommand(port, argv('FT.ADD', 'names', 'DY1O2', '1', 'REPLACE', 'FIELDS', 'payload', 'martin clasen'));
    assert.equal(tryParseValue(ok, 0).value, 'OK');
  });

  it('FT.SEARCH returns NOCONTENT shape and total', async () => {
    const reply = await sendCommand(port, argv('FT.SEARCH', 'names', 'clasen', 'NOCONTENT', 'LIMIT', '0', '25'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    assert.equal(typeof arr[0], 'number');
    assert.ok(arr[0] >= 1);
    assert.equal(arr[1].toString?.('utf8') ?? arr[1], 'DY1O2');
  });

  it('FT.SEARCH prefix query works', async () => {
    const reply = await sendCommand(port, argv('FT.SEARCH', 'names', 'clasen*', 'NOCONTENT'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    assert.ok(arr[0] >= 0);
  });

  it('FT.SEARCH LIMIT applies', async () => {
    const reply = await sendCommand(port, argv('FT.SEARCH', 'names', 'martin', 'NOCONTENT', 'LIMIT', '0', '1'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length <= 2 + 1);
  });

  it('FT.DEL returns 1 when found, 0 when not', async () => {
    const one = await sendCommand(port, argv('FT.DEL', 'names', 'DY1O2'));
    assert.equal(tryParseValue(one, 0).value, 1);
    const zero = await sendCommand(port, argv('FT.DEL', 'names', 'nonexistent'));
    assert.equal(tryParseValue(zero, 0).value, 0);
  });

  it('FT.ADD unknown field returns error', async () => {
    const reply = await sendCommand(port, argv('FT.ADD', 'names', 'doc1', '1', 'REPLACE', 'FIELDS', 'payload', 'x', 'unknown', 'y'));
    const v = tryParseValue(reply, 0).value;
    const err = v?.error ?? v;
    assert.ok(String(err).includes('unknown field'));
  });

  it('FT.SUGADD returns 1 on insert, 0 on update', async () => {
    const one = await sendCommand(port, argv('FT.SUGADD', 'names', 'sugterm', '10'));
    assert.equal(tryParseValue(one, 0).value, 1);
    const zero = await sendCommand(port, argv('FT.SUGADD', 'names', 'sugterm', '5'));
    assert.equal(tryParseValue(zero, 0).value, 0);
  });

  it('FT.SUGGET returns terms by prefix', async () => {
    const reply = await sendCommand(port, argv('FT.SUGGET', 'names', 'sug'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length >= 1);
    assert.equal(arr[0].toString?.('utf8') ?? arr[0], 'sugterm');
  });

  it('FT.SUGGET WITHSCORES and WITHPAYLOADS', async () => {
    await sendCommand(port, argv('FT.SUGADD', 'names', 'scored', '42', 'PAYLOAD', 'mypayload'));
    const reply = await sendCommand(port, argv('FT.SUGGET', 'names', 'score', 'WITHSCORES', 'WITHPAYLOADS'));
    const arr = tryParseValue(reply, 0).value;
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length >= 3);
  });

  it('FT.SUGGET FUZZY returns not supported yet', async () => {
    const reply = await sendCommand(port, argv('FT.SUGGET', 'names', 'sug', 'FUZZY'));
    const v = tryParseValue(reply, 0).value;
    const err = v?.error ?? v;
    assert.ok(String(err).includes('not supported'));
  });

  it('FT.SUGDEL returns 1 when deleted, 0 when not', async () => {
    const one = await sendCommand(port, argv('FT.SUGDEL', 'names', 'sugterm'));
    assert.equal(tryParseValue(one, 0).value, 1);
    const zero = await sendCommand(port, argv('FT.SUGDEL', 'names', 'sugterm'));
    assert.equal(tryParseValue(zero, 0).value, 0);
  });

  it('unknown index returns error', async () => {
    const reply = await sendCommand(port, argv('FT.INFO', 'nonexistent'));
    const v = tryParseValue(reply, 0).value;
    const err = v?.error ?? v;
    assert.ok(String(err).includes('Unknown index name'));
  });
});

describe('Search persistence', () => {
  it('search index and docs survive server restart', async () => {
    const s1 = await createTestServer();
    const dbPath = s1.dbPath;
    await sendCommand(s1.port, argv('FT.CREATE', 'persist_idx', 'SCHEMA', 'payload', 'TEXT'));
    await sendCommand(s1.port, argv('FT.ADD', 'persist_idx', 'P1', '1', 'REPLACE', 'FIELDS', 'payload', 'persisted text'));
    await s1.closeAsync();
    s1.db.close();
    const s2 = await createTestServer({ dbPath });
    const info = await sendCommand(s2.port, argv('FT.INFO', 'persist_idx'));
    const arr = tryParseValue(info, 0).value;
    assert.ok(Array.isArray(arr));
    const searchReply = await sendCommand(s2.port, argv('FT.SEARCH', 'persist_idx', 'persisted', 'NOCONTENT'));
    const searchArr = tryParseValue(searchReply, 0).value;
    assert.equal(searchArr[0], 1);
    assert.equal(searchArr[1].toString?.('utf8') ?? searchArr[1], 'P1');
    await s2.closeAsync();
  });
});
