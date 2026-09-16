/**
 * RESPLite entry point. Start TCP server with SQLite backend.
 *
 * Can be run as CLI (node src/index.js) or used programmatically:
 *   import { startServer } from './src/index.js';
 *   startServer({ port: 6380, gracefulShutdown: false });
 */

import { createServer } from './server/tcp-server.js';
import { createEngine } from './engine/engine.js';
import { createExpirationSweeper } from './engine/expiration.js';
import { createCache } from './cache/cache.js';
import { openDb } from './storage/sqlite/db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data.db');
const DEFAULT_PORT = 6379;

/**
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string} [options.dbPath]
 * @param {string} [options.pragmaTemplate]
 * @param {Record<string, string|number>} [options.pragma] Override specific pragmas when needed (e.g. { synchronous: 'FULL' }). Convention: template is applied by default.
 * @param {false | {enabled?: boolean, maxEntries?: number, maxBytes?: number, maxHashFields?: number, maxHashBytes?: number, maxSetMembers?: number, maxSetBytes?: number, maxListItems?: number, maxListBytes?: number, maxZsetMembers?: number, maxZsetBytes?: number}} [options.cache] Hot data cache configuration, or false to disable it.
 * @param {boolean} [options.gracefulShutdown=true] If true, register SIGTERM/SIGINT to close server and DB. Set false if you handle shutdown yourself.
 * @param {{ rename?: Record<string, string>, disabled?: string[] } | null} [options.commandPolicy] Optional: rename/disable commands for hardening.
 * @param {object} [options.scripting] Prepared plugin from resplite/scripting.
 */
export function startServer(options = {}) {
  const scripting = options.scripting ?? null;
  const scriptingOwner = {};
  scripting?.attach(scriptingOwner);
  const dbPath = options.dbPath ?? process.env.RESPLITE_DB ?? DEFAULT_DB_PATH;
  const port = options.port ?? parseInt(process.env.RESPLITE_PORT || String(DEFAULT_PORT), 10);
  const pragmaTemplate = options.pragmaTemplate ?? process.env.RESPLITE_PRAGMA_TEMPLATE ?? 'default';
  const gracefulShutdown = options.gracefulShutdown !== false;

  let db;
  let sweeper;
  let server;
  const connections = new Set();
  try {
    db = openDb(dbPath, { pragmaTemplate, pragma: options.pragma });
    const cache = options.cache === false
      ? createCache({ enabled: false })
      : createCache({ enabled: true, ...(options.cache ?? {}) });
    const engine = createEngine({ db, cache });
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
  let onSignal = null;
  let released = false;
  function release() {
    if (released) return;
    released = true;
    if (onSignal) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
    sweeper.stop();
    scripting?.close();
    db.close();
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
      console.log(`RESPLite listening on port ${server.address().port}, db: ${dbPath}`);
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
