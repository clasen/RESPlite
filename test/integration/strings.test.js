import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';

describe('Strings integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('SET and GET', async () => {
    await sendCommand(port, argv('SET', 'foo', 'bar'));
    const getReply = await sendCommand(port, argv('GET', 'foo'));
    assert.equal(getReply.toString('utf8'), '$3\r\nbar\r\n');
  });

  it('GET missing returns null bulk', async () => {
    const reply = await sendCommand(port, argv('GET', 'missing'));
    assert.equal(reply.toString('ascii'), '$-1\r\n');
  });

  it('DEL returns count', async () => {
    await sendCommand(port, argv('SET', 'd1', 'x'));
    const reply = await sendCommand(port, argv('DEL', 'd1'));
    assert.equal(reply.toString('ascii'), ':1\r\n');
  });

  it('UNLINK returns count like DEL', async () => {
    await sendCommand(port, argv('SET', 'u1', 'a'));
    await sendCommand(port, argv('SET', 'u2', 'b'));
    const one = await sendCommand(port, argv('UNLINK', 'u1'));
    assert.equal(one.toString('ascii'), ':1\r\n');
    const two = await sendCommand(port, argv('UNLINK', 'u2', 'u3'));
    assert.equal(two.toString('ascii'), ':1\r\n');
    const zero = await sendCommand(port, argv('UNLINK', 'u1'));
    assert.equal(zero.toString('ascii'), ':0\r\n');
  });

  it('EXISTS returns count', async () => {
    await sendCommand(port, argv('SET', 'ex1', 'a'));
    const r = await sendCommand(port, argv('EXISTS', 'ex1', 'ex2'));
    assert.equal(r.toString('ascii'), ':1\r\n');
  });
});
