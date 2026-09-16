/**
 * TCP server: accept connections, delegate to connection handler.
 */

import net from 'node:net';
import { handleConnection } from './connection.js';
import { compileCommandPolicy } from '../commands/registry.js';
import { createPubSubBroker } from '../pubsub/broker.js';

/**
 * @param {object} options
 * @param {object} options.engine
 * @param {number} [options.port=6379]
 * @param {string} [options.host='0.0.0.0']
 * @param {Set<import('node:net').Socket>} [options.connections] If provided, each accepted socket is added here (for graceful shutdown).
 * @param {object|null} [options.commandPolicy] Optional: command rename/disable policy.
 * @param {object} [options.pubSub] Pub/Sub broker shared by all connections.
 * @param {object} [options.scripting] Prepared scripting plugin owned by this server.
 * @returns {import('node:net').Server}
 */
export function createServer({ engine, port = 6379, host = '0.0.0.0', connections = null, commandPolicy = null, pubSub = createPubSubBroker(), scripting = null, scriptingOwner = {} }) {
  scripting?.attach(scriptingOwner);
  let compiledCommandPolicy;
  try {
    compiledCommandPolicy = compileCommandPolicy(commandPolicy);
  } catch (error) {
    scripting?.close();
    throw error;
  }
  const server = net.createServer((socket) => {
    if (connections) {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    }
    handleConnection(socket, engine, {}, compiledCommandPolicy, { pubSub, scripting, scriptingOwner });
  });
  server.once('close', () => scripting?.close());
  server.once('error', () => {
    if (!server.listening) scripting?.close();
  });
  return server;
}
