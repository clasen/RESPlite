/**
 * RESPLite entry point. Start TCP server with SQLite backend.
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

const dbPath = process.env.RESPLITE_DB || DEFAULT_DB_PATH;
const port = parseInt(process.env.RESPLITE_PORT || String(DEFAULT_PORT), 10);
const pragmaTemplate = process.env.RESPLITE_PRAGMA_TEMPLATE || 'default';

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

const server = createServer({ engine, port });

server.listen(port, () => {
  console.log(`RESPLite listening on port ${port}, db: ${dbPath}`);
});
