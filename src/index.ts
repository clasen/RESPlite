/**
 * RESPLite entry point. Start TCP server with SQLite backend.
 *
 * Can be run as CLI (node src/index.ts) or used programmatically:
 *   import { startServer } from 'resplite';
 *   startServer({ port: 6380, gracefulShutdown: false });
 */

import { createServer } from './server/tcp-server.ts';
import { createEngine } from './engine/engine.ts';
import { createExpirationSweeper } from './engine/expiration.ts';
import { createCache } from './cache/cache.ts';
import { openDb } from './storage/sqlite/db.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo, Server, Socket } from 'node:net';
import type Database from './storage/sqlite/driver.ts';
import type { ExpirationSweeper } from './engine/expiration.ts';
import type { CacheOptions } from './cache/cache.ts';
import type { SearchOptions } from './storage/sqlite/search.ts';
import type { CommandPolicy } from './commands/registry.ts';
import type { ScriptingPlugin } from './scripting/plugin.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data.db');
const DEFAULT_PORT = 6379;

/** Options of {@link startServer}. */
export interface StartServerOptions {
  port?: number;
  dbPath?: string;
  pragmaTemplate?: string;
  /** Override specific pragmas when needed (e.g. { synchronous: 'FULL' }). Convention: template is applied by default. */
  pragma?: Record<string, string | number>;
  /** Hot data cache configuration, or false to disable it. */
  cache?: false | CacheOptions;
  /** FT.SEARCH guards: minPrefix, maxResults, timeoutMs. */
  search?: SearchOptions;
  /** If true, register SIGTERM/SIGINT to close server and DB. Set false if you handle shutdown yourself. Default true. */
  gracefulShutdown?: boolean;
  /** Optional: rename/disable commands for hardening. */
  commandPolicy?: CommandPolicy | null;
  /** Prepared plugin from resplite/scripting. */
  scripting?: ScriptingPlugin | null;
}

export function startServer(options: StartServerOptions = {}): void {
  const scripting = options.scripting ?? null;
  const scriptingOwner = {};
  scripting?.attach(scriptingOwner);
  const dbPath = options.dbPath ?? process.env.RESPLITE_DB ?? DEFAULT_DB_PATH;
  const port = options.port ?? parseInt(process.env.RESPLITE_PORT || String(DEFAULT_PORT), 10);
  const pragmaTemplate = options.pragmaTemplate ?? process.env.RESPLITE_PRAGMA_TEMPLATE ?? 'default';
  const gracefulShutdown = options.gracefulShutdown !== false;

  let db: Database | undefined;
  let sweeper: ExpirationSweeper | undefined;
  let server: Server | undefined;
  const connections = new Set<Socket>();
  try {
    db = openDb(dbPath, { pragmaTemplate, pragma: options.pragma });
    const cache = options.cache === false
      ? createCache({ enabled: false })
      : createCache({ enabled: true, ...(options.cache ?? {}) });
    const engine = createEngine({ db, cache, search: options.search });
    sweeper = createExpirationSweeper({
      db,
      clock: () => Date.now(),
      sweepIntervalMs: 1000,
      maxKeysPerSweep: 500,
    });
    sweeper.start();

    server = createServer({ engine, port, connections, commandPolicy: options.commandPolicy ?? null, scripting, scriptingOwner });
  } catch (error) {
    sweeper?.stop();
    db?.close();
    scripting?.close();
    throw error;
  }
  let onSignal: (() => void) | null = null;
  let released = false;
  function release() {
    if (released) return;
    released = true;
    if (onSignal) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
    sweeper!.stop();
    scripting?.close();
    db!.close();
  }
  server.once('close', release);
  server.once('error', (error) => {
    release();
    throw error;
  });

  if (gracefulShutdown) {
    let shuttingDown = false;
    onSignal = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      sweeper.stop();
      for (const socket of connections) socket.destroy();
      connections.clear();
      server.close(() => {
        process.exit(0);
      });
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  try {
    server.listen(port, () => {
      console.log(`RESPLite listening on port ${(server.address() as AddressInfo).port}, db: ${dbPath}`);
    });
  } catch (error) {
    release();
    throw error;
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const noGraceful = process.argv.includes('--no-graceful-shutdown');
  startServer({ gracefulShutdown: !noGraceful });
}
