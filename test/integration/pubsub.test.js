import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { encode } from '../../src/resp/encoder.js';
import { tryParseValue } from '../../src/resp/parser.js';

function asString(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function parse(buffer) {
  return tryParseValue(buffer, 0)?.value;
}

function createStreamingClient(port) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const queue = [];
    const waiters = [];
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      resolve({
        send(command) {
          socket.write(encode(command));
        },
        nextValue(timeoutMs = 2000) {
          if (queue.length > 0) return Promise.resolve(queue.shift());
          return new Promise((resolveValue, rejectValue) => {
            const waiter = {
              resolve(value) {
                clearTimeout(timer);
                resolveValue(value);
              },
            };
            const timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              rejectValue(new Error('timeout waiting for RESP value'));
            }, timeoutMs);
            waiters.push(waiter);
          });
        },
        close() {
          if (socket.destroyed) return Promise.resolve();
          return new Promise((resolveClose) => {
            socket.once('close', resolveClose);
            socket.destroy();
          });
        },
      });
    });

    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      for (;;) {
        const parsed = tryParseValue(received, 0);
        if (parsed === null) break;
        received = received.subarray(parsed.end);
        if (waiters.length > 0) waiters.shift().resolve(parsed.value);
        else queue.push(parsed.value);
      }
    });
    socket.on('error', reject);
  });
}

describe('Pub/Sub integration', () => {
  let server;
  let port;

  before(async () => {
    server = await createTestServer();
    port = server.port;
  });

  after(async () => {
    await server.closeAsync();
  });

  it('subscribes, publishes, and acknowledges duplicate subscriptions', async () => {
    const subscriber = await createStreamingClient(port);
    try {
      subscriber.send(argv('SUBSCRIBE', 'news', 'news'));
      const firstAck = await subscriber.nextValue();
      const duplicateAck = await subscriber.nextValue();
      assert.deepEqual(firstAck.map(asString), ['subscribe', 'news', '1']);
      assert.deepEqual(duplicateAck.map(asString), ['subscribe', 'news', '1']);

      assert.equal(parse(await sendCommand(port, argv('PUBLISH', 'news', 'hello'))), 1);
      const message = await subscriber.nextValue();
      assert.deepEqual(message.map(asString), ['message', 'news', 'hello']);
      assert.equal(parse(await sendCommand(port, argv('PUBLISH', 'missing', 'hello'))), 0);
    } finally {
      await subscriber.close();
    }
  });

  it('delivers direct and pattern matches separately', async () => {
    const subscriber = await createStreamingClient(port);
    try {
      subscriber.send(argv('SUBSCRIBE', 'orders:new'));
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['subscribe', 'orders:new', '1']);
      subscriber.send(argv('PSUBSCRIBE', 'orders:*', 'orders:ne?'));
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['psubscribe', 'orders:*', '2']);
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['psubscribe', 'orders:ne?', '3']);

      assert.equal(parse(await sendCommand(port, argv('PUBLISH', 'orders:new', '42'))), 3);
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['message', 'orders:new', '42']);
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['pmessage', 'orders:*', 'orders:new', '42']);
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['pmessage', 'orders:ne?', 'orders:new', '42']);

      subscriber.send(argv('PUNSUBSCRIBE'));
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['punsubscribe', 'orders:*', '2']);
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['punsubscribe', 'orders:ne?', '1']);
      subscriber.send(argv('UNSUBSCRIBE'));
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['unsubscribe', 'orders:new', '0']);
    } finally {
      await subscriber.close();
    }
  });

  it('enforces RESP2 subscribed mode and restores normal commands after unsubscribe', async () => {
    const subscriber = await createStreamingClient(port);
    try {
      subscriber.send(argv('SUBSCRIBE', 'mode'));
      await subscriber.nextValue();

      subscriber.send(argv('GET', 'key'));
      const error = await subscriber.nextValue();
      assert.match(error.error, /only SUBSCRIBE/);

      subscriber.send(argv('PING'));
      const pong = await subscriber.nextValue();
      assert.equal(asString(pong[0]), 'pong');
      assert.ok(Buffer.isBuffer(pong[1]));
      assert.equal(pong[1].length, 0);

      subscriber.send(argv('PING', 'alive'));
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['pong', 'alive']);

      subscriber.send(argv('UNSUBSCRIBE'));
      await subscriber.nextValue();
      subscriber.send(argv('SET', 'key', 'value'));
      assert.equal(await subscriber.nextValue(), 'OK');
    } finally {
      await subscriber.close();
    }
  });

  it('reports active channels and removes disconnected subscribers', async () => {
    const directOne = await createStreamingClient(port);
    const directTwo = await createStreamingClient(port);
    const pattern = await createStreamingClient(port);
    try {
      directOne.send(argv('SUBSCRIBE', 'stats:one'));
      directTwo.send(argv('SUBSCRIBE', 'stats:one', 'stats:two'));
      pattern.send(argv('PSUBSCRIBE', 'stats:*'));
      directOne.send(argv('PSUBSCRIBE', 'stats:*'));
      await directOne.nextValue();
      await directTwo.nextValue();
      await directTwo.nextValue();
      await pattern.nextValue();
      await directOne.nextValue();

      const channels = parse(await sendCommand(port, argv('PUBSUB', 'CHANNELS', 'stats:*'))).map(asString).sort();
      assert.deepEqual(channels, ['stats:one', 'stats:two']);
      const counts = parse(await sendCommand(port, argv('PUBSUB', 'NUMSUB', 'stats:one', 'stats:two', 'stats:none')));
      assert.deepEqual(counts.map(asString), ['stats:one', '2', 'stats:two', '1', 'stats:none', '0']);
      assert.equal(parse(await sendCommand(port, argv('PUBSUB', 'NUMPAT'))), 1);

      await directOne.close();
      const afterClose = parse(await sendCommand(port, argv('PUBSUB', 'NUMSUB', 'stats:one')));
      assert.deepEqual(afterClose.map(asString), ['stats:one', '1']);
    } finally {
      await directOne.close();
      await directTwo.close();
      await pattern.close();
    }
  });

  it('preserves binary channels and messages', async () => {
    const subscriber = await createStreamingClient(port);
    const channel = Buffer.from([0x00, 0x80, 0xff]);
    const message = Buffer.from([0xff, 0x00, 0x7f]);
    try {
      subscriber.send([Buffer.from('SUBSCRIBE'), channel]);
      const ack = await subscriber.nextValue();
      assert.deepEqual(ack[1], channel);

      const reply = await sendCommand(port, [Buffer.from('PUBLISH'), channel, message]);
      assert.equal(parse(reply), 1);
      const delivered = await subscriber.nextValue();
      assert.deepEqual(delivered[1], channel);
      assert.deepEqual(delivered[2], message);
    } finally {
      await subscriber.close();
    }
  });

  it('keeps Pub/Sub isolated between server instances', async () => {
    const isolatedServer = await createTestServer();
    const subscriber = await createStreamingClient(port);
    try {
      subscriber.send(argv('SUBSCRIBE', 'isolated'));
      await subscriber.nextValue();
      assert.equal(parse(await sendCommand(isolatedServer.port, argv('PUBLISH', 'isolated', 'nope'))), 0);
      assert.equal(parse(await sendCommand(port, argv('PUBLISH', 'isolated', 'yes'))), 1);
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['message', 'isolated', 'yes']);
    } finally {
      await subscriber.close();
      await isolatedServer.closeAsync();
    }
  });

  it('honors renamed Pub/Sub commands while subscribed', async () => {
    const renamedServer = await createTestServer({
      commandPolicy: {
        rename: {
          SUBSCRIBE: 'FOLLOW',
          UNSUBSCRIBE: 'UNFOLLOW',
          PUBLISH: 'SEND',
        },
      },
    });
    const subscriber = await createStreamingClient(renamedServer.port);
    try {
      subscriber.send(argv('FOLLOW', 'aliases'));
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['subscribe', 'aliases', '1']);
      assert.equal(parse(await sendCommand(renamedServer.port, argv('SEND', 'aliases', 'hello'))), 1);
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['message', 'aliases', 'hello']);
      subscriber.send(argv('UNFOLLOW', 'aliases'));
      assert.deepEqual((await subscriber.nextValue()).map(asString), ['unsubscribe', 'aliases', '0']);
    } finally {
      await subscriber.close();
      await renamedServer.closeAsync();
    }
  });
});
