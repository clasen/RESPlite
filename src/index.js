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
 * @param {boolean} [options.gracefulShutdown=true] If true, register SIGTERM/SIGINT to close server and DB. Set false if you handle shutdown yourself.
 */
export function startServer(options = {}) {
  const dbPath = options.dbPath ?? process.env.RESPLITE_DB ?? DEFAULT_DB_PATH;
  const port = options.port ?? parseInt(process.env.RESPLITE_PORT || String(DEFAULT_PORT), 10);
  const pragmaTemplate = options.pragmaTemplate ?? process.env.RESPLITE_PRAGMA_TEMPLATE ?? 'default';
  const gracefulShutdown = options.gracefulShutdown !== false;

  const db = openDb(dbPath, { pragmaTemplate });
  const cache = createCache({ enabled: true });
  const engine = createEngine({ db, cache });
  const sweeper = createExpirationSweeper({
    db,
    clock: () => Date.now(),
    sweepIntervalMs: 1000,
    maxKeysPerSweep: 500,
  });
  sweeper.start();

  const connections = new Set();
  const server = createServer({ engine, port, connections });

  if (gracefulShutdown) {
    let shuttingDown = false;
    function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      sweeper.stop();
      for (const socket of connections) socket.destroy();
      connections.clear();
      server.close(() => {
        db.close();
        process.exit(0);
      });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  server.listen(port, () => {
    console.log(`RESPLite listening on port ${port}, db: ${dbPath}`);
  });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const noGraceful = process.argv.includes('--no-graceful-shutdown');
  startServer({ gracefulShutdown: !noGraceful });
}
