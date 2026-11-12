import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { encode } from '../../src/resp/encoder.ts';
import { tryParseValue } from '../../src/resp/parser.ts';

/** Send all commands in a single write and collect `expected` replies. */
function sendPipeline(port, commands, expected = commands.length) {
  const payload = Buffer.concat(commands.map((args) => encode(argv(...args))));
  return new Promise((resolve, reject) => {
    let recv = Buffer.alloc(0);
    const replies = [];
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => socket.write(payload));
    socket.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      let parsed;
      while ((parsed = tryParseValue(recv, 0)) !== null) {
        replies.push(parsed.value);
        recv = recv.subarray(parsed.end);
      }
      if (replies.length >= expected) {
        socket.destroy();
        resolve(replies);
      }
    });
    socket.on('error', reject);
  });
}

const text = (value) => (Buffer.isBuffer(value) ? value.toString() : value);

describe('Pipelined command batches', () => {
  let s;

  before(async () => {
    s = await createTestServer();
  });

  after(async () => {
    await s.closeAsync();
  });

  it('replies in order and persists writes visible to other connections', async () => {
    const replies = await sendPipeline(s.port, [
      ['SET', 'batch:a', '1'],
      ['INCR', 'batch:n'],
      ['GET', 'batch:a'],
      ['RPUSH', 'batch:l', 'x', 'y'],
      ['INCR', 'batch:n'],
    ]);
    assert.deepEqual(replies.map(text), ['OK', 1, '1', 2, 2]);
    assert.equal((await sendCommand(s.port, argv('GET', 'batch:n'))).toString(), '$1\r\n2\r\n');
    assert.equal((await sendCommand(s.port, argv('LLEN', 'batch:l'))).toString(), ':2\r\n');
  });

  it('keeps per-command error semantics inside a batch', async () => {
    const replies = await sendPipeline(s.port, [
      ['SET', 'batch:s', 'text'],
      ['INCR', 'batch:s'],
      ['LPUSH', 'batch:s', 'v'],
      ['SET', 'batch:t', 'kept'],
    ]);
    assert.equal(replies[0], 'OK');
    assert.match(replies[1].error, /^ERR value is not an integer/);
    assert.match(replies[2].error, /^WRONGTYPE/);
    assert.equal(replies[3], 'OK');
    assert.equal((await sendCommand(s.port, argv('GET', 'batch:s'))).toString(), '$4\r\ntext\r\n');
    assert.equal((await sendCommand(s.port, argv('GET', 'batch:t'))).toString(), '$4\r\nkept\r\n');
  });

  it('keeps reply order when a pipeline enters Pub/Sub mode', async () => {
    const replies = await sendPipeline(s.port, [
      ['SET', 'batch:p', 'v'],
      ['SUBSCRIBE', 'batch:ch'],
    ]);
    assert.equal(replies[0], 'OK');
    assert.deepEqual(replies[1].map(text), ['subscribe', 'batch:ch', 1]);
  });
});
