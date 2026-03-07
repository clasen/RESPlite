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
 * @param {string} [options.pragmaTemplate='default'] PRAGMA preset (default|performance|safety|minimal|none).
 * @param {RESPliteHooks} [options.hooks]         Optional event hooks for observability (onUnknownCommand, onCommandError, onSocketError).
 * @param {boolean} [options.gracefulShutdown=true] If true, register SIGTERM/SIGINT to call close(). Set false if you handle shutdown yourself to avoid double handlers.
 * @returns {Promise<{ port: number, host: string, close: () => Promise<void> }>}
 */
export async function createRESPlite({
  db: dbPath = ':memory:',
  host = '127.0.0.1',
  port = 0,
  pragmaTemplate = 'default',
  hooks = {},
  gracefulShutdown = true,
} = {}) {
  const db = openDb(dbPath, { pragmaTemplate });
  const engine = createEngine({ db });
  const connections = new Set();

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    handleConnection(socket, engine, hooks);
  });
  await new Promise((resolve) => server.listen(port, host, resolve));

  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve) => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      server.close(() => {
        db.close();
        resolve();
      });
    });
    return closePromise;
  };

  if (gracefulShutdown) {
    const onSignal = () => {
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
