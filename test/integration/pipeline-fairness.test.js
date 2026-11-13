import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTestServer } from '../helpers/server.js';
import { encode } from '../../src/resp/encoder.ts';
import { tryParseValue } from '../../src/resp/parser.ts';
import { argv } from '../helpers/client.js';

/** Open a connection that collects every reply with the time it arrived. */
async function openClient(port) {
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const replies = [];
  const waiters = [];
  let recv = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    recv = Buffer.concat([recv, chunk]);
    let parsed;
    while ((parsed = tryParseValue(recv, 0)) !== null) {
      replies.push({ value: parsed.value, at: performance.now() });
      recv = recv.subarray(parsed.end);
    }
    for (const waiter of waiters.splice(0)) {
      if (replies.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  return {
    socket,
    replies,
    send(commands) {
      socket.write(Buffer.concat(commands.map((args) => encode(argv(...args)))));
    },
    waitFor(count) {
      if (replies.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

const text = (value) => (Buffer.isBuffer(value) ? value.toString() : value);

describe('Pipelined work is shared fairly between connections', () => {
  let s;

  before(async () => {
    s = await createTestServer();
    const fields = [];
    for (let i = 0; i < 4000; i++) fields.push('f' + i, 'value-' + i + '-' + 'x'.repeat(40));
    s.engine.hset('big', ...fields);
  });

  after(async () => {
    await s.closeAsync();
  });

  it('serves another client while one client has a long pipeline queued', async () => {
    // Size the pipeline to ~400 ms of server work, measured in-process.
    const reply = encode(s.engine.hgetall('big'));
    let started = performance.now();
    for (let i = 0; i < 20; i++) encode(s.engine.hgetall('big'));
    const perCommandMs = (performance.now() - started) / 20;
    const count = Math.ceil(400 / perCommandMs);
    const heavy = net.createConnection({ port: s.port, host: '127.0.0.1' });
    await new Promise((resolve) => heavy.once('connect', resolve));
    let received = 0;
    let heavyDoneAt = 0;
    const heavyDone = new Promise((resolve) => heavy.on('data', (chunk) => {
      received += chunk.length;
      if (received < count * reply.length) return;
      heavyDoneAt = performance.now();
      resolve();
    }));
    const light = await openClient(s.port);
    heavy.write(Buffer.concat(Array.from({ length: count }, () => encode(argv('HGETALL', 'big')))));
    // Client and server share this event loop: a starved loop shows up as a late timer.
    started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const timerLateMs = performance.now() - started - 20;
    light.send([['PING']]);
    await light.waitFor(1);
    await heavyDone;
    assert.equal(light.replies[0].value, 'PONG');
    assert.equal(received, count * reply.length);
    assert.ok(timerLateMs < 100, `event loop blocked ${timerLateMs.toFixed(1)} ms by ${count} pipelined commands`);
    assert.ok(light.replies[0].at < heavyDoneAt, 'PING was answered after the whole pipeline');
    heavy.destroy();
    light.socket.destroy();
  });

  it('keeps reply order and write results across slices of one pipeline', async () => {
    const client = await openClient(s.port);
    const commands = [];
    for (let i = 0; i < 60; i++) commands.push(['HGETALL', 'big'], ['INCR', 'fair:n'], ['RPUSH', 'fair:l', String(i)]);
    commands.push(['LRANGE', 'fair:l', '0', '-1']);
    client.send(commands);
    await client.waitFor(commands.length);
    for (let i = 0; i < 60; i++) {
      assert.equal(client.replies[3 * i].value.length, 8000);
      assert.equal(client.replies[3 * i + 1].value, i + 1);
      assert.equal(client.replies[3 * i + 2].value, i + 1);
    }
    assert.deepEqual(client.replies[180].value.map(text), Array.from({ length: 60 }, (_, i) => String(i)));
    client.socket.destroy();
  });

  it('runs the commands that follow a blocking command once it returns', async () => {
    const client = await openClient(s.port);
    client.send([['BLPOP', 'fair:empty', '1'], ['PING'], ['SET', 'fair:after', 'v']]);
    await client.waitFor(3);
    assert.deepEqual(client.replies.map((reply) => reply.value), [null, 'PONG', 'OK']);
    client.socket.destroy();
  });
});
