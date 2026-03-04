import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { encode } from '../../src/resp/encoder.js';
import { tryParseValue } from '../../src/resp/parser.js';

function createStreamingClient(port) {
  return new Promise((resolve, reject) => {
    let recv = Buffer.alloc(0);
    const queue = [];
    const waiters = [];
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      resolve({
        send(commandArgv) {
          socket.write(encode(commandArgv));
        },
        async nextValue(timeoutMs = 2000) {
          if (queue.length > 0) return queue.shift();
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error('timeout waiting for RESP value'));
            }, timeoutMs);
            waiters.push({
              resolve(value) {
                clearTimeout(timer);
                res(value);
              },
            });
          });
        },
        close() {
          socket.destroy();
        },
      });
    });

    socket.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      for (;;) {
        const parsed = tryParseValue(recv, 0);
        if (parsed === null) break;
        recv = recv.subarray(parsed.end);
        if (waiters.length > 0) {
          waiters.shift().resolve(parsed.value);
        } else {
          queue.push(parsed.value);
        }
      }
    });
    socket.on('error', reject);
  });
}

describe('MONITOR integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('MONITOR streams commands from other clients', async () => {
    const monitorClient = await createStreamingClient(port);
    try {
      monitorClient.send(argv('MONITOR'));
      const first = await monitorClient.nextValue();
      assert.equal(first, 'OK');

      await sendCommand(port, argv('SET', 'mk1', 'v1'));
      const event = await monitorClient.nextValue();
      assert.equal(typeof event, 'string');
      assert.match(event, /"SET"\s+"mk1"\s+"v1"/);
    } finally {
      monitorClient.close();
    }
  });

  it('MONITOR connection only accepts QUIT', async () => {
    const monitorClient = await createStreamingClient(port);
    try {
      monitorClient.send(argv('MONITOR'));
      assert.equal(await monitorClient.nextValue(), 'OK');
      monitorClient.send(argv('PING'));
      const err = await monitorClient.nextValue();
      assert.ok(err && err.error);
      assert.match(err.error, /MONITOR mode only supports QUIT/);
      monitorClient.send(argv('QUIT'));
      assert.equal(await monitorClient.nextValue(), 'OK');
    } finally {
      monitorClient.close();
    }
  });
});
