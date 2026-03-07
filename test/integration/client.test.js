import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTestServer } from '../helpers/server.js';
import { sendCommand, argv } from '../helpers/client.js';
import { encode } from '../../src/resp/encoder.js';
import { tryParseValue } from '../../src/resp/parser.js';

function sendTwoCommands(port, argv1, argv2) {
  return new Promise((resolve, reject) => {
    let recv = Buffer.alloc(0);
    const results = [];
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write(encode(argv1));
      socket.write(encode(argv2));
    });
    const t = setTimeout(() => {
      socket.destroy();
      reject(new Error('sendTwoCommands timeout'));
    }, 3000);
    socket.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      while (results.length < 2) {
        const parsed = tryParseValue(recv, 0);
        if (parsed === null) break;
        results.push(parsed.value);
        recv = recv.subarray(parsed.end);
      }
      if (results.length === 2) {
        clearTimeout(t);
        socket.destroy();
        resolve(results);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

describe('CLIENT integration', () => {
  let s;
  let port;

  before(async () => {
    s = await createTestServer();
    port = s.port;
  });

  after(async () => {
    await s.closeAsync();
  });

  it('CLIENT ID returns connection id', async () => {
    const reply = await sendCommand(port, argv('CLIENT', 'ID'));
    const v = tryParseValue(reply, 0).value;
    assert.strictEqual(typeof v, 'number');
    assert.ok(Number.isInteger(v) && v >= 1);
  });

  it('CLIENT GETNAME returns null when no name set', async () => {
    const reply = await sendCommand(port, argv('CLIENT', 'GETNAME'));
    const v = tryParseValue(reply, 0).value;
    assert.strictEqual(v, null);
  });

  it('CLIENT SETNAME then GETNAME roundtrip', async () => {
    const [setResult, getResult] = await sendTwoCommands(
      port,
      argv('CLIENT', 'SETNAME', 'my-conn'),
      argv('CLIENT', 'GETNAME')
    );
    assert.equal(setResult, 'OK');
    assert.ok(Buffer.isBuffer(getResult));
    assert.equal(getResult.toString('utf8'), 'my-conn');
  });

  it('CLIENT SETNAME with empty name is allowed', async () => {
    const [setResult, getResult] = await sendTwoCommands(
      port,
      argv('CLIENT', 'SETNAME', ''),
      argv('CLIENT', 'GETNAME')
    );
    assert.equal(setResult, 'OK');
    assert.ok(Buffer.isBuffer(getResult));
    assert.equal(getResult.length, 0);
  });

  it('CLIENT SETINFO LIB-VER / LIB-NAME returns OK (no-op)', async () => {
    const reply = await sendCommand(port, argv('CLIENT', 'SETINFO', 'LIB-VER', '1.5.17'));
    assert.equal(tryParseValue(reply, 0).value, 'OK');
    const reply2 = await sendCommand(port, argv('CLIENT', 'SETINFO', 'LIB-NAME', 'myclient'));
    assert.equal(tryParseValue(reply2, 0).value, 'OK');
  });

  it('CLIENT wrong subcommand returns error', async () => {
    const reply = await sendCommand(port, argv('CLIENT', 'LIST'));
    const v = tryParseValue(reply, 0).value;
    assert.ok(v && v.error);
    assert.match(v.error, /unknown subcommand|CLIENT HELP/);
  });

  it('CLIENT without subcommand returns error', async () => {
    const reply = await sendCommand(port, argv('CLIENT'));
    const v = tryParseValue(reply, 0).value;
    assert.ok(v && v.error);
    assert.match(v.error, /wrong number of arguments/);
  });
});
