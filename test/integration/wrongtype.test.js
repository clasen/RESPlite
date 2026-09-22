import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('WRONGTYPE integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('GET on hash key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('HSET', 'h', 'f', 'v'));
    const reply = await sendCommand(port, argv('GET', 'h'));
    const msg = reply.toString('utf8');
    assert.ok(msg.includes('WRONGTYPE'));
    assert.ok(msg.includes('wrong kind of value'));
  });

  it('HSET on string key returns WRONGTYPE', async () => {
    await sendCommand(port, argv('SET', 's', 'x'));
    const reply = await sendCommand(port, argv('HSET', 's', 'f', 'v'));
    const msg = reply.toString('utf8');
    assert.ok(msg.includes('WRONGTYPE'));
  });

  it('SET and SETEX replace a key of another type', async () => {
    await sendCommand(port, argv('HSET', 'wt:hash', 'field', 'value'));
    assert.equal((await sendCommand(port, argv('SET', 'wt:hash', 'string'))).toString('utf8'), '+OK\r\n');
    assert.equal((await sendCommand(port, argv('TYPE', 'wt:hash'))).toString('utf8'), '+string\r\n');
    assert.ok((await sendCommand(port, argv('HGET', 'wt:hash', 'field'))).toString('utf8').startsWith('-WRONGTYPE'));

    await sendCommand(port, argv('RPUSH', 'wt:list', 'a'));
    assert.equal((await sendCommand(port, argv('SETEX', 'wt:list', '100', 'string'))).toString('utf8'), '+OK\r\n');
    assert.equal((await sendCommand(port, argv('TYPE', 'wt:list'))).toString('utf8'), '+string\r\n');
    const pttl = parseInt((await sendCommand(port, argv('PTTL', 'wt:list'))).toString('ascii').slice(1), 10);
    assert.ok(pttl > 90000 && pttl <= 100000, `PTTL ${pttl}`);
  });

  it('MSET replaces keys of any type and MSETNX still aborts on an existing key', async () => {
    await sendCommand(port, argv('HSET', 'wt:mset', 'field', 'value'));
    assert.equal(
      (await sendCommand(port, argv('MSET', 'wt:mset', 'string', 'wt:mset:new', 'value'))).toString('utf8'),
      '+OK\r\n'
    );
    assert.equal((await sendCommand(port, argv('TYPE', 'wt:mset'))).toString('utf8'), '+string\r\n');
    assert.equal((await sendCommand(port, argv('GET', 'wt:mset:new'))).toString('utf8'), '$5\r\nvalue\r\n');

    await sendCommand(port, argv('HSET', 'wt:msetnx', 'field', 'value'));
    assert.equal((await sendCommand(port, argv('MSETNX', 'wt:msetnx', 'string'))).toString('ascii'), ':0\r\n');
    assert.equal((await sendCommand(port, argv('TYPE', 'wt:msetnx'))).toString('utf8'), '+hash\r\n');
  });

  it('keeps WRONGTYPE for reads and numeric mutations on other types', async () => {
    await sendCommand(port, argv('HSET', 'wt:strict', 'field', 'value'));
    assert.ok((await sendCommand(port, argv('GET', 'wt:strict'))).toString('utf8').startsWith('-WRONGTYPE'));
    assert.ok((await sendCommand(port, argv('INCR', 'wt:strict'))).toString('utf8').startsWith('-WRONGTYPE'));
    assert.equal((await sendCommand(port, argv('SET', 'wt:strict', 'string', 'NX'))).toString('ascii'), '$-1\r\n');
    assert.equal((await sendCommand(port, argv('TYPE', 'wt:strict'))).toString('utf8'), '+hash\r\n');
  });

  it('SET KEEPTTL keeps the replaced key TTL and other forms clear it', async () => {
    await sendCommand(port, argv('HSET', 'wt:keep', 'field', 'value'));
    await sendCommand(port, argv('PEXPIRE', 'wt:keep', '100000'));
    assert.equal(
      (await sendCommand(port, argv('SET', 'wt:keep', 'string', 'KEEPTTL'))).toString('utf8'),
      '+OK\r\n'
    );
    const kept = parseInt((await sendCommand(port, argv('PTTL', 'wt:keep'))).toString('ascii').slice(1), 10);
    assert.ok(kept > 90000 && kept <= 100000, `PTTL ${kept}`);

    await sendCommand(port, argv('HSET', 'wt:clear', 'field', 'value'));
    await sendCommand(port, argv('PEXPIRE', 'wt:clear', '100000'));
    await sendCommand(port, argv('SET', 'wt:clear', 'string'));
    assert.equal((await sendCommand(port, argv('TTL', 'wt:clear'))).toString('ascii'), ':-1\r\n');
  });
});
