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
 *   const stats = createServerStats(); // share across every connection of this server (INFO counters)
 *   handleConnection(socket, engine, hooks, commandPolicy, { pubSub, stats });
 */

import net from 'node:net';
import path from 'node:path';
import { handleConnection } from './server/connection.ts';
import { createEngine } from './engine/engine.ts';
import { createCache } from './cache/cache.ts';
import { openDb } from './storage/sqlite/db.ts';
import { compileCommandPolicy } from './commands/registry.ts';
import { createPubSubBroker } from './pubsub/broker.ts';
import { createServerStats } from './server/stats.ts';
import type { AddressInfo, Server, Socket } from 'node:net';
import type Database from './storage/sqlite/driver.ts';
import type { CacheOptions } from './cache/cache.ts';
import type { SearchOptions } from './storage/sqlite/search.ts';
import type { CommandPolicy } from './commands/registry.ts';
import type { ScriptingPlugin } from './scripting/plugin.ts';
import type { CommandEvent, ConnectionHooks } from './types.ts';
import type { ConnectionServices } from './server/connection.ts';

export { handleConnection, createEngine, openDb, createPubSubBroker, createServerStats };
export type { ConnectionServices };

function validateGroupInstances(instances: Record<string, CreateRESPliteOptions>): [string, CreateRESPliteOptions][] {
  if (!instances || typeof instances !== 'object' || Array.isArray(instances)) {
    throw new TypeError('RESPlite group instances must be a named object');
  }

  const entries = Object.entries(instances);
  if (entries.length === 0) {
    throw new TypeError('RESPlite group requires at least one instance');
  }

  const persistentDatabases = new Map<string, string>();
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

async function closeGroupServers(entries: [string, RESPliteServer][]): Promise<{ name: string; reason: unknown }[]> {
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
 */
export interface RESPliteHooks extends ConnectionHooks {
  /** Invoked when the client sends a command not implemented by RESPLite. `argv` is the full command line as strings (e.g. `['CLIENT','LIST']`) for logging. */
  onUnknownCommand?: (payload: CommandEvent) => void;
  /** Invoked when a command handler throws or returns an error (e.g. WRONGTYPE, invalid args). `argv` is the full command line as strings for logging. */
  onCommandError?: (payload: CommandEvent) => void;
  /** Invoked when a connection socket emits an error (e.g. ECONNRESET). */
  onSocketError?: (payload: { error: Error; clientAddress: string; connectionId: number }) => void;
}

/** Options of {@link createRESPlite}. */
export interface CreateRESPliteOptions {
  /** SQLite file path, or ':memory:' for in-memory. Default ':memory:'. */
  db?: string;
  /** Host to listen on. Default '127.0.0.1'. */
  host?: string;
  /** Port to listen on (0 = OS-assigned). Default 0. */
  port?: number;
  /** PRAGMA preset (default|performance|safety|minimal|none). Convention: this template is applied by default; no config needed. Default 'default'. */
  pragmaTemplate?: string;
  /** Override specific pragmas only when needed (e.g. { synchronous: 'FULL' }). Applied after the template. */
  pragma?: Record<string, string | number>;
  /** Hot data cache configuration, or false to disable it. */
  cache?: false | CacheOptions;
  /** FT.SEARCH guards: minPrefix, maxResults, timeoutMs. */
  search?: SearchOptions;
  /** Optional event hooks for observability (onUnknownCommand, onCommandError, onSocketError). */
  hooks?: RESPliteHooks;
  /** If true, register SIGTERM/SIGINT to call close(). Set false if you handle shutdown yourself to avoid double handlers. Default true. */
  gracefulShutdown?: boolean;
  /** Optional: rename/disable commands for hardening. */
  commandPolicy?: CommandPolicy | null;
  /** Prepared plugin from resplite/scripting; owned and closed by this server. */
  scripting?: ScriptingPlugin | null;
}

/** A running embedded RESPLite server. */
export interface RESPliteServer {
  port: number;
  host: string;
  close: () => Promise<void>;
}

/** Options of {@link createRESPliteGroup}. */
export interface CreateRESPliteGroupOptions {
  /** Register one SIGTERM/SIGINT handler for the group. Default true. */
  gracefulShutdown?: boolean;
}

/** A running group of named embedded RESPLite servers. */
export interface RESPliteGroup {
  servers: Record<string, RESPliteServer>;
  close: () => Promise<void>;
}

/**
 * Start an embedded RESPLite server.
 */
export async function createRESPlite({
  db: dbPath = ':memory:',
  host = '127.0.0.1',
  port = 0,
  pragmaTemplate = 'default',
  pragma,
  cache: cacheOptions,
  search,
  hooks = {},
  gracefulShutdown = true,
  commandPolicy = null,
  scripting = null,
}: CreateRESPliteOptions = {}): Promise<RESPliteServer> {
  const scriptingOwner = {};
  scripting?.attach(scriptingOwner);
  let db: Database | undefined;
  let server: Server | undefined;
  const connections = new Set<Socket>();
  try {
    const compiledCommandPolicy = compileCommandPolicy(commandPolicy);
    db = openDb(dbPath, { pragmaTemplate, pragma });
    const cache = cacheOptions === false
      ? createCache({ enabled: false })
      : createCache({ enabled: true, ...(cacheOptions ?? {}) });
    const engine = createEngine({ db, cache, search });
    const pubSub = createPubSubBroker();
    const stats = createServerStats();
    server = net.createServer((socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      handleConnection(socket, engine, hooks, compiledCommandPolicy, { pubSub, scripting, scriptingOwner, stats });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server!.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server!.off('error', onError);
        resolve();
      };

      server!.once('error', onError);
      server!.once('listening', onListening);
      server!.listen(port, host);
    });
  } catch (error) {
    scripting?.close();
    try {
      db?.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Failed to start RESPlite and close its database'
      );
    }
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  let onSignal: (() => void) | null = null;

  const removeSignalHandlers = () => {
    if (!onSignal) return;
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    onSignal = null;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    removeSignalHandlers();
    closePromise = new Promise<void>((resolve, reject) => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      server.close((error) => {
        scripting?.close();
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
    port: (server.address() as AddressInfo).port,
    host,
    close,
  };
}

/**
 * Start and manage a named group of independent embedded RESPLite servers.
 * The group owns one pair of process signal handlers and rolls back servers
 * already started when a later instance fails.
 *
 * @param instances - Named createRESPlite option objects.
 */
export async function createRESPliteGroup(instances: Record<string, CreateRESPliteOptions>, {
  gracefulShutdown = true,
}: CreateRESPliteGroupOptions = {}): Promise<RESPliteGroup> {
  const instanceEntries = validateGroupInstances(instances);
  const startedEntries: [string, RESPliteServer][] = [];

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

  let closePromise: Promise<void> | null = null;
  let onSignal: (() => void) | null = null;

  const removeSignalHandlers = () => {
    if (!onSignal) return;
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    onSignal = null;
  };

  const close = (): Promise<void> => {
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
