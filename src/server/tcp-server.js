/**
 * TCP server: accept connections, delegate to connection handler.
 */

import net from 'node:net';
import { handleConnection } from './connection.js';

/**
 * @param {object} options
 * @param {object} options.engine
 * @param {number} [options.port=6379]
 * @param {string} [options.host='0.0.0.0']
 * @param {Set<import('node:net').Socket>} [options.connections] If provided, each accepted socket is added here (for graceful shutdown).
 * @returns {import('node:net').Server}
 */
export function createServer({ engine, port = 6379, host = '0.0.0.0', connections = null }) {
  const server = net.createServer((socket) => {
    if (connections) {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    }
    handleConnection(socket, engine);
  });
  return server;
}
