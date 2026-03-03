/**
 * Public API for embedding RESPLite in your own Node.js application.
 *
 * High-level (recommended):
 *   import { createRESPlite } from 'resplite/embed';
 *   const srv = await createRESPlite({ db: './my-app.db' });
 *
 * Low-level (manual wiring):
 *   import { handleConnection, createEngine, openDb } from 'resplite/embed';
 */

import net from 'node:net';
import { handleConnection } from './server/connection.js';
import { createEngine } from './engine/engine.js';
import { openDb } from './storage/sqlite/db.js';

export { handleConnection, createEngine, openDb };

/**
 * Start an embedded RESPLite server.
 *
 * @param {object} [options]
 * @param {string} [options.db=':memory:']        SQLite file path, or ':memory:' for in-memory.
 * @param {string} [options.host='127.0.0.1']     Host to listen on.
 * @param {number} [options.port=0]               Port to listen on (0 = OS-assigned).
 * @param {string} [options.pragmaTemplate='default'] PRAGMA preset (default|performance|safety|minimal|none).
 * @returns {Promise<{ port: number, host: string, close: () => Promise<void> }>}
 */
export async function createRESPlite({
  db: dbPath = ':memory:',
  host = '127.0.0.1',
  port = 0,
  pragmaTemplate = 'default',
} = {}) {
  const db = openDb(dbPath, { pragmaTemplate });
  const engine = createEngine({ db });
  const server = net.createServer((socket) => handleConnection(socket, engine));
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: server.address().port,
    host,
    close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}
