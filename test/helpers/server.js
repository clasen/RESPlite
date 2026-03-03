/**
 * Start server on ephemeral port for integration tests.
 * Tracks connections so closeAsync() can destroy them and allow the process to exit.
 */

import net from 'node:net';
import { handleConnection } from '../../src/server/connection.js';
import { createEngine } from '../../src/engine/engine.js';
import { openDb } from '../../src/storage/sqlite/db.js';
import { tmpDbPath } from './tmp.js';

export function createTestServer(options = {}) {
  const dbPath = options.dbPath || tmpDbPath();
  const db = openDb(dbPath);
  const engine = createEngine({ db });
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    handleConnection(socket, engine);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        engine,
        db,
        port,
        dbPath,
        /** Close server and all connections so the process can exit. */
        async closeAsync() {
          for (const s of connections) s.destroy();
          connections.clear();
          await new Promise((res) => server.close(res));
        },
      });
    });
    server.on('error', reject);
  });
}
