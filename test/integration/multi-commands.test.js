import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

function parseReply(reply) {
  return tryParseValue(reply, 0).value;
}

function asStrings(values) {
  return values.map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : value);
}

describe('multi-value commands', () => {
  let server;
  let port;

  before(async () => {
    server = await createTestServer();
    port = server.port;
  });

  after(async () => {
    await server.closeAsync();
  });

  it('ZMSCORE returns scores and nil values in member order', async () => {
    await sendCommand(port, argv('ZADD', 'multi:zscore', '1', 'a', '2.5', 'b'));

    const reply = parseReply(await sendCommand(
      port,
      argv('ZMSCORE', 'multi:zscore', 'a', 'missing', 'b')
    ));

    assert.deepEqual(asStrings(reply), ['1', null, '2.5']);
    assert.deepEqual(
      parseReply(await sendCommand(port, argv('ZMSCORE', 'multi:zscore:missing', 'a', 'b'))),
      [null, null]
    );
  });

  it('ZMSCORE preserves binary members and rejects wrong types', async () => {
    const binaryMember = Buffer.from([0x00, 0xff]);
    await sendCommand(port, [Buffer.from('ZADD'), Buffer.from('multi:zscore:binary'), Buffer.from('3'), binaryMember]);

    const binaryReply = parseReply(await sendCommand(
      port,
      [Buffer.from('ZMSCORE'), Buffer.from('multi:zscore:binary'), binaryMember, Buffer.from('missing')]
    ));
    assert.deepEqual(asStrings(binaryReply), ['3', null]);

    await sendCommand(port, argv('SET', 'multi:zscore:string', 'value'));
    const wrongType = parseReply(await sendCommand(
      port,
      argv('ZMSCORE', 'multi:zscore:string', 'a', 'b')
    ));
    assert.match(wrongType.error, /^WRONGTYPE /);
  });

  it('SMISMEMBER returns one integer per requested member', async () => {
    await sendCommand(port, argv('SADD', 'multi:set', 'a', 'b'));

    assert.deepEqual(
      parseReply(await sendCommand(port, argv('SMISMEMBER', 'multi:set', 'a', 'missing', 'b'))),
      [1, 0, 1]
    );
    assert.deepEqual(
      parseReply(await sendCommand(port, argv('SMISMEMBER', 'multi:set:missing', 'a', 'b'))),
      [0, 0]
    );

    await sendCommand(port, argv('SET', 'multi:set:string', 'value'));
    const wrongType = parseReply(await sendCommand(
      port,
      argv('SMISMEMBER', 'multi:set:string', 'a', 'b')
    ));
    assert.match(wrongType.error, /^WRONGTYPE /);
  });

  it('MSETNX writes all pairs only when every key is absent', async () => {
    assert.equal(
      parseReply(await sendCommand(port, argv('MSETNX', 'multi:new:1', 'v1', 'multi:new:2', 'v2'))),
      1
    );
    assert.deepEqual(
      asStrings(parseReply(await sendCommand(port, argv('MGET', 'multi:new:1', 'multi:new:2')))),
      ['v1', 'v2']
    );

    await sendCommand(port, argv('SET', 'multi:exists', 'original'));
    assert.equal(
      parseReply(await sendCommand(port, argv('MSETNX', 'multi:untouched', 'new', 'multi:exists', 'changed'))),
      0
    );
    assert.deepEqual(
      asStrings(parseReply(await sendCommand(port, argv('MGET', 'multi:untouched', 'multi:exists')))),
      [null, 'original']
    );
  });

  it('LMPOP selects the first non-empty list and pops from either side', async () => {
    await sendCommand(port, argv('RPUSH', 'multi:list:left', 'a', 'b', 'c'));
    const left = parseReply(await sendCommand(
      port,
      argv('LMPOP', '2', 'multi:list:missing', 'multi:list:left', 'LEFT', 'COUNT', '2')
    ));
    assert.equal(left[0].toString('utf8'), 'multi:list:left');
    assert.deepEqual(asStrings(left[1]), ['a', 'b']);

    await sendCommand(port, argv('RPUSH', 'multi:list:right', 'a', 'b', 'c'));
    const right = parseReply(await sendCommand(
      port,
      argv('LMPOP', '1', 'multi:list:right', 'RIGHT', 'COUNT', '2')
    ));
    assert.equal(right[0].toString('utf8'), 'multi:list:right');
    assert.deepEqual(asStrings(right[1]), ['c', 'b']);

    assert.equal(
      parseReply(await sendCommand(port, argv('LMPOP', '2', 'multi:list:none:1', 'multi:list:none:2', 'LEFT'))),
      null
    );
  });

  it('ZMPOP selects the first non-empty zset and returns member-score pairs', async () => {
    await sendCommand(port, argv('ZADD', 'multi:zpop:min', '1', 'a', '2', 'b', '3', 'c'));
    const min = parseReply(await sendCommand(
      port,
      argv('ZMPOP', '2', 'multi:zpop:missing', 'multi:zpop:min', 'MIN', 'COUNT', '2')
    ));
    assert.equal(min[0].toString('utf8'), 'multi:zpop:min');
    assert.deepEqual(min[1].map(asStrings), [['a', '1'], ['b', '2']]);

    await sendCommand(port, argv('ZADD', 'multi:zpop:max', '1', 'a', '2', 'b', '3', 'c'));
    const max = parseReply(await sendCommand(
      port,
      argv('ZMPOP', '1', 'multi:zpop:max', 'MAX', 'COUNT', '2')
    ));
    assert.equal(max[0].toString('utf8'), 'multi:zpop:max');
    assert.deepEqual(max[1].map(asStrings), [['c', '3'], ['b', '2']]);

    assert.equal(
      parseReply(await sendCommand(port, argv('ZMPOP', '1', 'multi:zpop:none', 'MIN'))),
      null
    );
  });

  it('multi-pop commands validate numkeys, direction, count and encountered types', async () => {
    for (const command of ['LMPOP', 'ZMPOP']) {
      const kind = command === 'LMPOP' ? 'LEFT' : 'MIN';
      const invalidNumkeys = parseReply(await sendCommand(port, argv(command, '0', 'key', kind)));
      assert.equal(invalidNumkeys.error, 'ERR numkeys should be greater than 0');

      const invalidDirection = parseReply(await sendCommand(port, argv(command, '1', 'key', 'SIDE')));
      assert.equal(invalidDirection.error, 'ERR syntax error');

      const invalidCount = parseReply(await sendCommand(port, argv(command, '1', 'key', kind, 'COUNT', '0')));
      assert.equal(invalidCount.error, 'ERR count should be greater than 0');
    }

    await sendCommand(port, argv('SET', 'multi:wrongtype', 'value'));
    const listWrongType = parseReply(await sendCommand(
      port,
      argv('LMPOP', '2', 'multi:list:absent', 'multi:wrongtype', 'LEFT')
    ));
    assert.match(listWrongType.error, /^WRONGTYPE /);

    const zsetWrongType = parseReply(await sendCommand(
      port,
      argv('ZMPOP', '2', 'multi:zpop:absent', 'multi:wrongtype', 'MIN')
    ));
    assert.match(zsetWrongType.error, /^WRONGTYPE /);
  });

  it('multi-value commands reject incomplete argument lists', async () => {
    for (const command of ['ZMSCORE', 'SMISMEMBER']) {
      const reply = parseReply(await sendCommand(port, argv(command, 'key')));
      assert.match(reply.error, /wrong number of arguments/);
    }

    const msetnx = parseReply(await sendCommand(port, argv('MSETNX', 'key', 'value', 'orphan')));
    assert.match(msetnx.error, /wrong number of arguments/);

    for (const command of ['LMPOP', 'ZMPOP']) {
      const reply = parseReply(await sendCommand(port, argv(command, '1', 'key')));
      assert.match(reply.error, /wrong number of arguments/);
    }
  });
});
