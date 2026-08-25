/**
 * Public API for embedding RESPLite in your own Node.js application.
 *
 * High-level (recommended):
 *   import { createRESPlite } from 'resplite/embed';
 *   const srv = await createRESPlite({ db: './my-app.db' });
 *
 * Low-level (manual wiring):
 *   import { handleConnection, createEngine, createPubSubBroker, openDb } from 'resplite/embed';
 *   const pubSub = createPubSubBroker(); // share across every connection of this server
 *   handleConnection(socket, engine, hooks, commandPolicy, { pubSub });
 */

import net from 'node:net';
import path from 'node:path';
import { handleConnection } from './server/connection.js';
import { createEngine } from './engine/engine.js';
import { createCache } from './cache/cache.js';
import { openDb } from './storage/sqlite/db.js';
import { compileCommandPolicy } from './commands/registry.js';
import { createPubSubBroker } from './pubsub/broker.js';

export { handleConnection, createEngine, openDb, createPubSubBroker };

function validateGroupInstances(instances) {
  if (!instances || typeof instances !== 'object' || Array.isArray(instances)) {
    throw new TypeError('RESPlite group instances must be a named object');
  }

  const entries = Object.entries(instances);
  if (entries.length === 0) {
    throw new TypeError('RESPlite group requires at least one instance');
  }

  const persistentDatabases = new Map();
  for (const [name, options] of entries) {
    if (!name) {
      throw new TypeError('RESPlite group instance names must not be empty');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError(`RESPlite group instance "${name}" must have an options object`);
    }

    const dbPath = options.db ?? ':memory:';
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new TypeError(`RESPlite group instance "${name}" must have a valid db path`);
    }
    if (dbPath === ':memory:') continue;

    const canonicalPath = path.resolve(dbPath);
    const existingName = persistentDatabases.get(canonicalPath);
    if (existingName) {
      throw new Error(
        `RESPlite group instances "${existingName}" and "${name}" cannot share SQLite database "${dbPath}"`
      );
    }
    persistentDatabases.set(canonicalPath, name);
  }

  return entries;
}

async function closeGroupServers(entries) {
  const results = await Promise.allSettled(
    entries.map(async ([, server]) => server.close())
  );

  return results.flatMap((result, index) => (
    result.status === 'rejected'
      ? [{ name: entries[index][0], reason: result.reason }]
      : []
  ));
}

/**
 * Optional event hooks for observability (e.g. logging unknown commands or errors).
 * All hooks are optional. Called with plain objects; do not mutate.
 *
 * @typedef {object} RESPliteHooks
 * @property {(payload: { command: string, argsCount: number, argv: string[], clientAddress: string, connectionId: number }) => void} [onUnknownCommand] Invoked when the client sends a command not implemented by RESPLite. `argv` is the full command line as strings (e.g. `['CLIENT','LIST']`) for logging.
 * @property {(payload: { command: string, error: string, argv: string[], clientAddress: string, connectionId: number }) => void} [onCommandError] Invoked when a command handler throws or returns an error (e.g. WRONGTYPE, invalid args). `argv` is the full command line as strings for logging.
 * @property {(payload: { error: Error, clientAddress: string, connectionId: number }) => void} [onSocketError] Invoked when a connection socket emits an error (e.g. ECONNRESET).
 */

/**
 * Start an embedded RESPLite server.
 *
 * @param {object} [options]
 * @param {string} [options.db=':memory:']        SQLite file path, or ':memory:' for in-memory.
 * @param {string} [options.host='127.0.0.1']     Host to listen on.
 * @param {number} [options.port=0]               Port to listen on (0 = OS-assigned).
 * @param {string} [options.pragmaTemplate='default'] PRAGMA preset (default|performance|safety|minimal|none). Convention: this template is applied by default; no config needed.
 * @param {Record<string, string|number>} [options.pragma] Override specific pragmas only when needed (e.g. { synchronous: 'FULL' }). Applied after the template.
 * @param {false | {enabled?: boolean, maxEntries?: number, maxBytes?: number, maxHashFields?: number, maxHashBytes?: number, maxSetMembers?: number, maxSetBytes?: number, maxListItems?: number, maxListBytes?: number, maxZsetMembers?: number, maxZsetBytes?: number}} [options.cache] Hot data cache configuration, or false to disable it.
 * @param {RESPliteHooks} [options.hooks]         Optional event hooks for observability (onUnknownCommand, onCommandError, onSocketError).
 * @param {boolean} [options.gracefulShutdown=true] If true, register SIGTERM/SIGINT to call close(). Set false if you handle shutdown yourself to avoid double handlers.
 * @param {{ rename?: Record<string, string>, disabled?: string[] } | null} [options.commandPolicy] Optional: rename/disable commands for hardening.
 * @returns {Promise<{ port: number, host: string, close: () => Promise<void> }>}
 */
export async function createRESPlite({
  db: dbPath = ':memory:',
  host = '127.0.0.1',
  port = 0,
  pragmaTemplate = 'default',
  pragma,
  cache: cacheOptions,
  hooks = {},
  gracefulShutdown = true,
  commandPolicy = null,
} = {}) {
  const compiledCommandPolicy = compileCommandPolicy(commandPolicy);
  const db = openDb(dbPath, { pragmaTemplate, pragma });
  const cache = cacheOptions === false
    ? createCache({ enabled: false })
    : createCache({ enabled: true, ...(cacheOptions ?? {}) });
  const engine = createEngine({ db, cache });
  const pubSub = createPubSubBroker();
  const connections = new Set();

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    handleConnection(socket, engine, hooks, compiledCommandPolicy, { pubSub });
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Failed to start RESPlite and close its database'
      );
    }
    throw error;
  }

  let closePromise = null;
  let onSignal = null;

  const removeSignalHandlers = () => {
    if (!onSignal) return;
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    onSignal = null;
  };

  const close = () => {
    if (closePromise) return closePromise;
    removeSignalHandlers();
    closePromise = new Promise((resolve, reject) => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          db.close();
          resolve();
        } catch (closeError) {
          reject(closeError);
        }
      });
    });
    return closePromise;
  };

  if (gracefulShutdown) {
    onSignal = () => {
      close().then(() => process.exit(0));
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  return {
    port: server.address().port,
    host,
    close,
  };
}

/**
 * Start and manage a named group of independent embedded RESPLite servers.
 * The group owns one pair of process signal handlers and rolls back servers
 * already started when a later instance fails.
 *
 * @param {Record<string, object>} instances Named createRESPlite option objects.
 * @param {object} [options]
 * @param {boolean} [options.gracefulShutdown=true] Register one SIGTERM/SIGINT handler for the group.
 * @returns {Promise<{ servers: Record<string, { port: number, host: string, close: () => Promise<void> }>, close: () => Promise<void> }>}
 */
export async function createRESPliteGroup(instances, {
  gracefulShutdown = true,
} = {}) {
  const instanceEntries = validateGroupInstances(instances);
  const startedEntries = [];

  try {
    for (const [name, options] of instanceEntries) {
      const server = await createRESPlite({
        ...options,
        gracefulShutdown: false,
      });
      startedEntries.push([name, server]);
    }
  } catch (error) {
    const rollbackFailures = await closeGroupServers(startedEntries);
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures.map(({ reason }) => reason)],
        `Failed to start RESPlite group and roll back: ${rollbackFailures.map(({ name }) => name).join(', ')}`
      );
    }
    throw error;
  }

  let closePromise = null;
  let onSignal = null;

  const removeSignalHandlers = () => {
    if (!onSignal) return;
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    onSignal = null;
  };

  const close = () => {
    if (closePromise) return closePromise;
    removeSignalHandlers();
    closePromise = (async () => {
      const failures = await closeGroupServers(startedEntries);
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(({ reason }) => reason),
          `Failed to close RESPlite group instances: ${failures.map(({ name }) => name).join(', ')}`
        );
      }
    })();
    return closePromise;
  };

  if (gracefulShutdown) {
    onSignal = () => {
      close().catch((error) => {
        process.exitCode = 1;
        process.emitWarning(error);
      });
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  return {
    servers: Object.fromEntries(startedEntries),
    close,
  };
}
