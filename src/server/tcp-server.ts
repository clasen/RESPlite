/**
 * TCP server: accept connections, delegate to connection handler.
 */

import net from 'node:net';
import { handleConnection } from './connection.ts';
import { compileCommandPolicy } from '../commands/registry.ts';
import { createPubSubBroker } from '../pubsub/broker.ts';
import { createServerStats } from './stats.ts';
import type { Server, Socket } from 'node:net';
import type { CommandPolicy, CompiledCommandPolicy } from '../commands/registry.ts';
import type { PubSubBroker } from '../pubsub/broker.ts';
import type { ScriptingPlugin } from '../scripting/plugin.ts';
import type { Engine } from '../types.ts';

export interface CreateServerOptions {
  engine: Engine;
  /** Default 6379. */
  port?: number;
  /** Default '0.0.0.0'. */
  host?: string;
  /** If provided, each accepted socket is added here (for graceful shutdown). */
  connections?: Set<Socket> | null;
  /** Optional: command rename/disable policy. */
  commandPolicy?: CommandPolicy | CompiledCommandPolicy | null;
  /** Pub/Sub broker shared by all connections. */
  pubSub?: PubSubBroker;
  /** Prepared scripting plugin owned by this server. */
  scripting?: ScriptingPlugin | null;
  scriptingOwner?: object;
}

export function createServer({ engine, port = 6379, host = '0.0.0.0', connections = null, commandPolicy = null, pubSub = createPubSubBroker(), scripting = null, scriptingOwner = {} }: CreateServerOptions): Server {
  scripting?.attach(scriptingOwner);
  let compiledCommandPolicy;
  try {
    compiledCommandPolicy = compileCommandPolicy(commandPolicy);
  } catch (error) {
    scripting?.close();
    throw error;
  }
  const stats = createServerStats();
  const server = net.createServer((socket) => {
    if (connections) {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    }
    handleConnection(socket, engine, {}, compiledCommandPolicy, { pubSub, scripting, scriptingOwner, stats });
  });
  server.once('close', () => scripting?.close());
  server.once('error', () => {
    if (!server.listening) scripting?.close();
  });
  return server;
}
