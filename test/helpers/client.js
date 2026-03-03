/**
 * TCP client that sends RESP and reads responses.
 */

import net from 'node:net';
import { encode } from '../../src/resp/encoder.js';
import { tryParseValue } from '../../src/resp/parser.js';

/**
 * Send a RESP array command and return the raw response buffer (one complete RESP message).
 * @param {number} port
 * @param {Buffer[]} argv - command name + args as Buffers
 * @returns {Promise<Buffer>}
 */
export function sendCommand(port, argv) {
  const cmd = encode(argv);
  return new Promise((resolve, reject) => {
    let recv = Buffer.alloc(0);
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write(cmd);
    });
    socket.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      const result = tryParseValue(recv, 0);
      if (result !== null) {
        socket.destroy();
        resolve(recv.subarray(0, result.end));
      }
    });
    socket.on('end', () => resolve(Buffer.alloc(0)));
    socket.on('error', reject);
  });
}

/**
 * Build argv from command name and string args (converted to Buffers).
 */
export function argv(name, ...args) {
  return [Buffer.from(name, 'utf8'), ...args.map((a) => Buffer.from(String(a), 'utf8'))];
}
