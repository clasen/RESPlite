import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { tryParseValue } from '../../src/resp/parser.js';

describe('ZSET integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('ZADD returns new member count and ZRANGE order by score then member', async () => {
    const added = await sendCommand(port, argv('ZADD', 'z1', '2', 'b', '1', 'a', '2', 'c'));
    assert.equal(tryParseValue(added, 0).value, 3);

    const rangeReply = await sendCommand(port, argv('ZRANGE', 'z1', '0', '-1'));
    const arr = tryParseValue(rangeReply, 0).value;
    assert.equal(arr.length, 3);
    assert.equal(arr[0].toString('utf8'), 'a');
    assert.equal(arr[1].toString('utf8'), 'b');
    assert.equal(arr[2].toString('utf8'), 'c');
  });

  it('ZADD on existing member updates score and does not count as new', async () => {
    await sendCommand(port, argv('ZADD', 'z2', '10', 'm1'));
    const addedFirst = tryParseValue(await sendCommand(port, argv('ZADD', 'z2', '10', 'm1')), 0).value;
    assert.equal(addedFirst, 0);

    await sendCommand(port, argv('ZADD', 'z2', '20', 'm1'));
    const scoreReply = await sendCommand(port, argv('ZSCORE', 'z2', 'm1'));
    const score = tryParseValue(scoreReply, 0).value;
    assert.equal(score.toString('utf8'), '20');
  });

  it('ZRANGE WITHSCORES returns member, score, ...', async () => {
    await sendCommand(port, argv('ZADD', 'z3', '1', 'x', '2', 'y'));
    const reply = await sendCommand(port, argv('ZRANGE', 'z3', '0', '-1', 'WITHSCORES'));
    const arr = tryParseValue(reply, 0).value;
    assert.equal(arr.length, 4);
    assert.equal(arr[0].toString('utf8'), 'x');
    assert.equal(arr[1].toString('utf8'), '1');
    assert.equal(arr[2].toString('utf8'), 'y');
    assert.equal(arr[3].toString('utf8'), '2');
  });

  it('ZREVRANGE returns order highest to lowest and supports WITHSCORES', async () => {
    await sendCommand(port, argv('ZADD', 'zrev', '1', 'a', '2', 'b', '3', 'c'));
    const rev = await sendCommand(port, argv('ZREVRANGE', 'zrev', '0', '-1'));
    const arr = tryParseValue(rev, 0).value;
    assert.equal(arr.length, 3);
    assert.equal(arr[0].toString('utf8'), 'c');
    assert.equal(arr[1].toString('utf8'), 'b');
    assert.equal(arr[2].toString('utf8'), 'a');

    const withScores = await sendCommand(port, argv('ZREVRANGE', 'zrev', '0', '30', 'WITHSCORES'));
    const withArr = tryParseValue(withScores, 0).value;
    assert.equal(withArr.length, 6);
    assert.equal(withArr[0].toString('utf8'), 'c');
    assert.equal(withArr[1].toString('utf8'), '3');
    assert.equal(withArr[2].toString('utf8'), 'b');
    assert.equal(withArr[3].toString('utf8'), '2');
  });

  it('ZREVRANK returns 0-based rank high-to-low and nil when missing', async () => {
    await sendCommand(port, argv('ZADD', 'zrevrank', '1', 'a', '2', 'b', '3', 'c'));
    const rankC = await sendCommand(port, argv('ZREVRANK', 'zrevrank', 'c'));
    assert.equal(tryParseValue(rankC, 0).value, 0);
    const rankB = await sendCommand(port, argv('ZREVRANK', 'zrevrank', 'b'));
    assert.equal(tryParseValue(rankB, 0).value, 1);
    const rankA = await sendCommand(port, argv('ZREVRANK', 'zrevrank', 'a'));
    assert.equal(tryParseValue(rankA, 0).value, 2);

    const noMember = await sendCommand(port, argv('ZREVRANK', 'zrevrank', 'x'));
    assert.ok(noMember.toString('ascii').startsWith('$-1'));
    const noKey = await sendCommand(port, argv('ZREVRANK', 'nokey', 'a'));
    assert.ok(noKey.toString('ascii').startsWith('$-1'));
  });

  it('ZRANK returns 0-based rank low-to-high and nil when missing', async () => {
    await sendCommand(port, argv('ZADD', 'zrank', '1', 'a', '2', 'b', '3', 'c'));
    const rankA = await sendCommand(port, argv('ZRANK', 'zrank', 'a'));
    assert.equal(tryParseValue(rankA, 0).value, 0);
    const rankB = await sendCommand(port, argv('ZRANK', 'zrank', 'b'));
    assert.equal(tryParseValue(rankB, 0).value, 1);
    const rankC = await sendCommand(port, argv('ZRANK', 'zrank', 'c'));
    assert.equal(tryParseValue(rankC, 0).value, 2);

    const noMember = await sendCommand(port, argv('ZRANK', 'zrank', 'x'));
    assert.ok(noMember.toString('ascii').startsWith('$-1'));
  });

  it('ZREVRANGEBYSCORE returns score range high-to-low and supports WITHSCORES and LIMIT', async () => {
    await sendCommand(port, argv('ZADD', 'zrevscore', '1', 'a', '2', 'b', '3', 'c', '4', 'd'));
    const rev = await sendCommand(port, argv('ZREVRANGEBYSCORE', 'zrevscore', '4', '2'));
    const arr = tryParseValue(rev, 0).value;
    assert.equal(arr.length, 3);
    assert.equal(arr[0].toString('utf8'), 'd');
    assert.equal(arr[1].toString('utf8'), 'c');
    assert.equal(arr[2].toString('utf8'), 'b');

    const withScores = await sendCommand(port, argv('ZREVRANGEBYSCORE', 'zrevscore', '10', '0', 'WITHSCORES'));
    const withArr = tryParseValue(withScores, 0).value;
    assert.equal(withArr.length, 8);
    assert.equal(withArr[0].toString('utf8'), 'd');
    assert.equal(withArr[1].toString('utf8'), '4');

    const limitReply = await sendCommand(port, argv('ZREVRANGEBYSCORE', 'zrevscore', '10', '0', 'LIMIT', '1', '2'));
    const limited = tryParseValue(limitReply, 0).value;
    assert.equal(limited.length, 2);
    assert.equal(limited[0].toString('utf8'), 'c');
    assert.equal(limited[1].toString('utf8'), 'b');
  });

  it('ZRANGE negative indices and start > stop', async () => {
    await sendCommand(port, argv('ZADD', 'z4', '1', 'a', '2', 'b', '3', 'c'));
    const last = await sendCommand(port, argv('ZRANGE', 'z4', '-1', '-1'));
    assert.equal(tryParseValue(last, 0).value[0].toString('utf8'), 'c');

    const negRange = await sendCommand(port, argv('ZRANGE', 'z4', '-2', '-1'));
    const r = tryParseValue(negRange, 0).value;
    assert.equal(r.length, 2);
    assert.equal(r[0].toString('utf8'), 'b');
    assert.equal(r[1].toString('utf8'), 'c');

    const empty = await sendCommand(port, argv('ZRANGE', 'z4', '2', '0'));
    assert.equal(tryParseValue(empty, 0).value.length, 0);
  });

  it('ZRANGEBYSCORE min max inclusive and LIMIT', async () => {
    await sendCommand(port, argv('ZADD', 'z5', '1', 'a', '2', 'b', '3', 'c', '4', 'd'));
    const reply = await sendCommand(port, argv('ZRANGEBYSCORE', 'z5', '2', '3'));
    const arr = tryParseValue(reply, 0).value;
    assert.equal(arr.length, 2);
    assert.equal(arr[0].toString('utf8'), 'b');
    assert.equal(arr[1].toString('utf8'), 'c');

    const limitReply = await sendCommand(port, argv('ZRANGEBYSCORE', 'z5', '1', '10', 'LIMIT', '1', '2'));
    const limited = tryParseValue(limitReply, 0).value;
    assert.equal(limited.length, 2);
    assert.equal(limited[0].toString('utf8'), 'b');
    assert.equal(limited[1].toString('utf8'), 'c');
  });

  it('ZCARD non-existent returns 0, ZSCORE non-existent returns nil', async () => {
    const cardReply = await sendCommand(port, argv('ZCARD', 'nonexistent_z'));
    assert.equal(tryParseValue(cardReply, 0).value, 0);

    const scoreReply = await sendCommand(port, argv('ZSCORE', 'z1', 'nonexistent'));
    assert.ok(scoreReply.toString('ascii').startsWith('$-1'));
  });

  it('ZREM returns count and removes key when empty', async () => {
    await sendCommand(port, argv('ZADD', 'z6', '1', 'a', '2', 'b'));
    const rem = await sendCommand(port, argv('ZREM', 'z6', 'a', 'b'));
    assert.equal(tryParseValue(rem, 0).value, 2);

    const cardReply = await sendCommand(port, argv('ZCARD', 'z6'));
    assert.equal(tryParseValue(cardReply, 0).value, 0);
  });

  it('ZADD on string key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('SET', 'skey', 'sval'));
    const reply = await sendCommand(port, argv('ZADD', 'skey', '1', 'm'));
    assert.ok(reply.toString('utf8').includes('WRONGTYPE'));
  });

  it('GET on zset key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('ZADD', 'zkey', '1', 'm'));
    const reply = await sendCommand(port, argv('GET', 'zkey'));
    assert.ok(reply.toString('utf8').includes('WRONGTYPE'));
  });

  it('TYPE zset key returns zset', async () => {
    await sendCommand(port, argv('ZADD', 'ztype', '0', 'x'));
    const reply = await sendCommand(port, argv('TYPE', 'ztype'));
    const v = tryParseValue(reply, 0).value;
    assert.equal(v.toString('utf8'), 'zset');
  });

  it('zset survives restart', async () => {
    const s1 = await createTestServer();
    await sendCommand(s1.port, argv('ZADD', 'persist_z', '1', 'one', '2', 'two'));
    const dbPath = s1.dbPath;
    await s1.closeAsync();
    s1.db.close();
    const s2 = await createTestServer({ dbPath });
    const cardReply = await sendCommand(s2.port, argv('ZCARD', 'persist_z'));
    assert.equal(tryParseValue(cardReply, 0).value, 2);
    const rangeReply = await sendCommand(s2.port, argv('ZRANGE', 'persist_z', '0', '-1'));
    const arr = tryParseValue(rangeReply, 0).value;
    assert.equal(arr[0].toString('utf8'), 'one');
    assert.equal(arr[1].toString('utf8'), 'two');
    await s2.closeAsync();
  });

  it('binary-safe zset members', async () => {
    const bin = Buffer.from([0x00, 0xff]);
    await sendCommand(port, argv('ZADD', 'zbin', '1', 'normal'));
    await sendCommand(port, [Buffer.from('ZADD'), Buffer.from('zbin'), Buffer.from('2'), bin]);
    const reply = await sendCommand(port, argv('ZRANGE', 'zbin', '0', '-1'));
    const arr = tryParseValue(reply, 0).value;
    assert.equal(arr.length, 2);
    assert.equal(arr[0].toString('utf8'), 'normal');
    assert.ok(Buffer.isBuffer(arr[1]));
    assert.equal(arr[1].length, 2);
    assert.equal(arr[1][0], 0x00);
    assert.equal(arr[1][1], 0xff);
  });
});
